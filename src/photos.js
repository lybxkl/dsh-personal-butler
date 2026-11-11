/**
 * 物品照片的本地保管。
 *
 * 会话里的图片是「附件」，会随会话/清理变化；用户要的是「过几个月还能翻出来看」，
 * 所以这里把字节复制到管家自己的数据目录（<dataDir>/photos/<photoId>.<ext>），
 * 面板通过 /butler/api/photo/<id> 读取。记录本身（mime/大小/归属）存在 store 的 photos 表。
 *
 * 安全约定（都对应一次真实审查发现）：
 * - 只接受真的图片字节（magic bytes 嗅探），不信任附件元数据里的 mediaType；
 * - 文件名完全由服务端生成，且读取/删除前必须校验仍落在 photos 目录内；
 * - 响应头里的 content-type 只从扩展名白名单推导，绝不采信记录里的 mime；
 * - 有总量上限（张数/字节），启动时反向清理没有记录的文件；
 * - 配了 apiToken 时，图片 URL 带 HMAC 签名（<img> 带不了请求头）。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { newId, nowIso, safeText } from './util.js';

/** 引用太长时取哈希：normalizePhoto 只留 200 字符，截断后的 key 永远对不上。 */
function shortKey(prefix, value) {
  const text = String(value || '');
  if (text.length <= 120) return `${prefix}${text}`;
  return `${prefix}${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
}

/** 键排序后再序列化：同一份 ref 只有键顺序不同时不能被算成两张不同的图。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** 附件引用的稳定身份：同一张图被重复保存时按它去重。 */
function refIdOf(ref) {
  const id = String(ref?.attachmentId ?? ref?.id ?? ref?.sha256 ?? '').trim();
  if (id) return shortKey('attach:', id);
  return shortKey('attach:', stableStringify(ref ?? {}));
}

/** 主机是不是本机 / 内网：图片链接来自聊天正文，不能让它变成打内网的跳板。 */
function hostIsPrivate(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (!host.includes(':')) {
    const parts = host.split('.');
    if (parts.length !== 4 || parts.some((x) => !/^\d{1,3}$/.test(x))) return !host.includes('.'); // 单标签主机名也拒
    const nums = parts.map(Number);
    if (nums.some((x) => x > 255)) return true;
    const [a, b] = nums;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (host === '::1' || host === '::') return true;
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  return false;
}

export const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
/** 整个 photos 表的上限：防止本机任意进程反复投图把磁盘写满。 */
export const MAX_TOTAL_PHOTOS = 300;
// 单张放宽到 50MB 之后，300MB 只够存几张：总量跟着放到 1GB，仍然挡住「无限灌图」
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 记录里的文件名必须长这样：服务端生成，不含任何路径成分。 */
export const PHOTO_FILE_RE = /^ph_[a-z0-9]+\.(?:jpg|png|gif|webp)$/;

/** 按 magic bytes 判真实类型：JPEG/PNG/GIF/WebP，认不出返回 ''。 */
export function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  return '';
}

function extOf(file) {
  const name = String(file || '');
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function sign(id, exp, secret) {
  return createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
}

/** 校验图片 URL 上的签名（配了 apiToken 时用，`<img src>` 带不了请求头）。 */
export function verifyPhotoSignature(id, query, secret) {
  if (!secret) return true;
  const exp = Number(query?.exp);
  const sig = String(query?.sig || '');
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const expected = sign(id, exp, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createPhotos({ dir, store, logger, secret = '', fetchImpl = null, fileRoots = null, maxBytes = MAX_PHOTO_BYTES }) {
  // 单张上限可注入：测试用一个小值就能覆盖「超限」分支，不必真的写 50MB 文件
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_PHOTO_BYTES;
  const sizeError = (bytes) => `图片太大了（${Math.round(bytes / 1024)}KB，上限 ${Math.round(limit / 1024 / 1024 * 10) / 10}MB）`;
  const root = join(dir, 'photos');
  try {
    // 和账本一致：只有当前用户能进/能读
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    logger?.warn?.(`butler: 照片目录创建失败 ${root}: ${error?.message || error}`);
  }
  const rootAbs = resolve(root);
  // 允许从哪些目录读本地图片：QQ 机器人下载目录、临时目录、当前工作目录。
  // 路径来自聊天正文（外部输入），不设边界就等于让任何能发消息的人读本机任意图片文件。
  const allowedFileRoots = (Array.isArray(fileRoots) && fileRoots.length ? fileRoots : [tmpdir(), process.cwd()])
    .map((item) => resolve(String(item)));

  /** 把记录解析成绝对路径；文件名不合法或逃出目录一律当不存在。 */
  function filePath(record) {
    const file = String(record?.file || '');
    if (!PHOTO_FILE_RE.test(file)) return null;
    const abs = resolve(rootAbs, file);
    return dirname(abs) === rootAbs ? abs : null;
  }

  function totalUsage() {
    const records = store.list('photos');
    let bytes = 0;
    for (const record of records) bytes += Math.max(0, Number(record.byteSize) || 0);
    return { count: records.length, bytes };
  }

  /**
   * 落盘并登记；返回 photos 记录。
   * 带 refId 时先去重：同一张图被保存多次（用户重说一遍、模型重复调用）只留一份。
   */
  function saveBuffer({ data, mime, itemId = null, refId = null }) {
    if (refId) {
      const seen = store.list('photos').find((photo) => photo.refId === refId);
      if (seen) return seen;
    }
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (!buffer.length) throw new Error('图片是空的');
    if (buffer.length > limit) throw new Error(sizeError(buffer.length));
    // 只认字节能嗅探出来的真图片：附件/前端声明的 mediaType 都不可信
    const sniffed = sniffImageMime(buffer);
    if (!sniffed) throw new Error('这不是能识别的图片（只支持 jpg / png / gif / webp）');

    const usage = totalUsage();
    if (usage.count >= MAX_TOTAL_PHOTOS) {
      throw new Error(`照片已经存满 ${MAX_TOTAL_PHOTOS} 张了，先在面板里删掉一些不再需要的再传`);
    }
    if (usage.bytes + buffer.length > MAX_TOTAL_BYTES) {
      throw new Error(`照片总量已到上限（${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB），先删掉一些再传`);
    }

    const id = newId('ph');
    const file = `${id}${MIME_EXT[sniffed]}`;
    const abs = join(rootAbs, file);
    writeFileSync(abs, buffer, { mode: 0o600 });
    const record = store.put('photos', { id, file, mime: sniffed, byteSize: buffer.length, itemId, refId, createdAt: nowIso() });
    // put 之后如果落盘失败，记录会留在内存里却读不到字节 —— 这里回溯删掉，别留烂账
    const saved = typeof store.save === 'function' ? store.save() : true;
    if (saved === false) {
      try {
        if (existsSync(abs)) unlinkSync(abs);
      } catch {
        /* 已经尽力 */
      }
      store.remove('photos', id);
      throw new Error('照片存盘失败（磁盘可能满了），这次没有保存成功');
    }
    return record;
  }

  /** 从会话附件复制一份（附件本身随时可能被清理）。 */
  async function saveFromRef(ref, { attachments, itemId = null } = {}) {
    if (!attachments || typeof attachments.readImage !== 'function') throw new Error('当前宿主没有附件服务，读不到这张图');
    const stored = await attachments.readImage(ref);
    const buffer = stored?.data;
    const mime = String(stored?.ref?.mediaType || ref?.mediaType || '');
    return saveBuffer({ data: buffer, mime, itemId, refId: refIdOf(ref) });
  }

  /**
   * 从本地文件保存（QQ 机器人就是这种：消息里给的是 `.dsh-qqbot/media/xxx.jpg` 路径）。
   * 只读这一个文件，超限直接拒绝，不把整个目录扫一遍。
   */
  function saveFile(filePath, { itemId = null } = {}) {
    const input = String(filePath || '');
    // UNC 与设备路径（\\attacker\share\a.png、\\.\pipe、\\?\...）会让 Windows 去连远端主机：
    // 一条聊天消息就能把进程卡在 SMB 凭据握手上，还会向对方泄露 NTLM。直接拒绝。
    if (/^[\\/]{2}/.test(input) || /^\\[.?]\\/.test(input)) {
      throw new Error('不支持网络共享或设备路径的图片，请先把图存到本地');
    }
    const raw = resolve(input);
    let abs;
    try {
      // realpath 解开符号链接：否则一个指向系统文件的链接就能绕过下面的目录检查
      abs = realpathSync(raw);
    } catch {
      throw new Error('读不到这张图（文件不存在或没有权限）');
    }
    const inside = allowedFileRoots.some((base) => abs === base || abs.startsWith(base + sep));
    // QQ 机器人把图放在 <home>/.dsh-qqbot/...，不一定在 tmp/cwd 之下，单独放行这一层
    const qqMedia = `${sep}.dsh-qqbot${sep}`;
    if (!inside && !abs.includes(qqMedia)) {
      throw new Error('只能读取 QQ 机器人下载目录、临时目录或工作目录里的图片');
    }
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      throw new Error('读不到这张图（文件不存在或没有权限）');
    }
    if (!stat.isFile()) throw new Error('这不是一个图片文件');
    if (stat.size > limit) throw new Error(sizeError(stat.size));
    const buffer = readFileSync(abs);
    return saveBuffer({ data: buffer, itemId, refId: shortKey('file:', abs) });
  }

  /**
   * 从远程地址保存（QQ 机器人有时把图片给成 https://multimedia.nt.qq.com.cn/download?... 这种链接）。
   * 只接受 http/https，超时 + 体积上限，重定向逐跳校验协议；拿到的字节仍然要过 magic bytes 嗅探。
   */
  async function saveUrl(rawUrl, { itemId = null, timeoutMs = 5 * 60 * 1000 } = {}) {
    const doFetch = fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') throw new Error('当前宿主没有可用的网络请求能力，读不了这个图片链接');
    let current;
    try {
      current = new URL(String(rawUrl || ''));
    } catch {
      throw new Error('图片链接格式不对');
    }
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('图片链接只支持 http/https');
    if (hostIsPrivate(current.hostname)) throw new Error('这个链接指向本机或内网地址，出于安全考虑不下载');
    // 先查重再下载：同一条链接被重复处理时不必再发一次请求。身份用最终判断前的 URL，跳转不会改变它
    const key = shortKey('url:', current.href);
    const seen = store.list('photos').find((photo) => photo.refId === key);
    if (seen) return seen;
    for (let hop = 0; hop <= 3; hop += 1) {
      const response = await doFetch(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'image/*' },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel?.().catch?.(() => {});
        const location = response.headers?.get?.('location');
        if (!location) throw new Error(`图片链接跳转没有目标（HTTP ${response.status}）`);
        const next = new URL(location, current);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('图片链接跳转到了不支持的协议');
        current = next;
        continue;
      }
      if (!response.ok) throw new Error(`下载图片失败（HTTP ${response.status}）`);
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > limit) throw new Error(sizeError(declared));
      const buffer = await readBodyLimited(response, limit);
      return saveBuffer({ data: buffer, itemId, refId: key });
    }
    throw new Error('图片链接跳转太多次了（最多 3 跳）');
  }

  /** 读响应体并守住体积上限：不能先 text() 再判大小。 */
  async function readBodyLimited(response, limit) {
    const reader = response.body?.getReader?.();
    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > limit) throw new Error(`图片太大了（${Math.round(buffer.length / 1024)}KB，上限 ${limit / 1024 / 1024}MB）`);
      return buffer;
    }
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          throw new Error(`图片太大了（超过上限 ${limit / 1024 / 1024}MB），已中止`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks);
  }

  /** 面板上传走 data:image/...;base64,xxxx。 */
  function saveDataUrl(dataUrl) {
    const text = String(dataUrl || '');
    const match = /^data:(image\/[a-z+]+);base64,([\s\S]+)$/i.exec(text);
    if (!match) throw new Error('图片数据格式不对（需要 data:image/...;base64）');
    const buffer = Buffer.from(match[2], 'base64');
    return saveBuffer({ data: buffer, mime: match[1] });
  }

  function find(id) {
    return store.find('photos', id) || null;
  }

  /**
   * 复制一张已存照片（同一张图要挂到另一个物件上时用）。
   * 新记录的 refId 记成 `copy:<来源>:<物件>`：同一个物件再存一次同一来源时能认出来，
   * 直接复用这一份，不会越复制越多；同时它又不会被原图的去重键误伤。
   */
  function copy(record, { itemId = null } = {}) {
    const loaded = read(record?.id);
    if (!loaded) throw new Error('原照片读不到了（可能已经被删）');
    const source = record?.refId || record?.id || 'unknown';
    const refId = itemId ? `copy:${source}:${itemId}` : null;
    const existing = refId ? findByRef(refId) : null;
    if (existing) return existing;
    return saveBuffer({ data: loaded.buffer, mime: loaded.mime, itemId, refId });
  }

  /** 按来源身份查已存照片（附件 id / 本地路径 / 远程链接）。 */
  function findByRef(refId) {
    if (!refId) return null;
    return store.list('photos').find((photo) => photo.refId === refId) || null;
  }

  /** 读取字节，供路由回给浏览器；任何异常都当成「没有这张图」。 */
  function read(id) {
    const record = find(id);
    if (!record) return null;
    const path = filePath(record);
    if (!path) return null;
    // content-type 只从扩展名白名单推导：记录里的 mime 可能被改过，绝不拿来做响应头
    const mime = EXT_MIME[extOf(record.file)];
    if (!mime) return null;
    try {
      if (!existsSync(path)) return null;
      return { buffer: readFileSync(path), mime };
    } catch {
      return null;
    }
  }

  function remove(id) {
    const record = find(id);
    if (!record) return false;
    const path = filePath(record);
    if (path) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (error) {
        logger?.warn?.(`butler: 删除照片失败 ${path}: ${error?.message || error}`);
      }
    }
    store.remove('photos', id);
    return true;
  }

  function countFor(itemId) {
    return store.list('photos').filter((p) => p.itemId === itemId).length;
  }

  /**
   * 启动时对账：
   * - 记录对应的文件不见了 / 文件名不合法 → 清掉记录（别让面板显示永远加载不出来的图）；
   * - 归属的物件已经不在了 → 解绑；
   * - 磁盘上有文件但没有任何记录引用 → 删掉（写失败留下的裸文件）。
   * 注意先复制一份列表：store.list 返回内部活数组，边遍历边删会跳记录。
   */
  function reconcile() {
    let dropped = 0;
    let detached = 0;
    let orphans = 0;
    const records = [...store.list('photos')];
    const referenced = new Set();
    for (const record of records) {
      const path = filePath(record);
      if (!path || !existsSync(path)) {
        store.remove('photos', record.id);
        dropped += 1;
        continue;
      }
      referenced.add(record.file);
      if (record.itemId && !store.find('items', record.itemId)) {
        store.patch('photos', record.id, { itemId: null });
        detached += 1;
      }
    }
    try {
      for (const file of readdirSync(rootAbs)) {
        if (!PHOTO_FILE_RE.test(file)) continue;
        if (referenced.has(file)) continue;
        try {
          unlinkSync(join(rootAbs, file));
          orphans += 1;
        } catch {
          /* 删不掉就算了，下次再试 */
        }
      }
    } catch {
      /* 目录读不了就不用管孤儿文件 */
    }
    if (dropped || detached || orphans) {
      logger?.info?.(`butler: 照片对账完成（清掉失效 ${dropped} 条，解除归属 ${detached} 条，清理孤儿文件 ${orphans} 个）`);
    }
    // 记录被清掉后，item.photoIds 里的死链也要摘掉：否则「12 张上限」会被幽灵 id 占名额
    const live = new Set(store.list('photos').map((p) => p.id));
    let unlinked = 0;
    for (const item of [...store.list('items')]) {
      const ids = item.photoIds || [];
      const clean = ids.filter((id) => live.has(id));
      if (clean.length !== ids.length) {
        store.patch('items', item.id, { photoIds: clean });
        unlinked += 1;
      }
    }
    if (unlinked) logger?.info?.(`butler: ${unlinked} 件物品的照片引用已清理`);
    return { dropped, detached, orphans, unlinked };
  }

  /** 面板用的图片元数据（不带字节）；配了 apiToken 时附带一次性签名。 */
  function view(record) {
    if (!record) return null;
    const base = `/butler/api/photo/${encodeURIComponent(record.id)}`;
    if (!secret) return { id: record.id, url: base, mime: record.mime, byteSize: record.byteSize };
    const exp = Date.now() + 6 * 60 * 60 * 1000;
    const query = `exp=${exp}&sig=${sign(record.id, exp, secret)}`;
    return { id: record.id, url: `${base}?${query}`, mime: record.mime, byteSize: record.byteSize };
  }

  return { root, saveBuffer, saveFromRef, saveFile, saveUrl, saveDataUrl, find, findByRef, copy, read, remove, countFor, reconcile, view, totalUsage };
}

/** 面板用的图片元数据（不带签名；需要带签名时用 createPhotos(...).view）。 */
export function photoView(record) {
  if (!record) return null;
  return {
    id: record.id,
    url: `/butler/api/photo/${encodeURIComponent(record.id)}`,
    mime: record.mime,
    byteSize: record.byteSize,
  };
}

/** 物件的位置描述：「柜子第 2 层」这种 detail 拼在 location 后面。 */
export function placeLabel(item) {
  const location = safeText(item?.location, 120);
  const detail = safeText(item?.detail, 120);
  if (location && detail) return `${location} · ${detail}`;
  return location || detail || '';
}