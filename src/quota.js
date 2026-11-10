/**
 * 额度查询引擎。
 *
 * 两条硬约束（来自用户需求）：
 *  1. 30 秒刷新一次，但**绝不并发查询**——所有额度源串行、逐个查询，
 *     上一轮没结束就跳过本轮（单飞），避免把宿主机网络/CPU 打满。
 *  2. 查询凭证由用户提供，和 DSH 模型配置无关（见 credentials.js）。
 *
 * 额度源是开放注册表：
 *  - 内置 claude-usage / deepseek / openai / generic / manual；
 *  - config.quotaSources 里按 sourceId 覆盖（L1 声明式）；
 *  - `custom:*` 由模型写查询代码后存进 store.sources（L2 代码层，见 sources.js）——
 *    任何平台都能现学现用，不必为每个厂商手写适配器。
 */

import { nowIso, newId, toNumber, safeText, toIso } from './util.js';
import { normalizeWindow } from './store.js';
import { CUSTOM_PREFIX, redactUrl, runSourceCode, sampleOf, scrubInlineSecrets } from './sources.js';

const DEFAULTS = {
  timeoutMs: 15000,
};

/** 内置源拿到的响应体积上限：坏接口返回 1GB 不能把宿主内存打满。 */
const MAX_BUILTIN_BYTES = 2 * 1024 * 1024;

/* --------------------------- HTTP 小工具 --------------------------- */

async function readLimitedText(response, limit = MAX_BUILTIN_BYTES) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`响应太大（声明 ${declared} 字节），已中止`);
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) throw new Error(`响应太大（>${limit} 字节），已中止`);
    return text;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength || 0;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* 忽略 */ }
        throw new Error(`响应太大（>${limit} 字节），已中止`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 忽略 */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function getJson(url, { headers = {}, method = 'GET', body = null, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...headers },
      body,
      signal: controller.signal,
      // 内置源同样不接受自动跳转：配置写错/被劫持时，鉴权头不该跟着跳去别处
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`接口返回了跳转（${response.status}），请直接配置最终地址`);
    }
    const text = await readLimitedText(response);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? '（凭证无效或已过期：额度查询凭证需要你自己到官网获取，不是 DSH 的模型 key）'
        : '';
      const detail = json ? scrubInlineSecrets(JSON.stringify(json).slice(0, 200)) : '';
      throw new Error(`HTTP ${response.status} ${response.statusText}${hint}${detail ? ` ${detail}` : ''}`);
    }
    if (json === null) throw new Error('响应不是 JSON（可能是官网页面而非用量接口）');
    return json;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超时（>${timeoutMs}ms）：${redactUrl(url)}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 支持 `a.b[0].c` 形式的取值路径。 */
export function getPath(object, path) {
  if (!path || typeof path !== 'string') return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = object;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function fillTemplate(template, vars) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] === undefined ? '' : String(vars[key])));
}

function percentWindow(key, label, utilization, resetAt, unit = 'percent') {
  const u = Math.max(0, Math.min(1, toNumber(utilization, 0)));
  return normalizeWindow({
    key,
    label,
    unit,
    limit: 100,
    used: Math.round(u * 1000) / 10,
    remaining: Math.round((1 - u) * 1000) / 10,
    percent: u,
    resetAt: toIso(resetAt),
  });
}

/* --------------------------- 内置额度源 --------------------------- */

export const BUILTIN_SOURCES = {
  'claude-usage': {
    id: 'claude-usage',
    label: 'Claude 订阅用量（5h / 周 / Opus）',
    hosts: ['api.anthropic.com'],
    needsCredential: true,
    credentialHint: 'Claude Code 的 OAuth access token（官网 claude.ai 登录态里拿，不是 DSH 的模型 key）',
    async query({ credential, config }) {
      const sourceConfig = config.quotaSources?.['claude-usage'] || {};
      const url = sourceConfig.endpoint || 'https://api.anthropic.com/api/oauth/usage';
      const json = await getJson(url, {
        timeoutMs: config.quotaTimeoutMs,
        headers: {
          Authorization: `Bearer ${credential}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
      });
      const windows = [];
      if (json?.five_hour) windows.push(percentWindow('five_hour', '5 小时窗口', json.five_hour.utilization, json.five_hour.resets_at));
      if (json?.seven_day) windows.push(percentWindow('weekly', '周额度', json.seven_day.utilization, json.seven_day.resets_at));
      if (json?.seven_day_opus) windows.push(percentWindow('weekly_opus', '周额度（Opus）', json.seven_day_opus.utilization, json.seven_day_opus.resets_at));
      if (json?.seven_day_sonnet) windows.push(percentWindow('weekly_sonnet', '周额度（Sonnet）', json.seven_day_sonnet.utilization, json.seven_day_sonnet.resets_at));
      if (!windows.length) throw new Error('响应里找不到 five_hour / seven_day 字段，可能接口已变更');
      return { windows, raw: json };
    },
  },

  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek 平台余额',
    hosts: ['api.deepseek.com'],
    needsCredential: true,
    credentialHint: 'DeepSeek 开放平台的 API key（platform.deepseek.com，仅用于查余额）',
    async query({ credential, config }) {
      const sourceConfig = config.quotaSources?.deepseek || {};
      const url = sourceConfig.endpoint || 'https://api.deepseek.com/user/balance';
      const json = await getJson(url, {
        timeoutMs: config.quotaTimeoutMs,
        headers: { Authorization: `Bearer ${credential}` },
      });
      const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : [];
      if (!infos.length) throw new Error('响应里没有 balance_infos');
      const windows = infos.map((info) => normalizeWindow({
        key: 'balance',
        label: `账户余额（${info.currency || 'CNY'}）`,
        remaining: toNumber(info.total_balance, 0),
        unit: String(info.currency || '').toUpperCase() === 'USD' ? 'usd' : 'credits',
        limit: null,
        used: null,
        percent: null,
      }));
      return { windows, raw: json };
    },
  },

  openai: {
    id: 'openai',
    label: 'OpenAI 月度用量与预算',
    hosts: ['api.openai.com', 'platform.openai.com'],
    needsCredential: true,
    credentialHint: 'platform.openai.com 的会话 key（Dashboard → Billing 页面的 session key；普通 sk- API key 查不了用量）',
    async query({ credential, config }) {
      const headers = { Authorization: `Bearer ${credential}` };
      const timeoutMs = config.quotaTimeoutMs;
      const sub = await getJson('https://api.openai.com/v1/dashboard/billing/subscription', { headers, timeoutMs });
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const usage = await getJson(
        `https://api.openai.com/v1/dashboard/billing/usage?start_date=${fmt(start)}&end_date=${fmt(end)}`,
        { headers, timeoutMs },
      );
      const hardLimit = toNumber(sub?.hard_limit_usd, 0);
      const used = toNumber(usage?.total_usage, 0) / 100;
      const windows = [normalizeWindow({
        key: 'monthly',
        label: '本月用量',
        unit: 'usd',
        limit: hardLimit > 0 ? hardLimit : null,
        used,
        remaining: hardLimit > 0 ? Math.max(0, hardLimit - used) : null,
        percent: hardLimit > 0 ? used / hardLimit : null,
        resetAt: end.toISOString(),
      })];
      return { windows, raw: { subscription: sub, usage } };
    },
  },

  generic: {
    id: 'generic',
    label: '自定义用量接口（config.quotaSources 配置）',
    hosts: [],
    needsCredential: false,
    credentialHint: '取决于你的接口；留空表示不需要鉴权',
    async query({ credential, config, plan }) {
      const sourceId = plan.sourceId || 'generic';
      const sourceConfig = config.quotaSources?.[sourceId] || config.quotaSources?.generic;
      if (!sourceConfig || typeof sourceConfig !== 'object') {
        throw new Error(`没有配置额度源「${sourceId}」：请在插件配置 quotaSources.${sourceId} 里填写 baseUrl/path/mapping`);
      }
      const url = new URL(sourceConfig.path || sourceConfig.endpoint || '/', sourceConfig.baseUrl || undefined).toString();
      const headings = {};
      for (const [key, value] of Object.entries(sourceConfig.headers || {})) {
        headings[key] = fillTemplate(String(value), { credential: credential || '', planId: plan.id });
      }
      if (credential && !Object.keys(headings).some((k) => /authorization|api[-_]?key|x-api-key/i.test(k))) {
        headings.Authorization = `Bearer ${credential}`;
      }
      const json = await getJson(url, {
        headers: headings,
        method: String(sourceConfig.method || 'GET').toUpperCase(),
        timeoutMs: config.quotaTimeoutMs,
      });

      const mapping = sourceConfig.mapping || {};
      const list = Array.isArray(mapping.windows) ? mapping.windows : [];
      const windows = list.map((spec) => normalizeWindow({
        key: spec.key || spec.label || 'window',
        label: spec.label || spec.key || '额度',
        unit: spec.unit,
        limit: toNumber(getPath(json, spec.limit), null),
        used: toNumber(getPath(json, spec.used), null),
        remaining: toNumber(getPath(json, spec.remaining), null),
        percent: spec.percent !== undefined ? toNumber(getPath(json, spec.percent), null) : null,
        resetAt: toIso(getPath(json, spec.resetAt)),
      })).filter(Boolean);
      if (!windows.length) {
        throw new Error('mapping.windows 为空或取不到值：请检查 quotaSources 里的取值路径');
      }
      return { windows, raw: json };
    },
  },

  manual: {
    id: 'manual',
    label: '手动填写（不联网查询）',
    hosts: [],
    needsCredential: false,
    credentialHint: '不需要',
    async query() {
      return { windows: [], raw: null, manual: true };
    },
  },
};

export function resolveSource(sourceId, config, store) {
  const id = safeText(sourceId || 'generic', 60);

  // 模型写的额度源（代码存在 store 里）
  if (id.startsWith(CUSTOM_PREFIX) && store) {
    const record = store.find('sources', id) || store.list('sources').find((item) => item.id === id);
    if (record) return customSource(record, config);
    return {
      id,
      label: `已删除的额度源 ${id}`,
      needsCredential: false,
      credentialHint: '',
      async query() {
        throw new Error(`额度源 ${id} 不存在了（可能被删除），请重新建一个`);
      },
    };
  }

  const overrides = config.quotaSources?.[id];
  const base = BUILTIN_SOURCES[id];
  if (base) {
    const resolved = overrides && typeof overrides === 'object' && overrides.adapter === 'generic'
      ? { ...BUILTIN_SOURCES.generic, id, label: overrides.label || BUILTIN_SOURCES.generic.label }
      : { ...base };
    // 用户把接口地址改到别处时，登记域名也跟着变，否则「凭证只能去登记过的地方」这条会被绕开
    const custom = overrides?.endpoint || overrides?.baseUrl;
    if (custom) {
      try {
        const host = new URL(custom).hostname;
        if (host) resolved.hosts = [host];
      } catch {
        /* 配置里的地址不合法就保留默认 */
      }
    }
    return resolved;
  }
  // 未内置的 sourceId 一律当 generic 处理（用户自定义接口）
  const generic = { ...BUILTIN_SOURCES.generic, id, label: overrides?.label || `自定义额度源 ${id}` };
  const customUrl = overrides?.endpoint || overrides?.baseUrl;
  if (customUrl) {
    try {
      const host = new URL(customUrl).hostname;
      if (host) generic.hosts = [host];
    } catch {
      /* 忽略非法地址 */
    }
  }
  return generic;
}

/** 把一个 store 里额度源记录包装成和内置源同形的对象。 */
export function customSource(record, config) {
  return {
    id: record.id,
    label: record.label || record.id,
    needsCredential: record.needsCredential !== false,
    credentialHint: record.credentialHint || '',
    custom: true,
    hosts: record.hosts || [],
    async query({ credential, plan }) {
      const out = await runSourceCode({
        code: record.code,
        credential,
        plan: { ...plan, sourceId: record.id },
        allowHosts: record.hosts || [],
        timeoutMs: Math.max(3000, Number(config.quotaTimeoutMs) || 15000),
      });
      return {
        windows: out.windows,
        // 只留小体积诊断信息，避免把整个响应写进 plans 表
        raw: {
          source: record.id,
          hosts: out.hosts,
          logs: out.logs.slice(-8),
          ms: out.ms,
          sample: sampleOf(out.raw, [credential], 600),
        },
      };
    },
  };
}

/* --------------------------- 轮询引擎 --------------------------- */

export function createQuotaEngine({ store, config, credentials, logger, onChange }) {
  const state = { busy: false, lastTick: null, lastTickDurationMs: null, lastError: null, skipped: 0 };

  function planCredential(plan) {
    if (!plan.credentialRef) return undefined;
    return credentials.get(plan.credentialRef);
  }

  function markPlan(planId, patch) {
    return store.patch('plans', planId, patch);
  }

  async function queryPlan(plan) {
    const source = resolveSource(plan.sourceId, config, store);
    const credential = planCredential(plan);

    if (source.needsCredential && !credential) {
      markPlan(plan.id, { status: 'no-credential', error: '未配置额度查询凭证', updatedAt: nowIso() });
      return { status: 'no-credential' };
    }

    try {
      const result = await source.query({ credential, config, plan });
      if (result?.manual) {
        markPlan(plan.id, { status: 'ok', error: null, lastCheckedAt: nowIso(), updatedAt: nowIso() });
        return { status: 'manual' };
      }
      const windows = (result.windows || []).map(normalizeWindow).filter(Boolean);
      // 查询是异步的：这期间计划可能已经被删掉/换了来源，别给已删的计划写回数据与快照
      if (!store.find('plans', plan.id)) return { status: 'skipped' };
      markPlan(plan.id, {
        windows,
        status: 'ok',
        error: null,
        hasCredential: Boolean(credential),
        lastCheckedAt: nowIso(),
        raw: result.raw ?? null,
        updatedAt: nowIso(),
      });
      store.put('snapshots', {
        id: newId('snap'),
        planId: plan.id,
        at: nowIso(),
        windows,
      });
      return { status: 'ok', windows };
    } catch (error) {
      const message = safeText(error?.message || error, 400);
      markPlan(plan.id, { status: 'error', error: message, hasCredential: Boolean(credential), lastCheckedAt: nowIso(), updatedAt: nowIso() });
      logger?.warn?.(`[butler] 额度查询失败（${plan.name}）：${message}`);
      return { status: 'error', error: message };
    }
  }

  /**
   * 单飞轮询：同一时刻只有一轮在跑，绝不并发。
   * @param {{ planId?: string, force?: boolean }} options
   */
  async function tick(options = {}) {
    if (state.busy) {
      state.skipped += 1;
      return { status: 'busy' };
    }
    state.busy = true;
    const startedAt = Date.now();
    const results = [];
    try {
      const all = store.list('plans').filter((plan) => (options.planId ? plan.id === options.planId : true));
      for (const plan of all) {
        // 串行：一次只查一个源，查完再查下一个
        results.push({ planId: plan.id, name: plan.name, ...(await queryPlan(plan)) });
      }
      store.pruneSnapshots(config.maxSnapshots);
      state.lastTick = nowIso();
      state.lastError = results.find((r) => r.status === 'error')?.error || null;
      onChange?.({ reason: 'quota', results });
      return { status: 'ok', results };
    } catch (error) {
      state.lastError = String(error?.message || error);
      logger?.error?.('[butler] 额度轮询异常：' + state.lastError);
      return { status: 'error', error: state.lastError, results };
    } finally {
      state.busy = false;
      state.lastTickDurationMs = Date.now() - startedAt;
    }
  }

  return {
    tick,
    state: () => ({ ...state }),
    isBusy: () => state.busy,
    sources: () => [
      ...Object.values(BUILTIN_SOURCES).map((s) => ({
        id: s.id,
        label: s.label,
        needsCredential: Boolean(s.needsCredential),
        credentialHint: s.credentialHint,
        hosts: resolveSource(s.id, config, store).hosts || [],
        custom: false,
      })),
      ...store.list('sources').map((record) => ({
        id: record.id,
        label: record.label || record.id,
        needsCredential: record.needsCredential !== false,
        credentialHint: record.credentialHint || '',
        custom: true,
        vendor: record.vendor || '',
        hosts: record.hosts || [],
        lastTestOk: record.lastTestOk,
        lastTestAt: record.lastTestAt,
      })),
    ],
    resolveSource: (sourceId) => resolveSource(sourceId, config, store),
  };
}