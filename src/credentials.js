/**
 * 额度查询凭证存储。
 *
 * 产品边界（用户明确要求）：额度查询凭证与 DSH 的模型配置**是两回事**。
 *  - DSH 模型凭证服务于 AI 能力（宿主自带，管家零配置直接用）；
 *  - 这里的凭证只用于访问第三方官网的订阅账户用量接口，必须由用户自己提供，
 *    形态按平台而定（API key / 浏览器会话 key / OAuth token）。
 *
 * 存储策略（v0.2 起）：**以本文件为唯一权威**，放在 `<数据目录>/credentials.json`，
 * 写盘用 tmp + rename 原子替换并 chmod 0600。
 *
 * 为什么不再把明文写进宿主的 credentials 服务：
 * 宿主的 `credentials.readRecord/modifyRecord` 都是 async，而额度引擎的读取路径是同步的
 * （`has()`/`get()` 在构造计划视图时就要给出结果）。早期版本把写入丢给服务、文件里只留
 * `{storedIn:'credentials'}` 标记，结果 `get()` 读不到值、`has()` 却为真，Authorization 会发出
 * `Bearer credentials` 这种垃圾。这里改成「文件权威 + 一次性异步搬迁」：
 * 启动时 `migrate()` 把以前留在宿主服务里的值搬到文件，之后一律读文件。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { safeText } from './util.js';

const SECRET_KEYS = ['value', 'secret', 'token', 'credential', 'key'];

/**
 * 只允许管家自己命名空间下的键：`butler.quota.*`。
 * 这样即使调用方传来别的键，也碰不到宿主/别的插件存的凭证。
 */
const REF_PREFIX = 'butler.quota.';

function safeRef(ref) {
  const key = safeText(ref, 200);
  if (!key || !key.startsWith(REF_PREFIX) || key.length <= REF_PREFIX.length) return null;
  return key;
}

function extractSecret(record) {
  if (record === undefined || record === null) return undefined;
  if (typeof record === 'string') return record;
  if (typeof record !== 'object') return undefined;
  // 我们自己写过的「只记录位置」标记对象，绝不能当成密钥
  if (record.storedIn) return undefined;
  for (const key of SECRET_KEYS) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  const strings = Object.values(record).filter((value) => typeof value === 'string' && value);
  return strings.length === 1 ? strings[0] : undefined;
}

export function createCredentials({ ctx, dir, logger }) {
  const filePath = dir ? `${dir}/credentials.json` : null;
  let cache = null;
  let lastError = null;
  let migrated = false;

  function service() {
    try {
      // Cordis 里访问未 inject 的服务属性会抛错，只能走 ctx.get（不追踪依赖）
      const svc = typeof ctx?.get === 'function' ? ctx.get('credentials') : null;
      return svc && typeof svc.readRecord === 'function' ? svc : null;
    } catch {
      return null;
    }
  }

  function readFile() {
    if (cache !== null) return cache;
    cache = {};
    if (!filePath || !existsSync(filePath)) return cache;
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      lastError = `读取凭证文件失败：${error?.message || error}`;
      return cache;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是对象');
      // 丢掉落单版本留下的标记对象（里面没有密钥）
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object' && value.storedIn) continue;
        const secret = extractSecret(value);
        if (secret) cache[key] = secret;
      }
    } catch (error) {
      // 文件坏了：备份一份再重建，避免用户彻底失去线索
      lastError = `凭证文件损坏，已备份并重建：${error?.message || error}`;
      logger?.warn?.('[butler] ' + lastError);
      try {
        renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch { /* 备份失败就算了，别阻断启动 */ }
    }
    return cache;
  }

  function writeFile(map) {
    if (!filePath) return false;
    const tmp = `${filePath}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
      try { chmodSync(tmp, 0o600); } catch { /* Windows 上另说 */ }
      renameSync(tmp, filePath);
      cache = map;
      lastError = null;
      return true;
    } catch (error) {
      lastError = `写入凭证文件失败：${error?.message || error}`;
      logger?.error?.('[butler] ' + lastError);
      return false;
    }
  }

  return {
    /** 后端标识，仅用于诊断展示。 */
    backend() {
      return 'file';
    },

    getError() {
      return lastError;
    },

    get(ref) {
      const key = safeRef(ref);
      if (!key) return undefined;
      const value = readFile()[key];
      return typeof value === 'string' && value ? value : undefined;
    },

    has(ref) {
      const value = this.get(ref);
      return typeof value === 'string' && value.length > 0;
    },

    /** 写入或清除（传空字符串/null = 清除）。返回是否真的落盘成功。 */
    set(ref, value) {
      const key = safeRef(ref);
      if (!key) return false;
      const text = value === null || value === undefined ? '' : String(value);
      const map = { ...readFile() };
      if (!text) {
        if (!(key in map)) return true;
        delete map[key];
        return writeFile(map);
      }
      if (map[key] === text) return true;
      map[key] = text;
      return writeFile(map);
    },

    /**
     * 一次性搬迁：把早期版本写进宿主 credentials 服务里的值搬到本文件。
     * 宿主服务的读取接口是 async，所以只能在启动时异步做一次（之后读取全走文件）。
     */
    async migrate(refs = []) {
      if (migrated) return 0;
      migrated = true;
      const svc = service();
      if (!svc) return 0;
      const wanted = Array.from(new Set((refs || []).map((ref) => safeRef(ref)).filter(Boolean)));
      let moved = 0;
      for (const ref of wanted) {
        if (this.get(ref)) continue;
        try {
          const record = await svc.readRecord(ref);
          const secret = extractSecret(record);
          if (!secret) continue;
          if (this.set(ref, secret)) moved += 1;
        } catch {
          /* 单条失败不阻断整体搬迁 */
        }
      }
      if (moved) logger?.info?.(`[butler] 从宿主凭证服务搬迁了 ${moved} 条额度查询凭证`);
      return moved;
    },
  };
}