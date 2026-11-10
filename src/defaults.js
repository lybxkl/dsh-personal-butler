/**
 * 插件默认配置与归一化。
 *
 * 配置只承载「可调值」——任何用户可调的东西都必须能在这层被改，
 * 且升级插件不会覆盖用户在 cordis.patch.yml 里的设置。
 */

export const DEFAULT_CONFIG = Object.freeze({
  /** 额度轮询间隔（秒）。0 或负数 = 关闭自动轮询。 */
  pollSeconds: 30,
  /** 到期/到点提醒的默认提前量（分钟）。 */
  advanceMinutes: 30,
  /** 默认货币。 */
  currency: 'CNY',
  /** 提醒投递目标：new_once | new | session | origin（原会话，通常是发起记录的那个聊天） */
  reminderTarget: 'new_once',
  /** reminderTarget=session 时使用的会话 id。 */
  reminderSession: '',
  /** 额度源覆盖（按 sourceId 覆盖 baseUrl/endpoint/headers/mapping）。 */
  quotaSources: {},
  /** 面板 HTTP 路由的访问令牌；空 = 只校验 loopback 与 Origin。 */
  apiToken: '',
  /** 每个额度计划保留的采样条数。 */
  maxSnapshots: 240,
  /** 单次额度查询超时（毫秒）。 */
  quotaTimeoutMs: 15000,
  /** 提醒任务标题前缀，便于用户在 Automation tasks 里辨认。 */
  reminderTitlePrefix: '管家提醒',
  /** 是否在 Host 启动后立即同步一次提醒。 */
  syncOnStart: true,
});

const NUMBER_BOUNDS = {
  pollSeconds: [0, 86400],
  advanceMinutes: [0, 60 * 24 * 30],
  maxSnapshots: [0, 10000],
  quotaTimeoutMs: [1000, 120000],
};

export function normalizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULT_CONFIG)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }

  for (const [key, [min, max]] of Object.entries(NUMBER_BOUNDS)) {
    const n = Number(out[key]);
    out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULT_CONFIG[key];
  }

  if (!['new_once', 'new', 'session', 'origin'].includes(out.reminderTarget)) out.reminderTarget = DEFAULT_CONFIG.reminderTarget;
  if (out.reminderTarget === 'session' && !String(out.reminderSession || '').trim()) {
    // 没给目标会话就退回 new_once，不让提醒静默丢失
    out.reminderTarget = 'new_once';
  }

  out.currency = String(out.currency || 'CNY').toUpperCase().slice(0, 8);
  out.apiToken = String(out.apiToken || '');
  out.reminderTitlePrefix = String(out.reminderTitlePrefix || '管家提醒').slice(0, 20);
  out.syncOnStart = out.syncOnStart !== false;
  out.quotaSources = out.quotaSources && typeof out.quotaSources === 'object' && !Array.isArray(out.quotaSources)
    ? out.quotaSources
    : {};

  return out;
}

/** 面板可写的配置字段白名单（其余字段只能改 patch 文件）。 */
export const PANEL_EDITABLE_CONFIG = ['pollSeconds', 'advanceMinutes', 'currency', 'maxSnapshots'];

export function sanitizePanelConfigPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const key of PANEL_EDITABLE_CONFIG) {
    if (patch[key] === undefined) continue;
    if (key === 'currency') {
      const currency = String(patch[key] || '').toUpperCase().slice(0, 8);
      if (currency) out[key] = currency;
      continue;
    }
    const bounds = NUMBER_BOUNDS[key];
    const n = Number(patch[key]);
    if (!Number.isFinite(n)) continue;
    // 面板输入也要走同一套钳制，避免把轮询间隔写成 99999 秒
    out[key] = bounds ? Math.min(bounds[1], Math.max(bounds[0], Math.round(n))) : Math.round(n);
  }
  return out;
}