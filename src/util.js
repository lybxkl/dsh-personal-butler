/**
 * 纯函数工具层：时间解析、格式化、金额折算、对象处理。
 * 无副作用、无框架依赖，可被 node --test 直接单测。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function nowIso() {
  return new Date().toISOString();
}

export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function toNumber(v, fallback = 0) {
  if (isFiniteNumber(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[,\s¥$€£]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function clamp(n, min, max) {
  if (!isFiniteNumber(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function safeText(v, max = 400) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\u0000/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

export function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (typeof base !== 'object' || base === null || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base && typeof base[k] === 'object' && base[k] !== null && typeof v === 'object' && v !== null && !Array.isArray(v)
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 时间解析：接受 ISO / 本地日期时间 / 仅日期 / 相对时长 / 中文相对日
 * ------------------------------------------------------------------ */

const CN_WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 };

function atLocal(date, h, m, s = 0) {
  const d = new Date(date.getTime());
  d.setHours(h, m, s, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * 解析模型/用户给出的时间表达。
 * @returns {Date|null}
 */
export function parseWhen(input, reference = new Date()) {
  if (input === null || input === undefined) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (isFiniteNumber(input)) {
    // 只接受 10 位秒级 / 13 位毫秒级时间戳，且结果必须落在合理年份内。
    // 其它数字（例如把 20261111 当成日期传进来）直接判为无法解析，不能静默落到 1970 年。
    const digits = Math.trunc(Math.abs(input)).toString();
    const isSeconds = digits.length === 10;
    const isMillis = digits.length === 13;
    if (!isSeconds && !isMillis) return null;
    const d = new Date(isSeconds ? input * 1000 : input);
    if (Number.isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    return year >= 2000 && year <= 2100 ? d : null;
  }
  let s = String(input).trim();
  if (!s) return null;
  if (/^(null|none|无|未设置|undefined)$/i.test(s)) return null;

  const now = reference instanceof Date ? reference : new Date(reference || Date.now());

  // 相对：+30m / +2h / +3d / +1w / 30m / 2小时
  const rel = s.match(/^\+?\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|分钟|分|小时|时|天|日|周|个月)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = /^(m|min|mins|minute|minutes|分钟|分)$/.test(unit)
      ? MINUTE
      : /^(h|hr|hrs|hour|hours|小时|时)$/.test(unit)
        ? HOUR
        : /^(w|week|weeks|周)$/.test(unit)
          ? 7 * DAY
          : /^(个月)$/.test(unit)
            ? 30 * DAY
            : DAY;
    return new Date(now.getTime() + Math.round(n * mult));
  }

  // 中文相对日：今天/明天/后天/大后天 / 昨天/前天/大前天 (+ 可选 09:00)
  const cnDay = s.match(/^(今天|明天|后天|大后天|昨天|前天|大前天)\s*(\d{1,2})?[:：]?(\d{2})?$/);
  if (cnDay) {
    const offset = { 大前天: -3, 前天: -2, 昨天: -1, 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[cnDay[1]];
    const base = addDays(now, offset);
    const h = cnDay[2] !== undefined ? Number(cnDay[2]) : 9;
    const m = cnDay[3] !== undefined ? Number(cnDay[3]) : 0;
    return atLocal(base, h, m);
  }

  // 「3 天前」「2 小时前」「刚刚」这类过去时间（记东西什么时候放进去时最常用）
  if (/^(刚刚|刚才|just now)$/i.test(s)) return new Date(now.getTime());
  const ago = s.match(/^(\d+)\s*(分钟|分|小时|时|天|日|周|个?月|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\s*(?:以?前|ago)$/i);
  if (ago) {
    const n = Number(ago[1]);
    const unit = ago[2].toLowerCase();
    const mult = /^(分钟|分|min|mins|minute|minutes)$/.test(unit)
      ? MINUTE
      : /^(小时|时|h|hr|hrs|hour|hours)$/.test(unit)
        ? HOUR
        : /^(周|w|week|weeks)$/.test(unit)
          ? 7 * DAY
          : /^(个?月)$/.test(unit)
            ? 30 * DAY
            : DAY;
    return new Date(now.getTime() - Math.round(n * mult));
  }

  // 中文周：周三 / 下周三 (+ 可选 09:00)
  const cnWeek = s.match(/^(下)?(?:周|星期|礼拜)([一二三四五六日天七])\s*(\d{1,2})?[:：]?(\d{2})?$/);
  if (cnWeek) {
    const target = CN_WEEKDAY[cnWeek[2]];
    const current = now.getDay() === 0 ? 7 : now.getDay();
    let delta = target - current;
    if (delta <= 0) delta += 7;
    if (cnWeek[1]) delta += 7;
    const base = addDays(now, delta);
    const h = cnWeek[3] !== undefined ? Number(cnWeek[3]) : 9;
    const m = cnWeek[4] !== undefined ? Number(cnWeek[4]) : 0;
    return atLocal(base, h, m);
  }

  // 仅时间 HH:mm —— 今天该时刻，若已过则明天
  const hm = s.match(/^(\d{1,2})[:：](\d{2})(?::(\d{2}))?$/);
  if (hm) {
    let d = atLocal(now, Number(hm[1]), Number(hm[2]), hm[3] ? Number(hm[3]) : 0);
    if (d.getTime() <= now.getTime()) d = addDays(d, 1);
    return d;
  }

  // 纯数字字符串：秒级/毫秒级时间戳
  if (/^\d{10}$|^\d{13}$/.test(s)) {
    const n = Number(s);
    const d = new Date(n < 1e11 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // ISO / 带时区
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // YYYY-MM-DD[ T]HH:mm[:ss]（本地时间）
  const full = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})[:：](\d{2})(?::(\d{2}))?)?$/);
  if (full) {
    const y = Number(full[1]);
    const mo = Number(full[2]) - 1;
    const day = Number(full[3]);
    const h = full[4] !== undefined ? Number(full[4]) : 9;
    const mi = full[5] !== undefined ? Number(full[5]) : 0;
    const sec = full[6] !== undefined ? Number(full[6]) : 0;
    // JS 的 Date 会把 13 月/40 日静悄悄滚到下个月，这里必须先挡掉
    if (mo < 0 || mo > 11 || day < 1 || day > 31) return null;
    if (h > 23 || mi > 59 || sec > 59) return null;
    const d = new Date(y, mo, day, h, mi, sec, 0);
    if (Number.isNaN(d.getTime())) return null;
    if (d.getMonth() !== mo || d.getDate() !== day) return null; // 2026-02-30 这类
    return d;
  }

  // 兜底交给 Date.parse
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtLocal(value) {
  const iso = toIso(value);
  if (!iso) return '（未设置）';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(value) {
  const iso = toIso(value);
  if (!iso) return '（未设置）';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 人类可读的相对时间：还有 3 天 2 小时 / 已过期 5 小时 */
export function humanDelta(value, reference = new Date()) {
  const iso = toIso(value);
  if (!iso) return '';
  const diff = new Date(iso).getTime() - (reference instanceof Date ? reference.getTime() : new Date(reference).getTime());
  const abs = Math.abs(diff);
  const sign = diff >= 0 ? '还有' : '已过';
  if (abs < MINUTE) return diff >= 0 ? '不到 1 分钟' : '刚刚';
  const days = Math.floor(abs / DAY);
  const hours = Math.floor((abs % DAY) / HOUR);
  const mins = Math.floor((abs % HOUR) / MINUTE);
  const parts = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0 && days < 30) parts.push(`${hours} 小时`);
  if (days === 0 && hours === 0) parts.push(`${mins} 分钟`);
  return `${sign} ${parts.slice(0, 2).join(' ')}`;
}

export function minutesBetween(from, to) {
  const a = toIso(from);
  const b = toIso(to);
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / MINUTE);
}

/* ------------------------------------------------------------------ *
 * 金额
 * ------------------------------------------------------------------ */

const CURRENCY_SYMBOL = {
  CNY: '¥', RMB: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$', TWD: 'NT$', KRW: '₩', SGD: 'S$',
};

export function currencySymbol(code) {
  const c = String(code || 'CNY').toUpperCase();
  return CURRENCY_SYMBOL[c] || `${c} `;
}

export function money(amount, currency = 'CNY') {
  const n = toNumber(amount, 0);
  const c = String(currency || 'CNY').toUpperCase();
  const fixed = Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : n.toFixed(2);
  return `${currencySymbol(c)}${fixed}`;
}

export const CYCLE_LABEL = {
  monthly: '每月',
  quarterly: '每季',
  yearly: '每年',
  weekly: '每周',
  once: '一次性',
};

/** 折算成「每月支出」 */
export function monthlyEquivalent(amount, cycle) {
  const n = toNumber(amount, 0);
  switch (cycle) {
    case 'yearly': return n / 12;
    case 'quarterly': return n / 3;
    case 'weekly': return (n * 52) / 12;
    case 'once': return 0;
    case 'monthly':
    default: return n;
  }
}

/** 把任意周期的金额折到「每年」，用于跨周期汇总 */
export function yearlyEquivalent(amount, cycle) {
  const n = toNumber(amount, 0);
  switch (cycle) {
    case 'yearly': return n;
    case 'quarterly': return n * 4;
    case 'weekly': return n * 52;
    case 'once': return 0;
    case 'monthly':
    default: return n * 12;
  }
}

/** 按日历推进（月末自动钳制：1 月 31 日 + 1 月 → 2 月 28/29 日） */
function addMonths(date, n) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const day = date.getDate();
  const target = new Date(date.getTime());
  target.setDate(1);
  target.setMonth(m + n);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

/**
 * 从到期时间与周期推算下一次续费时间。
 * - `once`（买断/一次性）没有「下一次」，返回 null；
 * - 一直推到未来为止（最多 400 步），推不出来也返回 null，绝不返回一个过去的时间。
 */
export function nextRenewal(expiresAt, cycle, reference = new Date()) {
  const iso = toIso(expiresAt);
  if (!iso) return null;
  if (cycle === 'once') return null;
  let d = new Date(iso);
  const ref = reference instanceof Date ? reference : new Date(reference);
  let guard = 0;
  while (d.getTime() <= ref.getTime() && guard < 400) {
    if (cycle === 'yearly') d = addMonths(d, 12);
    else if (cycle === 'quarterly') d = addMonths(d, 3);
    else if (cycle === 'weekly') d = addDays(d, 7);
    else d = addMonths(d, 1);
    guard += 1;
  }
  return d.getTime() > ref.getTime() ? d.toISOString() : null;
}

export function isValidIso(v) {
  return Boolean(toIso(v));
}

/**
 * 同一款服务的「身份键」：忽略大小写、空白与常见标点，
 * 用来判断「这条订阅是不是同一款软件的另一期」，进而决定续期还是新建。
 * 不忽略的东西：版本/档位（Pro、家庭版…）——它们算不同订阅。
 */
export function normalizeNameKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・:：,，.。()（）[\]【】\-_/\\|"'“”‘’]/g, '');
}

export function assetIdentity(record) {
  if (!record) return '';
  const kind = String(record.kind || 'subscription').toLowerCase();
  const name = normalizeNameKey(record.name);
  return name ? `${kind}|${name}` : '';
}

/**
 * 规范化成「无损 JSON」：工具输出必须是这条，否则宿主会拒收整条结果。
 * - undefined 字段丢掉；数组里的 undefined 变 null（保持长度）
 * - NaN / Infinity → null（JSON.stringify 会把它变成 null 或直接报错）
 * - Date → ISO 字符串
 */
export function jsonSafe(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = jsonSafe(item);
  }
  return out;
}