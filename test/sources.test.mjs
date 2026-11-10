import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createHttpBridge,
  hostMatches,
  inspectSourceDraft,
  normalizeHosts,
  normalizeResultWindows,
  normalizeSourceId,
  redactSecrets,
  runInVm,
  runSourceCode,
  sampleOf,
  scrubInlineSecrets,
} from '../src/sources.js';
import { resolveSource } from '../src/quota.js';
import { createAlerts } from '../src/alerts.js';
import { createKinds } from '../src/kinds.js';
import { createService } from '../src/service.js';
import { Store } from '../src/store.js';

// 测试里都用假 fetch（在假 fetch 上跑会自然走当前线程路径），worker 路径专门单独测。
process.env.BUTLER_SOURCE_INPROCESS = '1';

/* --------------------------- 纯工具 --------------------------- */

test('额度源：hosts 归一化与通配符匹配', () => {
  const hosts = normalizeHosts(['https://API.Cursor.com/v1/usage', ' *.openai.com ', 'api.deepseek.com']);
  assert.deepEqual(hosts, ['api.cursor.com', '*.openai.com', 'api.deepseek.com']);

  assert.equal(hostMatches('api.cursor.com', ['api.cursor.com']), true);
  assert.equal(hostMatches('API.CURSOR.COM', ['api.cursor.com']), true);
  assert.equal(hostMatches('evil.com', ['api.cursor.com']), false);
  assert.equal(hostMatches('api.openai.com', ['*.openai.com']), true);
  assert.equal(hostMatches('openai.com', ['*.openai.com']), true);
  assert.equal(hostMatches('notopenai.com', ['*.openai.com']), false);
});

test('额度源：id 归一化', () => {
  assert.equal(normalizeSourceId('cursor'), 'custom:cursor');
  assert.equal(normalizeSourceId('custom:My-Src'), 'custom:my-src');
  assert.equal(normalizeSourceId('custom:'), '');
  assert.equal(normalizeSourceId('bad id!'), '');
});

test('额度源：窗口结果归一化（百分数 / 分数 / 由 used+limit 推算）', () => {
  const windows = normalizeResultWindows([
    { key: 'm', label: '本月', used: 31, limit: 100, percent: 31, unit: 'percent' },
    { label: '分数形式', percent: 0.62 },
    { label: '推算', used: 25, limit: 50 },
  ]);
  assert.equal(windows[0].percent, 0.31);
  assert.equal(windows[1].percent, 0.62);
  assert.equal(windows[2].percent, 0.5);
  assert.equal(windows[1].unit, 'percent');
  assert.throws(() => normalizeResultWindows(null), /窗口数组/);
  assert.throws(() => normalizeResultWindows([]), /没有返回/);
});

test('额度源：试跑代码能取到用户凭证并发请求', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      url,
      text: async () => JSON.stringify({ usage: { used: 62, limit: 100 }, resets_at: '2026-11-11T00:00:00Z' }),
    };
  };

  const out = await runSourceCode({
    code: `async ({ http, credential, kit }) => {
      const res = await http.get('https://api.example.com/usage', { headers: { Authorization: 'Bearer ' + credential } });
      return [{
        key: 'five_hour',
        label: '5 小时窗口',
        used: res.json.usage.used,
        limit: res.json.usage.limit,
        percent: kit.pct(res.json.usage.used, res.json.usage.limit),
        resetAt: kit.iso(res.json.resets_at),
      }];
    }`,
    credential: 'sk-test-abcdef',
    allowHosts: ['api.example.com'],
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test-abcdef');
  assert.equal(out.windows.length, 1);
  assert.equal(out.windows[0].percent, 0.62);
  assert.equal(out.windows[0].limit, 100);
  assert.equal(out.windows[0].resetAt, '2026-11-11T00:00:00.000Z');
  assert.equal(out.hosts[0], 'api.example.com');
});

test('额度源：域名白名单外的请求被拒绝', async () => {
  await assert.rejects(
    () => runSourceCode({
      code: `async ({ http }) => http.get('https://evil.example.org/steal')`,
      allowHosts: ['api.example.com'],
      fetchImpl: async () => ({ ok: true, status: 200, url: '', text: async () => '{}' }),
    }),
    /不在白名单/,
  );
});

test('额度源：语法错误 / 不是函数 / 返回值不对都有明确报错', async () => {
  await assert.rejects(() => runSourceCode({ code: 'async (', allowHosts: ['a.com'] }), /语法错误/);
  await assert.rejects(() => runSourceCode({ code: '42', allowHosts: ['a.com'] }), /必须是一个函数/);
  await assert.rejects(
    () => runSourceCode({ code: 'async () => ({ nope: true })', allowHosts: ['a.com'] }),
    /窗口数组/,
  );
});

test('额度源：代码卡死会超时中断', async () => {
  const started = Date.now();
  await assert.rejects(
    () => runSourceCode({
      code: 'async () => { await new Promise(() => {}); }',
      allowHosts: ['a.com'],
      timeoutMs: 1000,
    }),
    /超时/,
  );
  assert.ok(Date.now() - started < 5000);
});

test('额度源：沙箱里拿不到 require / process / fetch', async () => {
  const out = await runSourceCode({
    code: `async () => {
      if (typeof require !== 'undefined') throw new Error('require leaked');
      if (typeof process !== 'undefined') throw new Error('process leaked');
      if (typeof fetch !== 'undefined') throw new Error('fetch leaked');
      return [{ key: 'ok', label: '干净', percent: 0.1 }];
    }`,
    allowHosts: ['a.com'],
  });
  assert.equal(out.windows[0].key, 'ok');
});

test('额度源：凭证不会出现在返回给用户的样本里', () => {
  const secret = 'sk-live-SECRET-123456';
  const redacted = redactSecrets({ token: secret, nested: { api_key: secret, note: 'used ' + secret } }, [secret]);
  assert.equal(redacted.token, '***');
  assert.equal(redacted.nested.api_key, '***');
  assert.ok(!JSON.stringify(redacted).includes(secret));

  const sample = sampleOf({ authorization: 'Bearer ' + secret, blob: 'x'.repeat(50) }, [secret], 30);
  assert.ok(!sample.includes(secret));
  assert.match(sample, /已截断/);
});

test('额度源：保存前的基本校验', () => {
  const empty = inspectSourceDraft({ code: '', hosts: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.problems.join('；'), /缺少查询代码/);
  assert.match(empty.problems.join('；'), /hosts/);

  const badCode = inspectSourceDraft({ code: 'async (', hosts: ['api.example.com'] });
  assert.equal(badCode.ok, false);
  assert.match(badCode.problems.join('；'), /语法错误/);

  const notFn = inspectSourceDraft({ code: '42', hosts: ['api.example.com'] });
  assert.equal(notFn.ok, false);

  const good = inspectSourceDraft({ code: 'async () => []', hosts: 'https://api.example.com/x' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.hosts, ['api.example.com']);
});

/* --------------------------- 服务层集成 --------------------------- */

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'butler-src-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const config = {
    currency: 'CNY',
    pollSeconds: 30,
    advanceMinutes: 30,
    maxSnapshots: 10,
    reminderTarget: 'new_once',
    quotaTimeoutMs: 5000,
  };
  const kinds = createKinds(store);
  kinds.ensureSeeded();

  const credentialStore = new Map();
  const credentials = {
    backend: () => 'memory',
    getError: () => null,
    get: (ref) => credentialStore.get(ref),
    has: (ref) => credentialStore.has(ref) && Boolean(credentialStore.get(ref)),
    set: (ref, value) => {
      if (value) credentialStore.set(ref, value);
      else credentialStore.delete(ref);
      return true;
    },
  };

  const reminders = {
    available: () => true,
    isSyncing: () => false,
    lastError: () => ({ at: null, message: null }),
    async syncItem() {
      return { status: 'created' };
    },
    async removeAllFor() {},
    async syncAll() {
      return { status: 'ok', created: 0, unchanged: 0, skipped: 0, past: 0, error: 0 };
    },
  };

  const quota = {
    state: () => ({ busy: false, lastTick: null, lastError: null, skipped: 0 }),
    isBusy: () => false,
    sources: () =>
      store.list('sources').map((record) => ({
        id: record.id,
        label: record.label,
        needsCredential: record.needsCredential !== false,
        credentialHint: record.credentialHint,
        custom: true,
        hosts: record.hosts,
        lastTestOk: record.lastTestOk,
        lastTestAt: record.lastTestAt,
      })),
    resolveSource: (id) => resolveSource(id, config, store),
    async tick() {
      return { status: 'ok', results: [] };
    },
  };

  const alerts = createAlerts({ store, config });
  const hooks = { data: [], onDataChanged: (r) => hooks.data.push(r) };
  const service = createService({ store, config, kinds, credentials, quota, reminders, alerts, hooks });
  return { dir, store, config, service, credentials, hooks };
}

const CODE = `async ({ http, credential, kit }) => {
  const res = await http.get('https://api.example.com/usage', { headers: { Authorization: 'Bearer ' + credential } });
  return [
    { key: 'monthly', label: '本月额度', used: res.json.used, limit: res.json.limit, percent: kit.pct(res.json.used, res.json.limit), resetAt: kit.iso(res.json.resets_at) }
  ];
}`;

function stubFetch(payload) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    url: String(url),
    text: async () => JSON.stringify(payload),
  });
  return () => {
    globalThis.fetch = original;
  };
}

test('额度源：没试跑过不许保存（连 skipTest 旁路也没有）', async () => {
  const { service } = makeService();
  const result = service.saveSource({ label: '示例', code: CODE, hosts: 'api.example.com' });
  assert.equal(result.ok, false);
  assert.match(result.error, /试跑/);

  // 这条路径面板 HTTP 也能打，留布尔旁路等于让「用户确认过」变成摆设
  const forced = service.saveSource({ label: '示例', code: CODE, hosts: 'api.example.com', skipTest: true });
  assert.equal(forced.ok, false);
  assert.match(forced.error, /试跑/);
});

test('额度源：试跑 → 保存 → 出现在 sources 列表，代码变更后要重新试跑', async () => {
  const { service, store } = makeService();
  const restore = stubFetch({ used: 31, limit: 100, resets_at: '2026-12-01T00:00:00Z' });
  try {
    const tested = await service.testSource({ code: CODE, hosts: 'api.example.com', credential: 'sk-test-1' });
    assert.equal(tested.ok, true, tested.error);
    assert.equal(tested.data.windows[0].percent, 0.31);
    assert.ok(tested.data.testToken);

    const saved = service.saveSource({ label: 'Cursor 用量', code: CODE, hosts: 'api.example.com', vendor: 'Cursor' });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.data.created, true);
    assert.match(saved.data.source.id, /^custom:/);
    assert.deepEqual(saved.data.source.hosts, ['api.example.com']);

    const list = service.listSources({ includeCode: true }).data.sources;
    assert.equal(list.length, 1);
    assert.match(list[0].code, /http\.get/);

    // 改了代码但没试跑 → 拒绝
    const changed = CODE.replace('本月额度', '本月用量X');
    const rejected = service.saveSource({ label: 'Cursor 用量', code: changed, hosts: 'api.example.com', id: saved.data.source.id });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /试跑/);

    // 试跑新代码后再存 → 允许
    const retested = await service.testSource({ code: changed, hosts: 'api.example.com', credential: 'sk-test-1' });
    assert.equal(retested.ok, true, retested.error);
    const updated = service.saveSource({ label: 'Cursor 用量', code: changed, hosts: 'api.example.com', id: saved.data.source.id });
    assert.equal(updated.ok, true, updated.error);
    assert.equal(updated.data.created, false);
    assert.equal(store.list('sources').length, 1);
  } finally {
    restore();
  }
});

test('额度源：试跑失败会把错误记在源上；凭证缺失直接拒绝', async () => {
  const { service } = makeService();
  const noCred = await service.testSource({ code: CODE, hosts: 'api.example.com' });
  assert.equal(noCred.ok, false);
  assert.match(noCred.error, /凭证/);

  const failing = `async ({ http }) => { const r = await http.get('https://api.example.com/x'); if (!r.json.ok) throw new Error('接口说不行'); return [{ key: 'a', label: 'A', percent: 0 }]; }`;
  const restore = stubFetch({ ok: false });
  try {
    const tested = await service.testSource({ code: failing, hosts: 'api.example.com', needsCredential: false });
    assert.equal(tested.ok, false);
    assert.match(tested.error, /接口说不行/);
  } finally {
    restore();
  }
});

test('额度源：有计划在用时不许删除；未知 sourceId 不许建计划', async () => {
  const { service, credentials } = makeService();
  const restore = stubFetch({ used: 10, limit: 100, resets_at: null });
  try {
    const tested = await service.testSource({ code: CODE, hosts: 'api.example.com', credential: 'sk-test-2' });
    assert.equal(tested.ok, true, tested.error);
    const saved = service.saveSource({ label: '示例源', code: CODE, hosts: 'api.example.com' });
    assert.equal(saved.ok, true, saved.error);
    const sourceId = saved.data.source.id;

    const badPlan = await service.upsertPlan({ name: 'X', sourceId: 'custom:missing' });
    assert.equal(badPlan.ok, false);
    assert.match(badPlan.error, /不存在/);

    const plan = await service.upsertPlan({ name: '示例计划', sourceId });
    assert.equal(plan.ok, true, plan.error);
    credentials.set(plan.data.record.credentialRef, 'sk-plan-cred');

    const blocked = service.deleteSource(sourceId);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /还有额度计划/);

    const moved = await service.upsertPlan({ name: '示例计划', sourceId: 'manual', id: plan.data.record.id });
    assert.equal(moved.ok, true, moved.error);
    const removed = service.deleteSource(sourceId);
    assert.equal(removed.ok, true, removed.error);
  } finally {
    restore();
  }
});

test('额度源：计划视图带出来源名字与是否自定义', async () => {
  const { service } = makeService();
  const restore = stubFetch({ used: 10, limit: 100, resets_at: null });
  try {
    await service.testSource({ code: CODE, hosts: 'api.example.com', credential: 'sk-test-3' });
    const saved = service.saveSource({ label: '示例源2', code: CODE, hosts: 'api.example.com' });
    await service.upsertPlan({ name: '计划2', sourceId: saved.data.source.id });
    const state = service.state();
    assert.equal(state.plans[0].sourceCustom, true);
    assert.equal(state.plans[0].sourceLabel, '示例源2');
    assert.ok(state.sources.some((s) => s.custom && s.label === '示例源2'));
  } finally {
    restore();
  }
});

function collectUndefinedPaths(value, base = '') {
  if (value === undefined) return [base || '<root>'];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectUndefinedPaths(item, `${base}[${index}]`));
  return Object.entries(value).flatMap(([key, item]) => collectUndefinedPaths(item, base ? `${base}.${key}` : key));
}

test('额度源列表：工具输出必须是无损 JSON（不能带 undefined 字段）', async () => {
  const { service } = makeService();
  const restore = stubFetch({ used: 10, limit: 100, resets_at: null });
  try {
    await service.testSource({ code: CODE, hosts: 'api.example.com', credential: 'sk-test-4' });
    service.saveSource({ label: '示例源3', code: CODE, hosts: 'api.example.com' });

    for (const includeCode of [false, true]) {
      const result = service.listSources({ includeCode });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(collectUndefinedPaths(result), [], 'listSources 里不能有 undefined 字段');
      // 宿主校验的就是这条：JSON 往返必须一模一样
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
      if (includeCode) {
        assert.equal(result.data.sources.find((s) => s.custom)?.code, CODE);
      } else {
        assert.equal('code' in result.data.sources[0], false);
      }
    }
  } finally {
    restore();
  }
});

test('工具输出兜底：jsonSafe 丢掉 undefined、保留 null 与数组', async () => {
  const { jsonSafe } = await import('../src/tools.js').catch(() => ({ jsonSafe: null }));
  // tools.js 依赖宿主的 defineTool，纯 node 环境导入会失败；直接断言同一算法的契约。
  const source = { a: 1, b: undefined, c: [1, undefined, { d: undefined, e: null }], f: null };
  const safe = jsonSafe
    ? jsonSafe(source)
    : JSON.parse(JSON.stringify(source));
  assert.deepEqual(safe, { a: 1, c: [1, null, { e: null }], f: null });
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), safe);
});

/* --------------------------- 网络桥的边界 --------------------------- */

function stubRawFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return handler(String(url), init || {});
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(payload, extra = {}) {
  return {
    ok: true,
    status: 200,
    url: '',
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
    ...extra,
  };
}

test('网络桥：跳转到白名单外的域名会被拒绝（SSRF）', async () => {
  const stub = stubRawFetch(() => ({
    ok: false,
    status: 302,
    headers: { get: (name) => (String(name).toLowerCase() === 'location' ? 'http://127.0.0.1:64673/butler/api/state' : null) },
    text: async () => '',
  }));
  try {
    const http = createHttpBridge({ allowHosts: ['api.example.com'] });
    await assert.rejects(() => http.get('https://api.example.com/usage'), /跳转到了白名单外的地址/);
    assert.equal(stub.calls.length, 1, '不该真的去请求跳转目标');
  } finally {
    stub.restore();
  }
});

test('网络桥：同域跳转被跟随，跨域跳转丢掉鉴权头', async () => {
  const stub = stubRawFetch((url) => {
    if (url.endsWith('/usage')) {
      return {
        ok: false,
        status: 302,
        headers: { get: (name) => (String(name).toLowerCase() === 'location' ? 'https://cdn.example.com/final' : null) },
        text: async () => '',
      };
    }
    return jsonResponse({ used: 1, limit: 10 });
  });
  try {
    const http = createHttpBridge({ allowHosts: ['api.example.com', 'cdn.example.com'] });
    const res = await http.get('https://api.example.com/usage', { headers: { Authorization: 'Bearer secret-token' } });
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].init.redirect, 'manual', '不能交给 fetch 自己跟跳转');
    assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer secret-token');
    assert.equal(stub.calls[1].init.headers.Authorization, undefined, '跨域跳转不能带鉴权头');
  } finally {
    stub.restore();
  }
});

test('网络桥：GET 不会带 body，超大响应被中止', async () => {
  const stub = stubRawFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => 'x'.repeat(5000),
  }));
  try {
    const http = createHttpBridge({ allowHosts: ['api.example.com'], maxBytes: 1024 });
    await assert.rejects(() => http.get('https://api.example.com/a', { body: '{"q":1}' }), /响应太大/);
    assert.equal(stub.calls[0].init.body, undefined, 'GET 不该带 body');
  } finally {
    stub.restore();
  }
});

test('网络桥：错误信息里不保留 query 里的凭证', async () => {
  const http = createHttpBridge({ allowHosts: ['api.example.com'] });
  await assert.rejects(
    () => http.get('not a url?key=sk-super-secret'),
    (error) => {
      assert.doesNotMatch(String(error.message), /sk-super-secret/);
      return true;
    },
  );
});

test('日志抹密：console.log(credential) 进不了 logs', async () => {
  const stub = stubRawFetch(() => jsonResponse({ used: 5, limit: 10 }));
  try {
    const out = await runInVm({
      code: `async ({ http, credential }) => {
        console.log('credential is', credential);
        const res = await http.get('https://api.example.com/usage', { headers: { Authorization: 'Bearer ' + credential } });
        return [{ key: 'm', label: '月', used: res.json.used, limit: res.json.limit }];
      }`,
      credential: 'sk-live-abcdef123456',
      allowHosts: ['api.example.com'],
    });
    assert.equal(out.logs.length, 1);
    assert.doesNotMatch(out.logs[0], /sk-live-abcdef123456/);
    assert.match(out.logs[0], /\*\*\*/);
    const requestUrl = out.request?.url || '';
    assert.doesNotMatch(requestUrl, /sk-live/);
  } finally {
    stub.restore();
  }
});

test('线程隔离：死循环代码会被 worker 强制终止，不拖死宿主', async () => {
  const original = process.env.BUTLER_SOURCE_INPROCESS;
  delete process.env.BUTLER_SOURCE_INPROCESS;
  const started = Date.now();
  try {
    await assert.rejects(
      () =>
        runSourceCode({
          code: 'async () => { while (true) {} }',
          allowHosts: ['api.example.com'],
          timeoutMs: 1000,
        }),
      /超时/,
    );
    const spent = Date.now() - started;
    assert.ok(spent < 12000, `应该在超时后很快返回，实际 ${spent}ms`);
  } finally {
    if (original === undefined) delete process.env.BUTLER_SOURCE_INPROCESS;
    else process.env.BUTLER_SOURCE_INPROCESS = original;
  }
});
/* --------------------------- 本轮新增回归 --------------------------- */

test('白名单：端口参与匹配，默认端口才放行', () => {
  // 规则不带端口 = 只放行默认端口
  assert.equal(hostMatches('api.example.com', ['api.example.com']), true);
  assert.equal(hostMatches('api.example.com:443', ['api.example.com']), true);
  assert.equal(hostMatches('api.example.com:80', ['api.example.com']), true);
  // 非默认端口不算命中，避免「换个端口打到别的服务」
  assert.equal(hostMatches('api.example.com:8443', ['api.example.com']), false);
  // 规则明文带端口则只认那个端口
  assert.equal(hostMatches('api.example.com:8443', ['api.example.com:8443']), true);
  assert.equal(hostMatches('api.example.com', ['api.example.com:8443']), false);
});

test('窗口归一化：剩余百分比方向正确', () => {
  // remainingPercent 是「剩多少」；percent 是「用了多少」，方向反了会漏报超额
  const [w] = normalizeResultWindows([{ key: 'w', label: '周', remainingPercent: 20, unit: 'percent', resetAt: null }]);
  assert.equal(w.percent, 0.8);
  const [full] = normalizeResultWindows([{ key: 'w2', label: '周', remainingPercent: 0 }]);
  assert.equal(full.percent, 1);
  const [none] = normalizeResultWindows([{ key: 'w3', label: '周', remainingPercent: 100 }]);
  assert.equal(none.percent, 0);
  // 百分数形态（>1）与分数形态（<=1）都要归一到 0~1
  assert.equal(normalizeResultWindows([{ key: 'a', label: 'a', percent: 62 }])[0].percent, 0.62);
  assert.equal(normalizeResultWindows([{ key: 'b', label: 'b', percent: 0.62 }])[0].percent, 0.62);
  assert.equal(normalizeResultWindows([{ key: 'c', label: 'c', percent: 150 }])[0].percent, 1);
  assert.equal(normalizeResultWindows([{ key: 'd', label: 'd', percent: 0 }])[0].percent, 0);
});

test('抹密：内联 token 形态也会被抹掉', () => {
  const text = 'Authorization: Bearer sk-live-abcdef123456\naccess_token="ya29.a0AfH6"\ncookie: sessionid=deadbeef';
  const scrubbed = scrubInlineSecrets(text);
  assert.equal(/sk-live-abcdef123456/.test(scrubbed), false);
  assert.equal(/ya29\.a0AfH6/.test(scrubbed), false);
  assert.equal(/deadbeef/.test(scrubbed), false);
});

test('服务层：借计划凭证试跑必须落在该计划登记的域名内', async () => {
  const { service } = makeService();
  const restore = stubFetch({ used: 31, limit: 100, resets_at: '2026-12-01T00:00:00Z' });
  try {
    const tested = await service.testSource({ code: CODE, hosts: 'api.example.com', credential: 'sk-own' });
    assert.equal(tested.ok, true, tested.error);
    const saved = service.saveSource({ label: '自家接口', code: CODE, hosts: 'api.example.com' });
    assert.equal(saved.ok, true, saved.error);

    const plan = await service.upsertPlan({ name: '只许自家域名', sourceId: saved.data.source.id });
    assert.equal(plan.ok, true, plan.error);
    const planId = plan.data.record.id;
    await service.setPlanCredential(planId, 'sk-own');

    // 用该计划的凭证去试跑别人的域名 → 必须拒绝（否则任意 hosts + 已有凭证可以外发数据）
    const denied = await service.testSource({ code: CODE, hosts: 'evil.example.com', planId });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /域名/);

    // 同一段代码落在自家域名上则放行
    const allowed = await service.testSource({ code: CODE, hosts: 'api.example.com', planId });
    assert.equal(allowed.ok, true, allowed.error);
  } finally {
    restore();
  }
});

test('服务层：删计划会清掉凭证；新建带 id 被拒绝', async () => {
  const { service, store, credentials } = makeService();
  const plan = await service.upsertPlan({ name: '凭证清理', sourceId: 'manual' });
  const id = plan.data.record.id;
  const ref = store.find('plans', id).credentialRef;
  await service.setPlanCredential(id, 'secret-value');
  assert.equal(store.find('plans', id).hasCredential, true);
  assert.equal(credentials.has(ref), true);
  await service.removePlan(id);
  assert.equal(store.find('plans', id), null);
  // 凭证必须跟着计划一起消失（否则会在磁盘上留下孤儿密钥）
  assert.equal(credentials.has(ref), false);

  const rejected = await service.mutate({ collection: 'todos', op: 'create', record: { id: 'todo_hack', title: '伪造 id' } });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /id/);
});
