/**
 * 从会话里找「这次用户发的图」的附件引用。
 *
 * 工具本身拿不到 attachmentId（模型看到的是像素），所以按 dsh-meme 的做法从会话消息里翻：
 * 先看本轮新投递的消息（inbox.nextTurn / nextStep），没有再退回「最后一条用户消息」。
 * 只看最后一条是刻意的：会话里更早的截图往往和这次的话无关，
 * 拿全量会把半年前那张图挂到新记录的物件上。
 */

/** 递归收集 content 里的 image 块（tool-result 里也可能嵌图）。 */
export function takeImageRefs(content, out = []) {
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block && block.type === 'image' && block.attachment) out.push(block.attachment);
    if (block && block.type === 'tool-result') takeImageRefs(block.content, out);
  }
  return out;
}

/** 最后一条用户消息里的图片引用（没有就返回 []）。 */
export function lastUserMessageRefs(exec) {
  const session = exec?.agent?.session;
  if (!session || typeof session.deriveMessages !== 'function') return [];
  const messages = session.deriveMessages();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === 'user') return takeImageRefs(message.content, []);
  }
  return [];
}

/** 本轮该处理的用户图片：优先本轮投递，其次最后一条用户消息。 */
export function userImageRefs(exec) {
  const out = [];
  const inbox = exec?.agent?.inbox;
  if (inbox) {
    for (const message of [...(inbox.nextTurn || []), ...(inbox.nextStep || [])]) takeImageRefs(message?.content, out);
  }
  if (out.length) return out;
  return lastUserMessageRefs(exec);
}