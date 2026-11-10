/**
 * 面板数据通道：同源 HTTP 路由。
 *
 * 为什么不用 ctx.remote：Remote BFF 的能力集在构建期由 apps/web 的显式 value import 固定，
 * 本地安装的 bundle 无法在运行时新增 ctx.remote.<ns> 命名空间（见设计文档 §4.1）。
 * webServer 路由是官方开放的 Host→Client 通道（dsh-host-open-in-app 同款用法）。
 *
 * 安全：webServer 自身没有认证层，因此这里自带三道防护：
 *   1) 只接受 loopback 的 Host（防止 DNS rebinding / 局域网访问）
 *   2) 带 Origin 时必须与自身 origin 同源（防 CSRF）
 *   3) 可选 apiToken 头（config.apiToken 非空时强制）
 * 照片是唯一的例外：`<img src>` 带不了请求头，改由 URL 上的 HMAC 签名放行（见 photos.js）。
 */

import { verifyPhotoSignature } from './photos.js';

const MAX_BODY = 256 * 1024;
// 照片走 base64，8MB 的图编码后约 10.7MB；其它接口仍用 256KB，别为一张图放宽全部入口。
const MAX_PHOTO_BODY = 12 * 1024 * 1024;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0:0:0:0:0:0:0:1']);

function hostIsLoopback(hostHeader) {
  if (!hostHeader) return true; // 去掉 Host 的请求只会来自本机工具
  const host = String(hostHeader).toLowerCase();
  // 处理 "127.0.0.1:64673" / "[::1]:64673"
  const bracket = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) return LOOPBACK.has(`[${bracket[1]}]`) || LOOPBACK.has(bracket[1]);
  const name = host.split(':')[0];
  return LOOPBACK.has(name);
}

/** 把 `localhost` / `127.0.0.1` / `[::1]` 视为同一个主机名，避免用户换写法就被拒。 */
function normalizeLoopbackName(name) {
  const host = String(name || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1') return 'loopback';
  return host;
}

/**
 * origin 白名单：优先用宿主自报的 origin；拿不到时**用请求的 Host 头现场推**（fail closed）。
 * 早期实现是「selfOrigin 为空就跳过校验」，等于没有防护——对方只要不带 Origin 头或者宿主
 * getOrigin 不可用就能跨站写账本。
 */
function allowedOrigins(selfOrigin, hostHeader) {
  const out = new Set();
  const push = (value) => {
    try {
      const url = new URL(value);
      out.add(`${url.protocol}//${normalizeLoopbackName(url.hostname)}:${url.port}`);
    } catch {
      /* 忽略 */
    }
  };
  if (selfOrigin) push(selfOrigin);
  const host = String(hostHeader || '').trim();
  if (host) {
    push(`http://${host}`);
    push(`https://${host}`);
  }
  return out;
}

function originMatches(originHeader, allowed) {
  if (!originHeader) return true; // 浏览器跨站请求一定带 Origin；没有 Origin 的是本机工具（curl 等）
  try {
    const origin = new URL(originHeader);
    return allowed.has(`${origin.protocol}//${normalizeLoopbackName(origin.hostname)}:${origin.port}`);
  } catch {
    return false;
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        // 不要 destroy：那样客户端只会看到连接被重置。排空并回 413 更有用。
        try {
          req.resume();
        } catch {
          /* 忽略 */
        }
        const error = new Error('请求体过大');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error('请求体不是合法 JSON');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', (error) => reject(error));
  });
}

function send(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function headerValue(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

export function registerRoutes(ctx, service, helpers) {
  const { config, logger, basePath = '/butler' } = helpers;

  const routes = [
    {
      path: `${basePath}/api/state`,
      method: 'GET',
      handler: () => ({ ok: true, ...service.state() }),
    },
    {
      path: `${basePath}/api/summary`,
      method: 'GET',
      handler: () => ({ ok: true, ...service.summary() }),
    },
    {
      path: `${basePath}/api/mutate`,
      method: 'POST',
      handler: async (body) => {
        const result = await service.mutate({
          collection: body.collection,
          op: body.op,
          id: body.id,
          record: body.record || body.fields,
        });
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, result: result.data, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/settings`,
      method: 'POST',
      handler: async (body) => {
        const result = await service.updateSettings(body.patch || body);
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, ...result.data, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/quota/refresh`,
      method: 'POST',
      handler: async (body) => {
        const result = await service.refreshQuota(body.planId);
        if (!result.ok) return { status: 409, payload: { ok: false, error: result.error } };
        return { ok: true, ...result.data, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/plans/credential`,
      method: 'POST',
      handler: (body) => {
        const result = service.setPlanCredential(body.planId, body.credential);
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, ...result.data, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/plans/windows`,
      method: 'POST',
      handler: (body) => {
        const result = service.setPlanWindows(body.planId, body.windows);
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, result: result.data, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/alerts/ack`,
      method: 'POST',
      handler: (body) => {
        const result = body.all ? service.ackAllAlerts() : service.ackAlert(body.id);
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, ...result.data, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/kinds/register`,
      method: 'POST',
      handler: (body) => {
        const result = service.registerKind(body.kind || body);
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, kind: result.data.kind, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/reminders/sync`,
      method: 'POST',
      handler: async (body) => {
        const result = await service.syncReminders({ force: Boolean(body.force) });
        if (!result.ok) return { status: 409, payload: { ok: false, error: result.error } };
        return { ok: true, ...result.data, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/sources`,
      method: 'GET',
      handler: (body, query) => {
        const result = service.listSources({ includeCode: query.code === '1' });
        return { ok: true, sources: result.data.sources };
      },
    },
    {
      path: `${basePath}/api/sources/test`,
      method: 'POST',
      handler: async (body) => {
        const result = await service.testSource(body || {});
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, ...result.data };
      },
    },
    {
      path: `${basePath}/api/sources/save`,
      method: 'POST',
      handler: (body) => {
        const result = service.saveSource(body || {});
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, ...result.data, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/sources/delete`,
      method: 'POST',
      handler: (body) => {
        const result = service.deleteSource(body.id);
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, ...result.data, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/photos`,
      method: 'POST',
      handler: (body) => {
        if (!helpers.photos) return { status: 503, payload: { ok: false, error: '图片服务未就绪' } };
        try {
          const record = helpers.photos.saveDataUrl(body?.dataUrl);
          return { ok: true, photo: helpers.photos.view(record), state: service.state() };
        } catch (error) {
          return { status: 400, payload: { ok: false, error: String(error?.message || error) } };
        }
      },
    },
    {
      // 面板取消编辑 / 换图时把没挂上的图片一起删掉，别在数据目录里留孤儿
      path: `${basePath}/api/photos/delete`,
      method: 'POST',
      handler: async (body) => {
        const result = await service.removePhoto(body?.id);
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, ...result.data, state: service.state() };
      },
    },
    {
      path: `${basePath}/api/health`,
      method: 'GET',
      handler: () => ({ ok: true, version: '0.1.0', storagePath: service.state().diagnostics.storagePath }),
    },
  ];

  const table = new Map(routes.map((route) => [route.path, route]));

  const dispose = ctx.effect(() => {
    const webServer = ctx.webServer ?? ctx.get('webServer');
    if (!webServer?.register) {
      logger?.warn?.('[butler] 宿主没有 webServer 服务，资产面板将无法读取数据');
      return () => {};
    }

    let selfOrigin = null;
    try {
      selfOrigin = webServer.getOrigin?.() ?? null;
    } catch {
      selfOrigin = null;
    }

    return webServer.register({
      kind: 'prefix',
      path: basePath,
      handler: async (req, res) => {
        try {
          const hostHeader = headerValue(req, 'host');
          if (!hostIsLoopback(hostHeader)) {
            return send(res, 403, { ok: false, error: '仅允许本机访问管家接口' });
          }
          const allowed = allowedOrigins(selfOrigin, hostHeader);
          if (!originMatches(headerValue(req, 'origin'), allowed)) {
            return send(res, 403, { ok: false, error: '跨源请求被拒绝' });
          }
          const token = config.apiToken;
          const url = new URL(req.url || '/', 'http://localhost');

          // 照片是二进制，单独走一条前缀路由。鉴权不能用请求头（<img src> 带不了），
          // 改用 photoView 生成的 exp+sig 签名；面板 fetch 仍可带 x-butler-token。
          const photoPrefix = `${basePath}/api/photo/`;
          if (url.pathname.startsWith(photoPrefix)) {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.setHeader?.('allow', 'GET');
              return send(res, 405, { ok: false, error: '只支持 GET' });
            }
            if (token) {
              const provided = headerValue(req, 'x-butler-token');
              const query = Object.fromEntries(url.searchParams.entries());
              const photoIdForAuth = url.pathname.slice(photoPrefix.length);
              const signed = verifyPhotoSignature(photoIdForAuth, query, token);
              if (provided !== token && !signed) {
                return send(res, 403, { ok: false, error: '图片链接无效或已过期' });
              }
            }
            const photoId = decodeURIComponent(url.pathname.slice(photoPrefix.length));
            const found = helpers.photos?.read(photoId);
            if (!found) return send(res, 404, { ok: false, error: '图片不存在' });
            res.statusCode = 200;
            res.setHeader('content-type', found.mime);
            res.setHeader('content-length', found.buffer.length);
            res.setHeader('cache-control', 'private, max-age=3600');
            res.setHeader('x-content-type-options', 'nosniff');
            res.end(found.buffer);
            return;
          }

          if (token) {
            const provided = headerValue(req, 'x-butler-token');
            if (provided !== token) return send(res, 401, { ok: false, error: '缺少或错误的 x-butler-token' });
          }

          const route = table.get(url.pathname);
          if (!route) return send(res, 404, { ok: false, error: `未知接口 ${url.pathname}` });
          if (req.method !== route.method) {
            res.setHeader?.('allow', route.method);
            return send(res, 405, { ok: false, error: `只支持 ${route.method}` });
          }

          let body = {};
          if (route.method === 'POST') {
            // 只接受 JSON：不带预检的跨站「简单请求」只能发 text/plain / form，这一条能挡掉 CSRF 载体
            const contentType = String(headerValue(req, 'content-type') || '').toLowerCase();
            if (!contentType.includes('application/json')) {
              return send(res, 415, { ok: false, error: '只接受 application/json' });
            }
            body = await readBody(req, url.pathname === `${basePath}/api/photos` ? MAX_PHOTO_BODY : MAX_BODY);
          } else if (Number(headerValue(req, 'content-length') || 0) > 0) {
            return send(res, 400, { ok: false, error: 'GET 请求不要带 body' });
          }
          const query = Object.fromEntries(url.searchParams.entries());
          const result = await route.handler(body || {}, query);
          if (result && result.status && result.payload) {
            // service 方法可能是 async：漏了 await 时 error 会是 undefined，回给面板就成了空失败
            const payload = result.payload;
            if (payload && payload.ok === false && !payload.error) {
              logger?.warn?.(`[butler] ${url.pathname} 返回了失败但没有原因`);
              return send(res, result.status, { ok: false, error: '操作失败（没有拿到失败原因）' });
            }
            return send(res, result.status, payload);
          }
          return send(res, 200, result);
        } catch (error) {
          const message = String(error?.message || error);
          const status = Number(error?.status) || 400;
          if (status !== 400) logger?.warn?.(`[butler] 路由处理失败：${message}`);
          return send(res, status, { ok: false, error: message });
        }
      },
    });
  }, 'butler: panel API route');

  return () => {
    try {
      dispose?.();
    } catch {
      /* 卸载时忽略 */
    }
  };
}
