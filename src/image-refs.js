/**
 * 从会话里找「这次用户发的图」的引用。
 *
 * 工具本身拿不到 attachmentId（模型看到的是像素），所以按 dsh-meme 的做法从会话消息里翻。
 * 三种通道都要认：
 *  - Web / 桌面：消息 content 里有 `{ type: 'image', attachment }`；
 *  - QQ 本地文件：正文里是 `- Image: C:/Users/.../.dsh-qqbot/media/xxx.jpg`；
 *  - QQ 远程链接：正文里是 `- Image: https://multimedia.nt.qq.com.cn/download?...`。
 *
 * 选消息的规则（三个来源共用，避免「附件取到上一条、路径取到这一条」）：
 *  1. 本轮投递（inbox.nextTurn / nextStep）里有图，就只看本轮；
 *  2. 否则往回看最近 RECENT_LIMIT 条用户消息，取**最近一条带图的消息**，只从这一条里抽。
 * 定时提醒/变更通知不算「用户发图」，扫描时整条跳过。
 *
 * 安全约定：只扫用户消息里的 text 块，不递归 tool-result ——
 * 否则一个被抓取的网页写一行 `Image: http://127.0.0.1/...` 就能让管家去读本机文件/打内网。
 */

/** 往回看多少条用户消息（先发图、再确认的场景通常 1~3 条就够；留些余量给「问两句再回」）。 */
export const RECENT_LIMIT = 8;

/** 图片文件的扩展名白名单（QQ 通道按路径给图，别把任意文件当图读）。 */
const IMAGE_PATH_RE = /\.(?:jpe?g|png|gif|webp)$/i;

/** 这些不是用户发来的内容，扫描与计数都要跳过。 */
const NOT_USER_CONTENT_RE = /^\[(?:SCHEDULE REMINDER|SCHEDULE CHANGE)\]/i;

/** 正文里的 Image 行：允许项目符号（- * •）、全角冒号、行尾 [图片] 标记。 */
const IMAGE_LINE_RE = /^[^\S\n]*[-*•]?[^\S\n]*Image\s*[:：][^\S\n]*(.+?)[^\S\n]*$/gim;

/** 去掉引号/反引号/尖括号和行尾的 [图片]。 */
function cleanImageValue(raw) {
  let value = String(raw || '').trim();
  value = value.replace(/\s*\[(?:图片|image)\]\s*$/i, '').trim();
  value = value.replace(/^["'`<]+/, '').replace(/["'`>]+$/, '').trim();
  return value;
}

/** 一行里可能塞了两个 Image（`- Image: a.jpg - Image: b.jpg`），拆开。 */
function splitValues(raw) {
  return String(raw || '')
    .split(/[^\S\n]+[-*•]?[^\S\n]*Image\s*[:：][^\S\n]*/i)
    .map(cleanImageValue)
    .filter(Boolean);
}

function unescapeUrl(url) {
  return String(url).replace(/&amp;/gi, '&').replace(/&#38;/g, '&');
}

function textBlocks(content, out = []) {
  if (typeof content === 'string') {
    out.push(content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text);
  }
  return out;
}

/** content 里的 image 附件块（tool-result 里嵌的图也算，那是模型自己读出来的图）。 */
export function takeImageRefs(content, out = []) {
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block?.type === 'image' && block.attachment) out.push(block.attachment);
    if (block?.type === 'tool-result') takeImageRefs(block.content, out);
  }
  return out;
}

/** 正文里的本地图片路径。 */
export function takeImagePaths(content, out = []) {
  for (const text of textBlocks(content)) {
    for (const match of text.matchAll(IMAGE_LINE_RE)) {
      for (const value of splitValues(match[1])) {
        // 远程地址交给 takeImageUrls 处理，别当本地路径去读
        if (/^https?:\/\//i.test(value)) continue;
        if (IMAGE_PATH_RE.test(value)) out.push(value);
      }
    }
  }
  return out;
}

/** 正文里的远程图片地址。 */
export function takeImageUrls(content, out = []) {
  for (const text of textBlocks(content)) {
    for (const match of text.matchAll(IMAGE_LINE_RE)) {
      for (const value of splitValues(match[1])) {
        if (/^https?:\/\//i.test(value)) out.push(unescapeUrl(value));
      }
    }
  }
  return out;
}

function messageHasImage(message) {
  const content = message?.content;
  return takeImageRefs(content).length > 0
    || takeImagePaths(content).length > 0
    || takeImageUrls(content).length > 0;
}

function inboxMessages(exec) {
  const inbox = exec?.agent?.inbox;
  if (!inbox) return [];
  return [...(inbox.nextTurn || []), ...(inbox.nextStep || [])];
}

function isNotUserContent(message) {
  return textBlocks(message?.content || []).some((text) => NOT_USER_CONTENT_RE.test(text.trim()));
}

function recentUserMessages(exec, limit) {
  const session = exec?.agent?.session;
  if (!session || typeof session.deriveMessages !== 'function') return [];
  const messages = session.deriveMessages();
  const out = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    if (isNotUserContent(message)) continue;
    out.push(message);
  }
  return out;
}

/** 选定的消息集合：本轮投递，或最近一条带图的历史消息。 */
function pickedMessages(exec, limit = RECENT_LIMIT) {
  const inbox = inboxMessages(exec);
  if (inbox.some(messageHasImage)) return inbox;
  for (const message of recentUserMessages(exec, limit)) {
    if (messageHasImage(message)) return [message];
  }
  return [];
}

export function userImageRefs(exec) {
  const out = [];
  for (const message of pickedMessages(exec)) takeImageRefs(message?.content, out);
  return out;
}

export function userImagePaths(exec) {
  const out = [];
  for (const message of pickedMessages(exec)) takeImagePaths(message?.content, out);
  return out;
}

export function userImageUrls(exec) {
  const out = [];
  for (const message of pickedMessages(exec)) takeImageUrls(message?.content, out);
  return out;
}

/** 本次相关消息里出现过 Image 字样、但一张都没解析出来（多半是格式怪/链接被截断）。 */
export function userImageMentioned(exec, limit = RECENT_LIMIT) {
  const messages = pickedMessages(exec, limit);
  const pool = messages.length ? messages : recentUserMessages(exec, 2);
  return pool.some((message) => textBlocks(message?.content || []).some((text) => /Image\s*[:：]/i.test(text)));
}

/** 兼容旧接口：最近一条带图消息里的附件 / 本地路径 / 远程地址。 */
export function lastUserMessageRefs(exec, { limit = RECENT_LIMIT } = {}) {
  const out = [];
  for (const message of recentUserMessages(exec, limit)) {
    takeImageRefs(message?.content, out);
    if (out.length) return out;
  }
  return out;
}

export function lastUserMessagePaths(exec, { limit = RECENT_LIMIT } = {}) {
  const out = [];
  for (const message of recentUserMessages(exec, limit)) {
    takeImagePaths(message?.content, out);
    if (out.length) return out;
  }
  return out;
}

export function lastUserMessageUrls(exec, { limit = RECENT_LIMIT } = {}) {
  const out = [];
  for (const message of recentUserMessages(exec, limit)) {
    takeImageUrls(message?.content, out);
    if (out.length) return out;
  }
  return out;
}