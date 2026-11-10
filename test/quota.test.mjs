import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createQuotaEngine } from '../src/quota.js';
import { Store } from '../src/store.js';

function makeEnv(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'butler-quota-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const secrets = new Map();
  const credentials = {
    backend: () => 'memory',
    getError: () => null,
    get: (ref) => secrets.get(ref),
    has: (ref) => secrets.has(ref),
    set: (ref, value) => {
      if (value) secrets.set(ref, value);
      else secrets.delete(ref);
      return true;
    },
  };
  const config = {
    quotaTimeoutMs: 5000,
    maxSnapshots: 10,
    currency: 'CNY',
    quotaSources: {
      'my-api': {
        baseUrl: 'https://quota.example.test',
        path: '/v1/usage',
        headers: { Authorization: 'Bearer {{credential}}' },
        mapping: {
          windows: [
            { key: 'five_hour', label: '5 小时', percent: 'data.5h.usage', resetAt: 'data.5h.reset' },
            { key: 'weekly', label: '周', percent: 'data.week.usage' },
          ],
        },
      },
      ...(overrides.quotaSources || {}),
    },
  };
  return { dir, store, credentials, config };
}

const originalFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => handler(url, init);
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('额度：串行查询，绝不并发', async () => {
  const { store, credentials, config } = makeEnv();
  stubs();
  let inflight = 0;
  let maxInflight = 0;
  stubFetch(async () => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inflight -= 1;
    return jsonResponse({ data: { '5h': { usage: 0.4, reset: '2026-11-10T07:00:00.000Z' }, week: { usage: 0.7 } } });
  });

  function stubs() {
    store.put('plans', { name: 'A', sourceId: 'my-api', credentialRef: 'k1' });
    store.put('plans', { name: 'B', sourceId: 'my-api', credentialRef: 'k2' });
    credentials.set('k1', 'secret1');
    credentials.set('k2', 'secret2');
  }

  const engine = createQuotaEngine({ store, config, credentials });
  const result = await engine.tick({});
  assert.equal(result.status, 'ok');
  assert.equal(result.results.length, 2);
  assert.equal(maxInflight, 1, '同一时刻只允许一个请求在飞');

  const windows = store.list('plans')[0].windows;
  assert.equal(windows.length, 2);
  assert.equal(windows[0].percent, 0.4);
  assert.equal(windows[1].label, '周');
  assert.equal(store.list('snapshots').length, 2);
});

test('额度：上一轮未结束时直接跳过（单飞）', async () => {
  const { store, credentials, config } = makeEnv();
  store.put('plans', { name: 'A', sourceId: 'my-api', credentialRef: 'k1' });
  credentials.set('k1', 'secret');
  let release;
  stubFetch(() => new Promise((resolve) => {
    release = () => resolve(jsonResponse({ data: { '5h': { usage: 0.1 }, week: { usage: 0.2 } } }));
  }));

  const engine = createQuotaEngine({ store, config, credentials });
  const first = engine.tick({});
  const second = await engine.tick({});
  assert.equal(second.status, 'busy');
  assert.equal(engine.state().skipped, 1);
  release();
  const done = await first;
  assert.equal(done.status, 'ok');
});

test('额度：缺少凭证时不发请求，标 no-credential', async () => {
  const { store, credentials, config } = makeEnv();
  store.put('plans', { name: 'A', sourceId: 'claude-usage', credentialRef: 'missing' });
  let called = 0;
  stubFetch(async () => {
    called += 1;
    return jsonResponse({});
  });

  const engine = createQuotaEngine({ store, config, credentials });
  const result = await engine.tick({});
  assert.equal(called, 0);
  assert.equal(result.results[0].status, 'no-credential');
  assert.equal(store.list('plans')[0].status, 'no-credential');
});

test('额度：接口报错被收敛成 plan.error，不抛给调用方', async () => {
  const { store, credentials, config } = makeEnv();
  store.put('plans', { name: 'A', sourceId: 'my-api', credentialRef: 'k1' });
  credentials.set('k1', 'secret');
  stubFetch(async () => jsonResponse({ error: 'bad' }, 401));

  const engine = createQuotaEngine({ store, config, credentials });
  const result = await engine.tick({});
  assert.equal(result.status, 'ok');
  assert.equal(result.results[0].status, 'error');
  assert.match(result.results[0].error, /凭证|401|鉴权/);
  assert.equal(store.list('plans')[0].status, 'error');
});

test('额度：manual 源不联网', async () => {
  const { store, credentials, config } = makeEnv();
  store.put('plans', { name: '手填', sourceId: 'manual' });
  let called = 0;
  stubFetch(async () => {
    called += 1;
    return jsonResponse({});
  });

  const engine = createQuotaEngine({ store, config, credentials });
  const result = await engine.tick({});
  assert.equal(called, 0);
  assert.equal(result.results[0].status, 'manual');
});

test('额度：快照按上限裁剪', async () => {
  const { store, credentials, config } = makeEnv();
  config.maxSnapshots = 2;
  store.put('plans', { name: 'A', sourceId: 'my-api', credentialRef: 'k1' });
  credentials.set('k1', 'secret');
  stubFetch(async () => jsonResponse({ data: { '5h': { usage: 0.5 }, week: { usage: 0.5 } } }));

  const engine = createQuotaEngine({ store, config, credentials });
  for (let i = 0; i < 4; i += 1) await engine.tick({});
  assert.equal(store.list('snapshots').length, 2);
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async text() {
      return JSON.stringify(body);
    },
  };
}