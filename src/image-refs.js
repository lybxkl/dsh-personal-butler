/**
 * 从会话里找「这次用户发的图」的引用。
 *
 * 工具本身拿不到 attachmentId（模型看到的是像素），所以按 dsh-meme 的做法从会话消息里翻。
 * 两条通道都要认：
 *  - Web / 桌面：消息 content 里有 `{ type: 'image', attachment }`；
 *  - QQ 机器人：消息正文里是 `- Image: C:/Users/.../.dsh-qqbot/media/xxx.jpg`（图片落成文件路径）。
 *
 * 只看最后一条用户消息是刻意的（会话里更早的截图往往和这次的话无关），
 * 但用户常见节奏是「先发图 → 管家问两句 → 回 1 → 才落库」，
 * 所以允许往回看几条用户消息，只取**最近一条带图的消息**，且最多 RECENT_LIMIT 条。
 */


/** 递归收集正文里的远程图片地址（QQ 有时把图给成 https 链接，链接上不一定有扩展名）。 */
export function takeImageUrls(content, out = []) {
  if (typeof content === 'string') {
    for (const match of content.matchAll(/^\s*-?\s*Image:\s*(https?:\/\/\S+)\s*$/gim)) {
      out.push(match[1].trim());
    }
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text') takeImageUrls(block.text, out);
    if (block.type === 'tool-result') takeImageUrls(block.content, out);
  }
  return out;
}

/** 往回看多少条用户消息（先发图、再确认的场景通常 1~3 条就够）。 */
export const RECENT_LIMIT = 4;

/** 图片文件的扩展名白名单（QQ 通道按路径给图，别把任意文件当图读）。 */
const IMAGE_PATH_RE = /\.(?:jpe?g|png|gif|webp)$/i;

/** 递归收集 content 里的 image 块（tool-result 里也可能嵌图）。 */
export function takeImageRefs(content, out = []) {
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block && block.type === 'image' && block.attachment) out.push(block.attachment);
    if (block && block.type === 'tool-result') takeImageRefs(block.content, out);
  }
  return out;
}

/** 递归收集正文里的图片路径（QQ 机器人把图存成文件，正文里给一行 `- Image: <path>`）。 */
export function takeImagePaths(content, out = []) {
  if (typeof content === 'string') {
    for (const match of content.matchAll(/^\s*-?\s*Image:\s*(\S+)\s*$/gim)) {
      const path = match[1].trim();
      // 远程地址交给 takeImageUrls 处理，别当本地路径去读
      if (/^https?:\/\//i.test(path)) continue;
      if (IMAGE_PATH_RE.test(path)) out.push(path);
    }
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text') takeImagePaths(block.text, out);
    if (block.type === 'tool-result') takeImagePaths(block.content, out);
  }
  return out;
}

function lastUserMessages(exec, limit) {
  const session = exec?.agent?.session;
  if (!session || typeof session.deriveMessages !== 'function') return [];
  const messages = session.deriveMessages();
  const out = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const message = messages[i];
    if (message && message.role === 'user') out.push(message);
  }
  return out;
}

/** 最近一条带图用户消息里的附件引用。 */
export function lastUserMessageRefs(exec, { limit = RECENT_LIMIT } = {}) {
  for (const message of lastUserMessages(exec, limit)) {
    const refs = takeImageRefs(message.content, []);
    if (refs.length) return refs;
  }
  return [];
}

/** 最近一条带图用户消息里的本地图片路径。 */
export function lastUserMessagePaths(exec, { limit = RECENT_LIMIT } = {}) {
  const out = [];
  for (const message of lastUserMessages(exec, limit)) {
    takeImagePaths(message.content, out);
    if (out.length) return out;
  }
  return [];
}

/** 本轮该处理的用户图片：优先本轮投递，其次最近一条带图的消息。 */
export function userImageRefs(exec) {
  const out = [];
  const inbox = exec?.agent?.inbox;
  if (inbox) {
    for (const message of [...(inbox.nextTurn || []), ...(inbox.nextStep || [])]) takeImageRefs(message?.content, out);
  }
  if (out.length) return out;
  return lastUserMessageRefs(exec);
}

/** 本轮该处理的本地图片路径：优先本轮投递，其次最近一条带图的消息。 */
export function userImagePaths(exec) {
  const out = [];
  const inbox = exec?.agent?.inbox;
  if (inbox) {
    for (const message of [...(inbox.nextTurn || []), ...(inbox.nextStep || [])]) takeImagePaths(message?.content, out);
  }
  if (out.length) return out;
  return lastUserMessagePaths(exec);
}
/** 最近一条带图用户消息里的远程图片地址。 */
export function lastUserMessageUrls(exec, { limit = RECENT_LIMIT } = {}) {
  const out = [];
  for (const message of lastUserMessages(exec, limit)) {
    takeImageUrls(message.content, out);
    if (out.length) return out;
  }
  return [];
}

/** 本轮该处理的远程图片地址：优先本轮投递，其次最近一条带图的消息。 */
export function userImageUrls(exec) {
  const out = [];
  const inbox = exec?.agent?.inbox;
  if (inbox) {
    for (const message of [...(inbox.nextTurn || []), ...(inbox.nextStep || [])]) takeImageUrls(message?.content, out);
  }
  if (out.length) return out;
  return lastUserMessageUrls(exec);
}
