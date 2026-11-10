/**
 * 额度源「查询代码」执行器。
 *
 * 背景：全世界每个平台的用量接口都不一样——路径、鉴权头、字段名、单位、时间字段
 * 全无标准。与其为每个平台手写适配器，不如让模型按需写一小段查询代码，存进插件，
 * 之后由轮询引擎照常调用。
 *
 * 执行模型（用户已确认的取舍）：
 * - 代码跑在 node:vm 的新 realm 里，拿得到插件注入的 `http`（受 hosts 白名单约束）、
 *   `credential`、`plan`、`kit`、`now`、`console`。
 * - `http` 是本模块的桥：只允许访问该额度源登记的 hosts（含端口），强制超时、强制响应体积上限、
 *   逐跳校验重定向、跨域丢鉴权头、错误与日志统一抹密。
 * - **安全边界要如实说清**：vm 不是安全沙箱。注入的宿主函数会把宿主 realm 的对象带进沙箱，
 *   `arg.constructor.constructor('return process')()` 这类路径在受控实验里确实能拿到 process.env
 *   与 fs——`codeGeneration: { strings: false }` 只挡沙箱内部的 eval，不构成隔离。真正起作用的
 *   是这些东西：默认在**独立 worker 线程**里跑（死循环能 terminate，不卡宿主）、`env: {}`、
 *   stdout/stderr 走管道、`resourceLimits`、hosts 白名单、体积/时长上限，以及**保存前必须试跑
 *   并由用户看过代码**这一步人工确认。所以：查询代码按「用户自己（或他信任的模型）写的脚本」
 *   对待，不要拿它去跑来路不明的内容。
 * - 代码只读：不提供 fs / process / require，也不让它碰 store —— 这是**能力上不做**，不是**技术上做不到**。
 */

import vm from 'node:vm';
import { toIso, toNumber, safeText } from './util.js';

export const CUSTOM_PREFIX = 'custom:';
export const SOURCE_ID_RE = /^custom:[a-z0-9][a-z0-9_-]{1,39}$/;
export const MAX_CODE_CHARS = 20000;
export const MAX_WINDOWS = 24;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_SAMPLE_CHARS = 4000;
/** 跨越 worker 边界回传的 raw 上限（真正展示只用前几百字符）。 */
export const MAX_RAW_CHARS = 20000;
const COMPILE_TIMEOUT_MS = 2000;
const SECRET_MIN = 6;
const MAX_REDIRECTS = 3;

/** 错误信息里不保留 query（凭证常写在 ?key= 里）。 */
export function redactUrl(raw) {
  const text = String(raw || '');
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname}`;
  } catch {
    return text.split('?')[0];
  }
}

/** 把已知的凭证字面量从任意文本里抹掉（日志、样本、错误信息都不许漏）。 */
function scrub(text, secrets = []) {
  let out = String(text === undefined || text === null ? '' : text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= SECRET_MIN) out = out.split(secret).join('***');
  }
  return out;
}

/** 把 `custom:claude` / `custom:my-vendor` 这样的 id 规整好；不合法返回空串。 */
export function normalizeSourceId(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return '';
  const withPrefix = text.startsWith(CUSTOM_PREFIX) ? text : CUSTOM_PREFIX + text;
  if (!SOURCE_ID_RE.test(withPrefix)) return '';
  return withPrefix;
}

/** 从 id 里取出可读 slug（custom:cursor-pro → cursor-pro）。 */
export function sourceSlug(id) {
  return String(id || '').replace(CUSTOM_PREFIX, '');
}

/** hosts 允许写域名、URL、带通配符的后缀，可带端口。统一成小写 `host[:port]` 列表。 */
export function normalizeHosts(list) {
  const out = [];
  const push = (value) => {
    let text = String(value || '').trim().toLowerCase();
    if (!text) return;
    if (/^https?:\/\//.test(text)) {
      try {
        const url = new URL(text);
        text = url.port ? `${url.hostname}:${url.port}` : url.hostname;
      } catch {
        return;
      }
    }
    text = text.replace(/\/.*$/, '');
    if (!text) return;
    // 端口必须写清楚：不写端口等于只放行默认端口（80/443），避免「以为锁了端口其实没锁」
    if (!/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/.test(text)) return;
    if (!out.includes(text)) out.push(text);
  };
  if (Array.isArray(list)) list.forEach(push);
  else if (typeof list === 'string') list.split(/[,，\s]+/).forEach(push);
  return out;
}

const DEFAULT_PORTS = new Set([80, 443]);

/** 把 URL 压成白名单比较用的 `host[:port]`（默认端口不带）。 */
export function originKey(url) {
  const hostname = String(url?.hostname || '').toLowerCase();
  if (!hostname) return '';
  const port = url?.port ? String(url.port) : '';
  return port ? `${hostname}:${port}` : hostname;
}

/**
 * 白名单匹配：精确域名，或 `*.example.com` 后缀（含裸域 example.com）。
 *
 * `host` 可以带端口（`api.example.com:8443`）。规则不写端口时只放行默认端口，
 * 这样用户在 hosts 里写 `api.example.com` 不会意外放行同主机的任意端口。
 */
export function hostMatches(host, allowed) {
  const target = String(host || '').trim().toLowerCase();
  if (!target) return false;
  const [targetHost, targetPortRaw] = target.split(':');
  const targetPort = targetPortRaw ? Number(targetPortRaw) : null;
  return allowed.some((entry) => {
    const rule = String(entry || '').trim().toLowerCase();
    if (!rule) return false;
    const [ruleHostRaw, rulePortRaw] = rule.split(':');
    const rulePort = rulePortRaw ? Number(rulePortRaw) : null;
    if (rulePortRaw && !Number.isFinite(rulePort)) return false;
    if (rulePort !== null && rulePort !== targetPort) return false;
    if (rulePort === null && targetPort !== null && !DEFAULT_PORTS.has(targetPort)) return false;
    if (ruleHostRaw.startsWith('*.')) {
      const suffix = ruleHostRaw.slice(2);
      return targetHost === suffix || targetHost.endsWith('.' + suffix);
    }
    return targetHost === ruleHostRaw;
  });
}

/* --------------------------- http 桥 --------------------------- */

/**
 * 给沙箱用的网络能力：只放行白名单域名，带超时与体积上限。
 * 返回的对象会被注入进沙箱——这是本功能最需要谨慎的一处。
 */
export function createHttpBridge({ allowHosts = [], timeoutMs = 15000, maxBytes = MAX_RESPONSE_BYTES, fetchImpl, onRequest, secrets = [] } = {}) {
  const hosts = normalizeHosts(allowHosts);
  const hit = new Set();
  const doFetch = fetchImpl || globalThis.fetch;
  const state = { last: null };
  const limit = Math.max(1024, Number(maxBytes) || MAX_RESPONSE_BYTES);

  /** 跨域跳转时不把鉴权头（含用户凭证）带过去：白名单比黑名单可靠，只留必要的非鉴权头。 */
  function stripAuthHeaders(headers) {
    const SAFE = new Set(['accept', 'accept-language', 'content-type', 'user-agent']);
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!SAFE.has(String(key).toLowerCase())) continue;
      out[key] = value;
    }
    return out;
  }

  /** 边读边计数，超过上限立刻停止——绝不能先全读到内存再判大小。 */
  async function readLimited(response) {
    const declared = Number(response?.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      throw new Error(`响应太大（声明 ${declared} 字节 > 上限 ${limit}），已中止`);
    }
    const bodyStream = response?.body;
    if (!bodyStream || typeof bodyStream.getReader !== 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > limit) throw new Error(`响应太大（超过上限 ${limit} 字节），已中止`);
      return text;
    }
    const reader = bodyStream.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.byteLength || 0;
        if (total > limit) {
          try {
            await reader.cancel();
          } catch {
            /* 忽略取消失败 */
          }
          throw new Error(`响应太大（超过上限 ${limit} 字节），已中止`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* 忽略 */
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function request(input, maybeOptions) {
    const options = typeof input === 'string' ? { ...(maybeOptions || {}), url: input } : { ...(input || {}) };
    const rawUrl = String(options.url || '').trim();
    if (!rawUrl) throw new Error('http.request 缺少 url');
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`URL 格式不对：${redactUrl(rawUrl)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`只支持 http/https：${parsed.protocol}`);
    }
    if (!hosts.length) {
      throw new Error('这个额度源没有登记允许访问的域名（hosts 为空），不能发请求');
    }
    if (!hostMatches(originKey(parsed), hosts)) {
      throw new Error(`域名不在白名单里：${originKey(parsed)}（只允许 ${hosts.join(' / ')}）`);
    }
    if (typeof doFetch !== 'function') throw new Error('当前环境没有 fetch，无法查询');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 15000));
    timer.unref?.();
    try {
      const headers = {};
      for (const [key, value] of Object.entries(options.headers || {})) {
        if (value === undefined || value === null || value === '') continue;
        headers[String(key)] = String(value);
      }
      const method = String(options.method || (options.body ? 'POST' : 'GET')).toUpperCase();
      let body = options.body;
      if (body !== undefined && body !== null && typeof body !== 'string') body = JSON.stringify(body);
      if (method === 'GET' || method === 'HEAD') body = undefined;
      if (body && !Object.keys(headers).some((h) => /^content-type$/i.test(h))) {
        headers['Content-Type'] = 'application/json';
      }

      // 手动处理跳转：默认的 follow 会让白名单域名把请求（和鉴权头）带到任意地址（SSRF）。
      let current = parsed;
      let currentHeaders = { ...headers };
      let response = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (hop > 0 && originKey(current) !== originKey(parsed)) currentHeaders = stripAuthHeaders(currentHeaders);
        response = await doFetch(current.href, {
          method,
          headers: currentHeaders,
          body,
          signal: controller.signal,
          redirect: 'manual',
        });
        const status = Number(response?.status) || 0;
        const location = response?.headers?.get?.('location');
        if (status < 300 || status >= 400 || !location) break;
        if (hop === MAX_REDIRECTS) throw new Error(`跳转次数过多（>${MAX_REDIRECTS} 次），已中止`);
        let next;
        try {
          next = new URL(location, current.href);
        } catch {
          throw new Error('跳转地址不合法，已中止');
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error(`跳转到了不支持的协议：${next.protocol}，已中止`);
        }
        if (!hostMatches(originKey(next), hosts)) {
          throw new Error(`跳转到了白名单外的地址：${originKey(next)}，已中止`);
        }
        current = next;
      }

      const text = await readLimited(response);
      const wantJson = String(options.parse || 'json').toLowerCase() !== 'text';
      let json = null;
      if (wantJson) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      hit.add(originKey(current));
      onRequest?.({ url: redactUrl(current.href), status: response.status, ok: response.ok });
      state.last = { url: redactUrl(current.href), status: response.status, json, text: scrub(text, secrets) };
      return {
        url: response.url ? redactUrl(response.url) : redactUrl(current.href),
        status: response.status,
        ok: Boolean(response.ok),
        text,
        json,
      };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`请求超时（>${timeoutMs}ms）：${redactUrl(parsed.href)}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    request,
    get: (url, options) => request(url, { ...(options || {}), method: 'GET', body: undefined }),
    post: (url, body, options) => request(url, { ...(options || {}), method: 'POST', body }),
    hosts: () => Array.from(hit),
    allowedHosts: () => hosts.slice(),
    /** 最后一次请求的响应（调试/展示用） */
    last: () => state.last,
  };
}

/* --------------------------- 沙箱执行 --------------------------- */

function kit() {
  return {
    /** 数字兜底：取不到就给默认值 */
    num(value, fallback = null) {
      const n = toNumber(value, null);
      return n === null ? fallback : n;
    },
    /** 百分比：18 / 100 → 18（百分数），已是 0.18 就原样 */
    pct(value, total) {
      const v = toNumber(value, null);
      if (v === null) return null;
      const t = toNumber(total, null);
      if (t === null) return v <= 1 ? v * 100 : v;
      if (!t) return null;
      return (v / t) * 100;
    },
    /** 时间统一成 ISO 字符串；数字按秒/毫秒自动识别 */
    iso(value) {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value === 'number') {
        const ms = value < 1e12 ? value * 1000 : value;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      }
      return toIso(value) || null;
    },
    /** 按点路径取值：kit.get(json, 'data.usage.percent') */
    get(object, path) {
      if (!path) return object;
      return String(path)
        .split('.')
        .reduce((acc, key) => {
          if (acc === null || acc === undefined) return undefined;
          const match = /^([^[\]]*)\[(\d+)\]$/.exec(key);
          if (match) {
            const base = match[1] ? acc[match[1]] : acc;
            return Array.isArray(base) ? base[Number(match[2])] : undefined;
          }
          return acc[key];
        }, object);
    },
    /** 常用时间戳，省得在沙箱里算日期 */
    ms: {
      now: () => Date.now(),
      day: 24 * 60 * 60 * 1000,
    },
  };
}

function timeoutError(ms) {
  return new Error(`查询代码执行超时（>${ms}ms）`);
}

async function raceTimeout(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(message ? new Error(message) : timeoutError(ms)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** 把代码返回的东西规整成窗口数组（百分数 → 0~1 交给 store 再钳制）。 */
export function normalizeResultWindows(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.windows) ? raw.windows : null;
  if (!list) {
    throw new Error('查询代码必须返回窗口数组，例如 [{ key, label, used, limit, percent, resetAt }]');
  }
  if (!list.length) throw new Error('查询代码没有返回任何额度窗口');
  return list.slice(0, MAX_WINDOWS).map((item, index) => {
    const spec = item && typeof item === 'object' ? item : {};
    let percent = toNumber(spec.percent, null);
    // 有些接口报的是「剩余比例」：语义与 percent（已用）相反，必须换算，否则告警完全反向
    if (percent === null) {
      const rest = toNumber(spec.remainingPercent, null);
      if (rest !== null) {
        const asFraction = rest > 1 ? rest / 100 : rest;
        percent = 1 - Math.max(0, Math.min(1, asFraction));
      }
    }
    if (percent === null) {
      const used = toNumber(spec.used, null);
      const limit = toNumber(spec.limit, null);
      if (used !== null && limit) percent = used / limit;
    }
    // 1 是分界点：>1 当百分数，>100 直接钳到 100%，否则 150 会原样流进面板
    if (percent !== null && percent > 1) percent = percent > 100 ? 1 : percent / 100;
    if (percent !== null) percent = Math.max(0, Math.min(1, percent));
    return {
      key: safeText(spec.key || spec.id || `window_${index + 1}`, 40),
      label: safeText(spec.label || spec.name || spec.key || `额度 ${index + 1}`, 80),
      unit: safeText(spec.unit || 'percent', 20),
      limit: toNumber(spec.limit, null),
      used: toNumber(spec.used, null),
      remaining: toNumber(spec.remaining, null),
      percent,
      resetAt: spec.resetAt ? toIso(spec.resetAt) : null,
      level: spec.level || undefined,
    };
  });
}

/**
 * 在**当前线程**的 vm 里跑一段查询代码（测试与 worker 内部都走它）。
 * 返回 { windows, raw, logs, hosts, ms }。
 */
export async function runInVm(options = {}) {
  const code = String(options.code || '').trim();
  if (!code) throw new Error('查询代码为空');
  if (code.length > MAX_CODE_CHARS) throw new Error(`查询代码太长（>${MAX_CODE_CHARS} 字符）`);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 20000);
  const secrets = [options.credential].filter((value) => typeof value === 'string' && value.length >= SECRET_MIN);
  const logs = [];
  const lines = (level) => (...args) => {
    const text = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    // 日志同样要抹密：既抹配置凭证的字面量，也抹掉文本里顺带出现的 access_token/session 之类
    if (logs.length < 40) logs.push(`[${level}] ${scrubInlineSecrets(scrub(safeText(text, 300), secrets))}`);
  };
  const http = createHttpBridge({
    allowHosts: options.allowHosts || [],
    timeoutMs,
    fetchImpl: options.fetchImpl,
    secrets,
  });
  const helpers = kit();
  const sandbox = {
    http,
    credential: options.credential || '',
    plan: {
      id: options.plan?.id || '',
      name: options.plan?.name || '',
      sourceId: options.plan?.sourceId || '',
      planLabel: options.plan?.planLabel || '',
      provider: options.plan?.provider || '',
    },
    kit: helpers,
    now: Date.now(),
    console: { log: lines('log'), warn: lines('warn'), error: lines('error'), info: lines('log'), debug: lines('log') },
  };
  // codeGeneration:false 挡掉沙箱里的 eval / new Function（纵深防御；真正的隔离靠 worker）
  const context = vm.createContext(sandbox, {
    name: 'butler-quota-source',
    codeGeneration: { strings: false, wasm: false },
  });

  let fn;
  try {
    fn = vm.runInContext(`(${code})`, context, { timeout: COMPILE_TIMEOUT_MS, displayErrors: true });
  } catch (error) {
    const message = String(error?.message || error).split('\n')[0];
    throw new Error(`查询代码有语法错误：${message}`);
  }
  if (typeof fn !== 'function') {
    throw new Error('查询代码必须是一个函数，例如 async ({ http, credential, kit }) => [ ... ]');
  }

  const startedAt = Date.now();
  let result;
  try {
    result = await raceTimeout(fn(sandbox), timeoutMs);
  } catch (error) {
    if (error?.message?.includes('执行超时')) throw error;
    // 平台 401 的 body 常会把 key 回显出来（"Incorrect API key provided: sk-..."），
    // 这条错误会进 plans[].error、宿主日志和模型上下文，所以必须抹一遍。
    const message = scrubInlineSecrets(scrub(String(error?.message || error), secrets));
    throw new Error(`查询代码执行失败：${message}`);
  }
  const windows = normalizeResultWindows(result);
  const explicitRaw = Array.isArray(result) ? null : result?.raw ?? null;
  const last = http.last?.() || null;
  const raw = explicitRaw ?? last?.json ?? last?.text ?? null;
  return {
    windows,
    raw,
    logs,
    hosts: http.hosts(),
    allowedHosts: http.allowedHosts(),
    request: last ? { url: last.url, status: last.status } : null,
    ms: Date.now() - startedAt,
  };
}

/* --------------------------- 线程外执行（防死循环拖死宿主） --------------------------- */

let workerSupport = null;
async function loadWorkerSupport() {
  if (workerSupport !== null) return workerSupport;
  try {
    const mod = await import('node:worker_threads');
    workerSupport = typeof mod?.Worker === 'function' ? mod.Worker : false;
  } catch {
    workerSupport = false;
  }
  return workerSupport;
}

function trimForTransport(value, maxChars = MAX_RAW_CHARS) {
  if (typeof value === 'string') {
    return value.length > maxChars ? value.slice(0, maxChars) : value;
  }
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text.length <= maxChars) return value;
      return `${text.slice(0, maxChars)}…`;
    } catch {
      return null;
    }
  }
  return value ?? null;
}

/**
 * 跑一段查询代码（对外入口）。
 *
 * - 传了 `fetchImpl`（测试用）→ 直接在**当前线程**跑，便于注入假 fetch。
 * - 否则优先交给 worker 线程：模型写的代码里若有死循环（尤其在 await 之后），
 *   vm 自己的 timeout 拦不住，会直接卡死宿主；worker 可以在超时后 terminate。
 * - worker 不可用时退回当前线程，行为与旧版一致。
 */
export async function runSourceCode(options = {}) {
  // 测试/调试：注入了假 fetch，或显式要求留在当前线程
  if (options.fetchImpl || process.env.BUTLER_SOURCE_INPROCESS === '1') return runInVm(options);
  const Worker = await loadWorkerSupport();
  if (!Worker) return runInVm(options);

  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 20000);
  const payload = {
    code: String(options.code || ''),
    credential: String(options.credential || ''),
    plan: options.plan || null,
    allowHosts: options.allowHosts || [],
    timeoutMs,
  };

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./source-worker.js', import.meta.url), {
        workerData: payload,
        // 不放行任何环境变量：模型写的代码本来就不该看见宿主的 env
        env: {},
        // stdout/stderr 用管道接住（默认是继承宿主，逃逸代码可以直接往宿主终端写）
        stdout: true,
        stderr: true,
        // 内存上限：让写坏的死循环先撞到堆上限，而不是把整机拖进 swap
        resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 },
      });
    } catch {
      resolve(runInVm(options));
      return;
    }
    try {
      worker.stdout?.resume?.();
      worker.stderr?.resume?.();
    } catch {
      /* 忽略 */
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        worker.terminate?.();
      } catch {
        /* 忽略 */
      }
      fn(value);
    };
    // 比内部超时再宽一点：让 worker 自己先报「执行超时」这种更准确的信息
    const timer = setTimeout(() => {
      finish(reject, new Error(`查询代码执行超时（>${timeoutMs}ms），已强制停止`));
    }, timeoutMs + 3000);
    timer.unref?.();
    worker.once('message', (message) => {
      if (!message || typeof message !== 'object') {
        finish(reject, new Error('查询代码没有返回结果'));
        return;
      }
      if (message.ok) finish(resolve, { ...message.out, raw: trimForTransport(message.out?.raw) });
      else finish(reject, new Error(scrubInlineSecrets(String(message.error || '查询代码执行失败'))));
    });
    worker.once('error', (error) => finish(reject, new Error(`查询代码执行失败：${scrubInlineSecrets(String(error?.message || error))}`)));
    worker.once('exit', (code) => {
      if (!settled) finish(reject, new Error(`查询代码提前结束（exit ${code}）`));
    });
  });
}

/* --------------------------- 敏感信息处理 --------------------------- */

const SECRET_KEY_RE = /token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|session/i;

/** 文本里 `access_token: xxx` / `"api_key": "xxx"` 这类内联键值也要抹掉（字符串形态没法按 key 遍历）。 */
export function scrubInlineSecrets(text) {
  return String(text)
    // `Authorization: Bearer xxx` —— 中间多一层认证方案名，不处理就会把 token 原样留下
    .replace(
      /((?:token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|session)[\w-]*"?\s*[:=]\s*"?)(?:(?:bearer|basic|token|bot|digest|negotiate|apikey)\s+)?([^\s,;}"'&]{4,})/gi,
      (_match, prefix) => `${prefix}***`,
    )
    // 没有键名、只有 `Bearer xxx` 形态的也要抹
    .replace(/\b(bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_match, scheme) => `${scheme} ***`);
}

/** 把凭证从任何要展示给用户的样本里抹掉（值 + 键名双重判定）。 */
export function redactSecrets(value, secrets = [], depth = 0) {
  if (depth > 8) return '[deep]';
  const secretList = secrets.filter((secret) => typeof secret === 'string' && secret.length >= SECRET_MIN);
  const scrubString = (text) => {
    let out = text;
    for (const secret of secretList) out = out.split(secret).join('***');
    return out;
  };
  if (typeof value === 'string') return scrubString(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactSecrets(item, secrets, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 60)) {
      if (SECRET_KEY_RE.test(key) && (typeof item === 'string' || typeof item === 'number')) {
        out[key] = '***';
      } else {
        out[key] = redactSecrets(item, secrets, depth + 1);
      }
    }
    return out;
  }
  return scrubString(String(value));
}

/** 供工具/面板展示的响应样本：抹密 + 截断。 */
export function sampleOf(value, secrets = [], maxChars = MAX_SAMPLE_CHARS) {
  if (value === null || value === undefined) return '';
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(redactSecrets(value, secrets), null, 2);
  } catch {
    text = String(value);
  }
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= SECRET_MIN) text = text.split(secret).join('***');
  }
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…（已截断，共 ${text.length} 字符）`;
}

/** 保存前的基本校验：id、hosts、代码能不能编译。 */
export function inspectSourceDraft(input = {}) {
  const code = String(input.code || '').trim();
  const hosts = normalizeHosts(input.hosts);
  const problems = [];
  if (!code) problems.push('缺少查询代码');
  else if (code.length > MAX_CODE_CHARS) problems.push(`查询代码太长（>${MAX_CODE_CHARS} 字符）`);
  if (!hosts.length) problems.push('缺少允许访问的域名（hosts），例如 ["api.cursor.com"]');
  if (code) {
    try {
      const probe = vm.createContext({});
      const value = vm.runInContext(`(${code})`, probe, { timeout: COMPILE_TIMEOUT_MS });
      if (typeof value !== 'function') problems.push('查询代码必须是一个函数');
    } catch (error) {
      problems.push('查询代码有语法错误：' + String(error?.message || error).split('\n')[0]);
    }
  }
  return { ok: problems.length === 0, problems, hosts, code };
}

export { kit as sourceKit };