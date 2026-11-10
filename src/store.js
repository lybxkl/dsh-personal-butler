/**
 * 管家自有的 JSON 存储。
 *
 * 为什么不用 ctx.storageDomain：它要求 zod 风格 schema 且是实验期接口，
 * 本地 bundle 引入它是纯风险；管家数据量小（几百条记录）、单进程写，
 * 用「内存权威 + 原子落盘」既简单又足够。
 *
 * 语义：
 *  - 读 = 内存同步（load 后即可读）
 *  - 写 = 先改内存、再原子写盘（tmp + rename），失败则回滚内存
 *  - 文件损坏 = 归档成 .corrupt-<ts> 后重建，绝不让插件起不来
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { nowIso, newId, pick, toIso, toNumber, safeText } from './util.js';

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = ['assets', 'plans', 'todos', 'debts', 'items', 'photos', 'snapshots', 'alerts', 'kinds', 'sources'];

const ID_PREFIX = {
  assets: 'asset',
  plans: 'plan',
  todos: 'todo',
  debts: 'debt',
  items: 'item',
  photos: 'ph',
  snapshots: 'snap',
  alerts: 'alert',
  kinds: 'kind',
  sources: 'custom:src',
};

function emptyData() {
  return {
    version: SCHEMA_VERSION,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    assets: [],
    plans: [],
    todos: [],
    debts: [],
    items: [],
    photos: [],
    snapshots: [],
    alerts: [],
    kinds: [],
    sources: [],
    meta: {},
  };
}

/* --------------------------- 记录归一化 --------------------------- */

const PRIORITIES = ['low', 'normal', 'high'];
const CYCLES = ['monthly', 'quarterly', 'yearly', 'weekly', 'once'];

/** 截图里常见的是中文周期，先归一化再校验。 */
const CYCLE_ALIAS = {
  monthly: 'monthly', month: 'monthly', '每月': 'monthly', '每个月': 'monthly', '月付': 'monthly', '按月': 'monthly', m: 'monthly',
  quarterly: 'quarterly', quarter: 'quarterly', '每季': 'quarterly', '每季度': 'quarterly', '季付': 'quarterly', q: 'quarterly',
  yearly: 'yearly', annual: 'yearly', annually: 'yearly', year: 'yearly', '每年': 'yearly', '年付': 'yearly', '按年': 'yearly', '包年': 'yearly', y: 'yearly',
  weekly: 'weekly', week: 'weekly', '每周': 'weekly', '周付': 'weekly', w: 'weekly',
  once: 'once', oneoff: 'once', 'one-time': 'once', '一次性': 'once', '单次': 'once', '买断': 'once',
};

function normalizeCycle(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (CYCLE_ALIAS[raw]) return CYCLE_ALIAS[raw];
  const stripped = raw.replace(/\s+/g, '').replace(/每|付$|期$/g, '');
  if (CYCLE_ALIAS[stripped]) return CYCLE_ALIAS[stripped];
  if (CYCLES.includes(raw)) return raw;
  // 认不出来的周期不能猜成「每月」：那会把 240 元/年算成 240 元/月（年化虚高 12 倍）。
  // 保守当成「一次性」，至少不会凭空产生续费与月成本。
  return 'once';
}

/** 金额上限：既防止 Infinity/1e308 污染汇总，也够覆盖任何正常订阅。 */
const MAX_AMOUNT = 1e12;

function normalizeAmount(value) {
  const n = toNumber(value, 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_AMOUNT, n));
}

/** 枚举容错：trim + 小写 + 别名；认不出来返回 null 交给调用方决定。 */
function normalizeEnum(value, allowed, alias = {}) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (alias[raw]) return alias[raw];
  const compact = raw.replace(/[\s_-]+/g, '');
  if (alias[compact]) return alias[compact];
  for (const candidate of allowed) {
    if (compact === candidate.toLowerCase().replace(/[\s_-]+/g, '')) return candidate;
  }
  return null;
}

/** 阈值必须是 0~1；warn 不能高于 critical（否则永远只报 critical）。 */
function clampThresholds(raw) {
  const read = (value, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
  };
  const warn = read(raw?.warn, 0.8);
  const critical = read(raw?.critical, 0.95);
  return warn <= critical ? { warn, critical } : { warn, critical: warn };
}

/** 可空的数值字段：null/空串保持 null，别把「没设置」变成 0。 */
function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeAsset(raw, defaults = {}) {
  const currency = String(raw.currency || defaults.currency || 'CNY').toUpperCase().slice(0, 8);
  return {
    id: String(raw.id || newId(ID_PREFIX.assets)),
    kind: safeText(raw.kind || 'subscription', 40).toLowerCase() || 'subscription',
    name: safeText(raw.name || '未命名订阅', 120),
    vendor: safeText(raw.vendor, 120),
    amount: normalizeAmount(raw.amount),
    currency,
    cycle: normalizeCycle(raw.cycle),
    startedAt: toIso(raw.startedAt),
    expiresAt: toIso(raw.expiresAt),
    autoRenew: raw.autoRenew !== false,
    notes: safeText(raw.notes, 2000),
    source: safeText(raw.source || 'manual', 20),
    tags: Array.isArray(raw.tags) ? Array.from(new Set(raw.tags.map((t) => safeText(t, 40)).filter(Boolean))).slice(0, 12) : [],
    reminder: raw.reminder && typeof raw.reminder === 'object' ? raw.reminder : null,
    createdAt: toIso(raw.createdAt) || nowIso(),
    updatedAt: toIso(raw.updatedAt) || nowIso(),
  };
}

export function normalizePlan(raw, defaults = {}) {
  const windows = Array.isArray(raw.windows) ? raw.windows.map(normalizeWindow).filter(Boolean) : [];
  return {
    id: String(raw.id || newId(ID_PREFIX.plans)),
    assetId: raw.assetId ? String(raw.assetId) : null,
    name: safeText(raw.name || '未命名额度', 120),
    provider: safeText(raw.provider || 'generic', 40),
    planLabel: safeText(raw.planLabel, 80),
    sourceId: safeText(raw.sourceId || raw.provider || 'generic', 60),
    credentialRef: safeText(raw.credentialRef || `butler.quota.${raw.id || 'default'}`, 200),
    hasCredential: Boolean(raw.hasCredential),
    status: ['ok', 'unknown', 'error', 'no-credential'].includes(raw.status) ? raw.status : 'unknown',
    error: raw.error ? safeText(raw.error, 500) : null,
    lastCheckedAt: toIso(raw.lastCheckedAt),
    thresholds: clampThresholds(raw.thresholds),
    windows,
    raw: raw.raw && typeof raw.raw === 'object' ? raw.raw : null,
    createdAt: toIso(raw.createdAt) || nowIso(),
    updatedAt: toIso(raw.updatedAt) || nowIso(),
  };
}

export function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const limit = nullableNumber(raw.limit);
  const used = nullableNumber(raw.used);
  let remaining = nullableNumber(raw.remaining);
  if (remaining === null && limit !== null && used !== null) remaining = Math.max(0, limit - used);
  let percent = nullableNumber(raw.percent);
  if (percent === null && limit !== null && limit > 0 && used !== null) percent = used / limit;
  if (percent !== null) percent = Math.max(0, Math.min(1, percent));
  return {
    key: safeText(raw.key || 'window', 40) || 'window',
    label: safeText(raw.label || raw.key || '额度', 60),
    limit,
    used,
    remaining,
    unit: ['requests', 'usd', 'cny', 'tokens', 'percent', 'calls', 'credits'].includes(raw.unit) ? raw.unit : 'requests',
    percent,
    resetAt: toIso(raw.resetAt),
  };
}

export function normalizeTodo(raw, defaults = {}) {
  return {
    id: String(raw.id || newId(ID_PREFIX.todos)),
    title: safeText(raw.title || '未命名待办', 200),
    detail: safeText(raw.detail, 4000),
    direction: normalizeEnum(raw.direction, ['awaiting_me', 'waiting_other'], {
      me: 'awaiting_me',
      myself: 'awaiting_me',
      我要做: 'awaiting_me',
      自己做: 'awaiting_me',
      other: 'waiting_other',
      waiting: 'waiting_other',
      等别人: 'waiting_other',
      我在等: 'waiting_other',
    }) || 'awaiting_me',
    counterpart: safeText(raw.counterpart, 80),
    dueAt: toIso(raw.dueAt),
    // 枚举一律先 trim/小写再判断：'done ' 这种尾空格不能被静默改回 pending
    status: normalizeEnum(raw.status, ['pending', 'done', 'cancelled'], {
      todo: 'pending',
      open: 'pending',
      待办: 'pending',
      未完成: 'pending',
      finished: 'done',
      complete: 'done',
      completed: 'done',
      已完成: 'done',
      cancel: 'cancelled',
      已取消: 'cancelled',
      dropped: 'cancelled',
    }) || 'pending',
    priority: normalizeEnum(raw.priority, PRIORITIES, { 高: 'high', 中: 'normal', 低: 'low' }) || 'normal',
    source: safeText(raw.source || 'manual', 20),
    confirmed: raw.confirmed !== false,
    advanceMinutes: nullableNumber(raw.advanceMinutes),
    reminder: raw.reminder && typeof raw.reminder === 'object' ? raw.reminder : null,
    createdAt: toIso(raw.createdAt) || nowIso(),
    updatedAt: toIso(raw.updatedAt) || nowIso(),
  };
}

export function normalizeDebt(raw, defaults = {}) {
  const currency = String(raw.currency || defaults.currency || 'CNY').toUpperCase().slice(0, 8);
  return {
    id: String(raw.id || newId(ID_PREFIX.debts)),
    // 方向不能猜错：「别人欠我」被记成「我欠别人」会连提醒都反着发。
    // 认不出来时用文档承诺的默认值 owedToMe（不是 iOwe）。
    direction: normalizeEnum(raw.direction, ['owedToMe', 'iOwe'], {
      owedtome: 'owedToMe',
      owed_to_me: 'owedToMe',
      '别人欠我': 'owedToMe',
      '他欠我': 'owedToMe',
      '欠我': 'owedToMe',
      receivable: 'owedToMe',
      lent: 'owedToMe',
      iowe: 'iOwe',
      i_owe: 'iOwe',
      '我欠别人': 'iOwe',
      '我欠': 'iOwe',
      payable: 'iOwe',
      borrowed: 'iOwe',
    }) || 'owedToMe',
    counterpart: safeText(raw.counterpart || '未知对方', 80),
    amount: normalizeAmount(raw.amount),
    currency,
    dueAt: toIso(raw.dueAt),
    status: normalizeEnum(raw.status, ['open', 'settled'], {
      settled: 'settled',
      done: 'settled',
      closed: 'settled',
      paid: 'settled',
      已还: 'settled',
      已结清: 'settled',
      unpaid: 'open',
      pending: 'open',
      未还: 'open',
    }) || 'open',
    note: safeText(raw.note, 2000),
    source: safeText(raw.source || 'manual', 20),
    advanceMinutes: nullableNumber(raw.advanceMinutes),
    settledAt: toIso(raw.settledAt),
    reminder: raw.reminder && typeof raw.reminder === 'object' ? raw.reminder : null,
    createdAt: toIso(raw.createdAt) || nowIso(),
    updatedAt: toIso(raw.updatedAt) || nowIso(),
  };
}

/** 物品收纳：家里东西放哪儿了。photoIds 指向 photos 集合（图片字节存在数据目录里）。 */
export function normalizeItem(raw) {
  const photos = Array.isArray(raw.photoIds) ? raw.photoIds : Array.isArray(raw.photos) ? raw.photos : [];
  const tags = Array.isArray(raw.tags) ? raw.tags : typeof raw.tags === 'string' ? String(raw.tags).split(/[,，\s]+/) : [];
  return {
    id: String(raw.id || newId(ID_PREFIX.items)),
    name: safeText(raw.name, 120),
    location: safeText(raw.location, 120),
    detail: safeText(raw.detail, 120), // 柜子第几层、哪个抽屉这类补充
    quantity: nullableNumber(raw.quantity),
    unit: safeText(raw.unit, 20),
    category: safeText(raw.category, 40),
    note: safeText(raw.note, 2000),
    tags: [...new Set(tags.map((t) => safeText(t, 24)).filter(Boolean))].slice(0, 20),
    placedAt: toIso(raw.placedAt),
    photoIds: [...new Set(photos.map((p) => safeText(p, 80)).filter(Boolean))].slice(0, 12),
    source: safeText(raw.source || 'manual', 20),
    createdAt: toIso(raw.createdAt) || nowIso(),
    updatedAt: toIso(raw.updatedAt) || nowIso(),
  };
}

/** 照片元数据；字节存 <dataDir>/photos/<file>，记录里只留路径与类型。 */
export function normalizePhoto(raw) {
  return {
    id: String(raw.id || newId(ID_PREFIX.photos)),
    file: safeText(raw.file, 120),
    mime: safeText(raw.mime || 'image/jpeg', 40),
    byteSize: nullableNumber(raw.byteSize),
    itemId: raw.itemId ? String(raw.itemId) : null,
    createdAt: toIso(raw.createdAt) || nowIso(),
  };
}

export function normalizeAlert(raw, defaults = {}) {
  return {
    id: String(raw.id || newId(ID_PREFIX.alerts)),
    dedupeKey: safeText(raw.dedupeKey, 200),
    itemKind: safeText(raw.itemKind || 'asset', 20),
    itemId: raw.itemId ? String(raw.itemId) : null,
    level: ['info', 'warn', 'critical'].includes(raw.level) ? raw.level : 'info',
    title: safeText(raw.title, 120),
    message: safeText(raw.message, 400),
    at: toIso(raw.at) || nowIso(),
    acknowledged: Boolean(raw.acknowledged),
    acknowledgedAt: toIso(raw.acknowledgedAt),
  };
}

export function normalizeKind(raw) {
  return {
    id: safeText(raw.id, 40),
    label: safeText(raw.label || raw.id, 40),
    hint: safeText(raw.hint, 200),
    collection: ['assets', 'todos', 'debts'].includes(raw.collection) ? raw.collection : 'assets',
    builtin: Boolean(raw.builtin),
    createdAt: toIso(raw.createdAt) || nowIso(),
  };
}

/** 模型写的额度源（查询代码 + 元数据）。 */
export function normalizeSource(raw = {}) {
  const hosts = Array.isArray(raw.hosts)
    ? raw.hosts
    : typeof raw.hosts === 'string'
      ? raw.hosts.split(/[,，\s]+/)
      : [];
  return {
    id: safeText(raw.id, 60),
    label: safeText(raw.label || raw.id, 60),
    vendor: safeText(raw.vendor, 60),
    needsCredential: raw.needsCredential === undefined ? true : Boolean(raw.needsCredential),
    credentialHint: safeText(raw.credentialHint, 240),
    hosts: hosts.map((host) => safeText(host, 120).toLowerCase()).filter(Boolean).slice(0, 12),
    code: String(raw.code || ''),
    notes: safeText(raw.notes, 400),
    builtin: false,
    lastTestAt: toIso(raw.lastTestAt) || null,
    lastTestOk: raw.lastTestOk === undefined ? null : Boolean(raw.lastTestOk),
    lastTestError: safeText(raw.lastTestError, 300),
    createdAt: toIso(raw.createdAt) || nowIso(),
    updatedAt: toIso(raw.updatedAt) || nowIso(),
  };
}

const NORMALIZER = {
  assets: normalizeAsset,
  plans: normalizePlan,
  todos: normalizeTodo,
  debts: normalizeDebt,
  items: normalizeItem,
  photos: normalizePhoto,
  alerts: normalizeAlert,
  kinds: normalizeKind,
  sources: normalizeSource,
};

/* ------------------------------ Store ------------------------------ */

export class Store {
  /** @param {{ filePath: string, logger?: any, defaults?: any }} options */
  constructor(options) {
    this.filePath = options.filePath;
    this.logger = options.logger || null;
    this.defaults = options.defaults || { currency: 'CNY' };
    this.data = emptyData();
    this.loaded = false;
    this.loadError = null;
    this._writing = false;
  }

  log(level, message) {
    const logger = this.logger;
    if (!logger) return;
    try {
      if (typeof logger[level] === 'function') logger[level]('[butler] ' + message);
      else if (typeof logger.info === 'function') logger.info('[butler] ' + message);
    } catch { /* 日志不该影响主流程 */ }
  }

  load() {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch (error) {
      this.loadError = `创建目录失败：${error?.message || error}`;
    }

    if (existsSync(this.filePath)) {
      try {
        const text = readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(text);
        this.data = this._migrate(parsed);
      } catch (error) {
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          copyFileSync(this.filePath, backup);
        } catch { /* 备份失败也要继续启动 */ }
        this.loadError = `存储文件损坏，已备份到 ${backup}：${error?.message || error}`;
        this.log('error', this.loadError);
        this.data = emptyData();
      }
    }

    for (const name of COLLECTIONS) {
      if (!Array.isArray(this.data[name])) this.data[name] = [];
      const normalize = NORMALIZER[name];
      if (normalize) this.data[name] = this.data[name].map((rec) => normalize(rec, this.defaults));
    }
    if (!this.data.meta || typeof this.data.meta !== 'object') this.data.meta = {};

    this.loaded = true;
    return this;
  }

  _migrate(parsed) {
    if (!parsed || typeof parsed !== 'object') return emptyData();
    const data = { ...emptyData(), ...parsed };
    // version 目前只有 1；未来加版本时在此按 v1→v2 顺序改写。
    data.version = SCHEMA_VERSION;
    return data;
  }

  save() {
    this.data.updatedAt = nowIso();
    const tmp = join(dirname(this.filePath), `.butler-${process.pid}-${Date.now()}.tmp`);
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      try { chmodSync(tmp, 0o600); } catch { /* Windows 上可能不支持 */ }
      renameSync(tmp, this.filePath);
      return true;
    } catch (error) {
      this.log('error', `写入存储失败：${error?.message || error}`);
      try { if (existsSync(tmp)) writeFileSync(tmp, '', 'utf8'); } catch { /* ignore */ }
      return false;
    }
  }

  list(name) {
    const arr = this.data[name];
    return Array.isArray(arr) ? arr : [];
  }

  find(name, id) {
    if (!id) return null;
    return this.list(name).find((rec) => rec.id === id) || null;
  }

  /** 新增或整体替换（按 id）。返回落库后的记录。 */
  put(name, record) {
    const normalize = NORMALIZER[name];
    const rec = normalize ? normalize(record, this.defaults) : { ...record };
    if (!rec.id) rec.id = newId(ID_PREFIX[name] || 'rec');
    const arr = this.list(name);
    const index = arr.findIndex((item) => item.id === rec.id);
    const now = nowIso();
    if (index >= 0) {
      const previous = arr[index];
      rec.createdAt = previous.createdAt || rec.createdAt;
      rec.updatedAt = now;
      arr[index] = rec;
    } else {
      rec.createdAt = rec.createdAt || now;
      rec.updatedAt = now;
      arr.push(rec);
    }
    this.save();
    return rec;
  }

  /** 浅合并补丁。id 不存在返回 null。 */
  patch(name, id, partial) {
    const arr = this.list(name);
    const index = arr.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const normalize = NORMALIZER[name];
    const merged = { ...arr[index], ...(partial || {}), id, updatedAt: nowIso() };
    arr[index] = normalize ? normalize(merged, this.defaults) : merged;
    this.save();
    return arr[index];
  }

  remove(name, id) {
    const arr = this.list(name);
    const index = arr.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [removed] = arr.splice(index, 1);
    this.save();
    return removed;
  }

  removeWhere(name, predicate) {
    const arr = this.list(name);
    const kept = [];
    const removed = [];
    for (const item of arr) (predicate(item) ? removed : kept).push(item);
    if (removed.length) {
      this.data[name] = kept;
      this.save();
    }
    return removed;
  }

  setMeta(key, value) {
    this.data.meta[key] = value;
    this.save();
  }

  getMeta(key, fallback = null) {
    const meta = this.data.meta;
    return meta && key in meta ? meta[key] : fallback;
  }

  /** 面板/工具读取用的不可变快照（深拷贝，防止调用方改到内存权威）。 */
  snapshot() {
    return JSON.parse(JSON.stringify({
      version: this.data.version,
      updatedAt: this.data.updatedAt,
      assets: this.data.assets,
      plans: this.data.plans,
      todos: this.data.todos,
      debts: this.data.debts,
      items: this.data.items,
      photos: this.data.photos,
      snapshots: this.data.snapshots,
      alerts: this.data.alerts,
      kinds: this.data.kinds,
      meta: this.data.meta,
    }));
  }

  /** 只保留每个 plan 最近 N 条采样。 */
  pruneSnapshots(maxPerPlan) {
    const limit = Math.max(0, Number(maxPerPlan) || 0);
    const byPlan = new Map();
    for (const snap of this.list('snapshots')) {
      const key = snap.planId || '';
      if (!byPlan.has(key)) byPlan.set(key, []);
      byPlan.get(key).push(snap);
    }
    const kept = [];
    for (const [, list] of byPlan) {
      list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      kept.push(...list.slice(0, limit));
    }
    if (kept.length !== this.list('snapshots').length) {
      this.data.snapshots = kept;
      this.save();
    }
    return kept.length;
  }
}

export function assetPatchableFields() {
  return ['kind', 'name', 'vendor', 'amount', 'currency', 'cycle', 'startedAt', 'expiresAt', 'autoRenew', 'notes', 'source', 'tags'];
}

export { pick };