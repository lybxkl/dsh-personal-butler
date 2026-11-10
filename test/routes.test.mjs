import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { registerRoutes } from '../src/routes.js';

/* ------------------------------ 假宿主 ------------------------------ */

function makeService(overrides = {}) {
  return {
    state: () => ({ assets: [], plans: [], diagnostics: { storagePath: 'x.json' } }),
    summary: () => ({ assetCount: 0 }),
    async mutate(input) {
      if (input.collection === 'todos') return { ok: true, data: { record: { id: 'todo_1', title: input.record?.title } } };
      return { ok: false, error: '不支持' };
    },
    updateSettings: () => ({ ok: true, data: { config: {} } }),
    ...overrides,
  };
}

function mount({ getOrigin = () => null, apiToken = '', service = makeService() } = {}) {
  let route = null;
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get: () => null,
    webServer: {
      getOrigin,
      register(definition) {
        route = definition;
        return () => {};
      },
    },
  };
  registerRoutes(ctx, service, { config: { apiToken }, logger: null });
  assert.ok(route, '应该注册了路由');
  return route;
}

function fakeReq({ method = 'GET', url = '/butler/api/state', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {
    req.destroyed = true;
  };
  req.resume = () => {};
  setImmediate(() => {
    if (body !== null && body !== undefined) req.emit('data', Buffer.from(String(body)));
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value;
    },
    writeHead(status, headers) {
      res.status = status;
      res.headersSent = true;
      for (const [key, value] of Object.entries(headers || {})) res.headers[key.toLowerCase()] = value;
    },
    end(chunk) {
      res.body = chunk ? String(chunk) : '';
    },
  };
  return res;
}

async function call(route, options) {
  const req = fakeReq(options);
  const res = fakeRes();
  await route.handler(req, res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json };
}

/* ------------------------------ 用例 ------------------------------ */

test('路由：非本机 Host 直接拒绝（防 DNS rebinding / 局域网访问）', async () => {
  const route = mount();
  const result = await call(route, { headers: { host: 'evil.example.com' } });
  assert.equal(result.status, 403);
  assert.match(result.json.error, /本机/);
});

test('路由：跨站 Origin 被拒——即使宿主拿不到 selfOrigin 也不能放行', async () => {
  const route = mount({ getOrigin: () => null });
  const result = await call(route, {
    method: 'POST',
    url: '/butler/api/mutate',
    headers: { host: '127.0.0.1:64673', origin: 'http://evil.example.com', 'content-type': 'application/json' },
    body: JSON.stringify({ collection: 'todos', op: 'create', record: { title: '被 CSRF 建出来的待办' } }),
  });
  assert.equal(result.status, 403);
  assert.match(result.json.error, /跨源/);
});

test('路由：同源请求放行，localhost 与 127.0.0.1 视为同源', async () => {
  const route = mount({ getOrigin: () => null });
  const result = await call(route, {
    headers: { host: '127.0.0.1:64673', origin: 'http://localhost:64673' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
});

test('路由：POST 必须是 application/json（挡掉 no-cors 的 form/text-plain 载体）', async () => {
  const route = mount();
  const textPlain = await call(route, {
    method: 'POST',
    url: '/butler/api/mutate',
    headers: { host: '127.0.0.1:64673', 'content-type': 'text/plain' },
    body: '{"collection":"todos","op":"create","record":{"title":"x"}}',
  });
  assert.equal(textPlain.status, 415);

  const form = await call(route, {
    method: 'POST',
    url: '/butler/api/mutate',
    headers: { host: '127.0.0.1:64673', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'collection=todos',
  });
  assert.equal(form.status, 415);
});

test('路由：POST 的 JSON 会被交给 service，并回带最新 state', async () => {
  const route = mount();
  const result = await call(route, {
    method: 'POST',
    url: '/butler/api/mutate',
    headers: { host: '127.0.0.1:64673', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ collection: 'todos', op: 'create', record: { title: '交周报' } }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.result.record.title, '交周报');
  assert.ok(result.json.state);
});

test('路由：配置了 apiToken 就必须带 x-butler-token', async () => {
  const route = mount({ apiToken: 'secret-token' });
  const missing = await call(route, { headers: { host: '127.0.0.1:64673' } });
  assert.equal(missing.status, 401);

  const wrong = await call(route, { headers: { host: '127.0.0.1:64673', 'x-butler-token': 'nope' } });
  assert.equal(wrong.status, 401);

  const ok = await call(route, { headers: { host: '127.0.0.1:64673', 'x-butler-token': 'secret-token' } });
  assert.equal(ok.status, 200);
});

test('路由：未知路径 404、方法不匹配 405 且带 allow 头', async () => {
  const route = mount();
  const notFound = await call(route, { url: '/butler/api/nope', headers: { host: '127.0.0.1:64673' } });
  assert.equal(notFound.status, 404);

  const wrongMethod = await call(route, { method: 'DELETE', headers: { host: '127.0.0.1:64673' } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'GET');
});

test('路由：请求体超限回 413（不是把连接掐断）', async () => {
  const route = mount();
  const huge = 'x'.repeat(300 * 1024);
  const result = await call(route, {
    method: 'POST',
    url: '/butler/api/mutate',
    headers: { host: '127.0.0.1:64673', 'content-type': 'application/json' },
    body: JSON.stringify({ collection: 'todos', op: 'create', record: { title: huge } }),
  });
  assert.equal(result.status, 413);
  assert.match(result.json.error, /过大/);
});

test('路由：坏 JSON 回 400，GET 带 body 回 400', async () => {
  const route = mount();
  const badJson = await call(route, {
    method: 'POST',
    url: '/butler/api/mutate',
    headers: { host: '127.0.0.1:64673', 'content-type': 'application/json' },
    body: '{不是 JSON',
  });
  assert.equal(badJson.status, 400);

  const getWithBody = await call(route, {
    headers: { host: '127.0.0.1:64673', 'content-length': '12' },
  });
  assert.equal(getWithBody.status, 400);
});

test('路由：错误信息不会被包成 200，响应带 nosniff', async () => {
  const route = mount({ service: makeService({ async mutate() { throw new Error('内部炸了'); } }) });
  const result = await call(route, {
    method: 'POST',
    url: '/butler/api/mutate',
    headers: { host: '127.0.0.1:64673', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(result.status, 400);
  assert.match(result.json.error, /内部炸了/);
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
});