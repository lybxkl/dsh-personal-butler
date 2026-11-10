/**
 * 物品照片的本地保管。
 *
 * 会话里的图片是「附件」，会随会话/清理变化；用户要的是「过几个月还能翻出来看」，
 * 所以这里把字节复制到管家自己的数据目录（<dataDir>/photos/<photoId>.<ext>），
 * 面板通过 /butler/api/photo/<id> 读取。记录本身（mime/大小/归属）存在 store 的 photos 表。
 *
 * 只接受真的图片字节（按 magic bytes 嗅探），不信任附件元数据里的 mediaType。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { newId, nowIso, safeText } from './util.js';

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

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

/** 按 magic bytes 判真实类型：JPEG/PNG/GIF/WebP，认不出返回 ''。 */
export function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  return '';
}

export function createPhotos({ dir, store, logger }) {
  const root = join(dir, 'photos');
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    logger?.warn?.(`butler: 照片目录创建失败 ${root}: ${error?.message || error}`);
  }

  function filePath(record) {
    return join(root, record.file);
  }

  /** 落盘并登记；返回 photos 记录。 */
  function saveBuffer({ data, mime, itemId = null }) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (!buffer.length) throw new Error('图片是空的');
    if (buffer.length > MAX_PHOTO_BYTES) throw new Error(`图片太大了（${Math.round(buffer.length / 1024)}KB，上限 ${MAX_PHOTO_BYTES / 1024 / 1024}MB）`);
    const sniffed = sniffImageMime(buffer);
    // 只认字节能嗅探出来的真图片：附件/前端声明的 mediaType 都不可信
    if (!sniffed) throw new Error('这不是能识别的图片（只支持 jpg / png / gif / webp）');
    const finalMime = sniffed;
    const id = newId('ph');
    const file = `${id}${MIME_EXT[finalMime]}`;
    writeFileSync(join(root, file), buffer);
    return store.put('photos', { id, file, mime: finalMime, byteSize: buffer.length, itemId, createdAt: nowIso() });
  }

  /** 从会话附件复制一份（附件本身随时可能被清理）。 */
  async function saveFromRef(ref, { attachments, itemId = null } = {}) {
    if (!attachments || typeof attachments.readImage !== 'function') throw new Error('当前宿主没有附件服务，读不到这张图');
    const stored = await attachments.readImage(ref);
    const buffer = stored?.data;
    const mime = String(stored?.ref?.mediaType || ref?.mediaType || '');
    return saveBuffer({ data: buffer, mime, itemId });
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

  /** 读取字节，供路由回给浏览器。 */
  function read(id) {
    const record = find(id);
    if (!record) return null;
    const path = filePath(record);
    if (!existsSync(path)) return null;
    return { buffer: readFileSync(path), mime: EXT_MIME[record.file.slice(record.file.lastIndexOf('.'))] || record.mime };
  }

  function remove(id) {
    const record = find(id);
    if (!record) return false;
    const path = filePath(record);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (error) {
      logger?.warn?.(`butler: 删除照片失败 ${path}: ${error?.message || error}`);
    }
    store.remove('photos', id);
    return true;
  }

  function countFor(itemId) {
    return store.list('photos').filter((p) => p.itemId === itemId).length;
  }

  /**
   * 启动时对账：文件被手动删掉、或归属的物件已经不在了的记录清掉，
   * 别让面板显示一张永远加载不出来的图。只删「确定没用」的记录，不动磁盘上的多余文件。
   */
  function reconcile() {
    let dropped = 0;
    let detached = 0;
    for (const record of store.list('photos')) {
      const path = filePath(record);
      if (!record.file || !existsSync(path)) {
        store.remove('photos', record.id);
        dropped += 1;
        continue;
      }
      if (record.itemId && !store.find('items', record.itemId)) {
        store.patch('photos', record.id, { itemId: null });
        detached += 1;
      }
    }
    if (dropped || detached) logger?.info?.(`butler: 照片对账完成（清掉失效 ${dropped} 条，解除归属 ${detached} 条）`);
    return { dropped, detached };
  }

  return { root, saveBuffer, saveFromRef, saveDataUrl, find, read, remove, countFor, reconcile, photoView };
}

/** 面板用的图片元数据（不带字节）。 */
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