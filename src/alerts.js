/**
 * 提醒条（面板里的「待处理提醒」）。
 *
 * 与 reminders.js 的分工：
 *  - reminders.js 负责「到点必须打断用户」的强提醒（走宿主 schedule → 会话）；
 *  - alerts.js 负责「打开面板一眼看到」的弱提醒（派生视图，可集中确认）。
 *
 * 派生规则是纯函数式的：每次 recompute 都从当前数据重新推导，
 * 用 dedupeKey 做幂等，已确认的记录不会被重新生成。
 */

import { nowIso, toIso, humanDelta, safeText, money, newId, CYCLE_LABEL } from './util.js';
import { normalizeAlert } from './store.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** 各类记录的提醒窗口（毫秒）。语义：进入这个窗口就生成 warn。 */
const WINDOW = {
  asset: 7 * DAY,
  todo: 30 * 60 * 1000,
  debt: 3 * DAY,
};

const LEVEL_RANK = { info: 0, warn: 1, critical: 2 };

export function createAlerts({ store, config, logger }) {
  function upsert(alert) {
    const rec = normalizeAlert(alert);
    const existing = store.list('alerts').find((a) => a.dedupeKey === rec.dedupeKey);
    if (existing) {
      const escalated = LEVEL_RANK[rec.level] > LEVEL_RANK[existing.level];
      const changed = existing.level !== rec.level || existing.message !== rec.message || existing.title !== rec.title;
      if (existing.acknowledged) {
        if (!escalated) return existing;
        return store.patch('alerts', existing.id, {
          level: rec.level,
          message: rec.message,
          title: rec.title,
          acknowledged: false,
          acknowledgedAt: null,
          at: nowIso(),
        });
      }
      // 级别可能升也可能降（例如把截止时间往后推）：始终反映当前真实状态，保留首次发生时间
      if (changed) {
        return store.patch('alerts', existing.id, { level: rec.level, message: rec.message, title: rec.title });
      }
      return existing;
    }
    return store.put('alerts', rec);
  }

  function todoAdvance(record) {
    const raw = record.advanceMinutes;
    // 0 是合法值（只在到点提醒），null/undefined/'' 才回落到默认提前量
    if (raw === null || raw === undefined || raw === '') return config.advanceMinutes * 60 * 1000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n * 60 * 1000 : config.advanceMinutes * 60 * 1000;
  }

  /**
   * 一次性迁移：旧版本的 dedupeKey 带等级后缀（`asset:<id>:warn`），
   * 导致「升级」被当成新提醒而不是同一条升级。这里把后缀剥掉，重复的只留一条。
   */
  function migrateKeys() {
    const seen = new Map();
    for (const alert of store.list('alerts')) {
      const raw = String(alert.dedupeKey || '');
      const next = raw.replace(/:(info|warn|critical)$/, '');
      if (next === raw) {
        if (next) seen.set(next, alert.id);
        continue;
      }
      if (next && seen.has(next)) {
        store.remove('alerts', alert.id);
        continue;
      }
      store.patch('alerts', alert.id, { dedupeKey: next });
      if (next) seen.set(next, alert.id);
    }
  }

  /** 从当前数据重新推导所有提醒。返回新生成/升级的条数。 */
  function recompute() {
    migrateKeys();
    const now = Date.now();
    let added = 0;
    // 本轮「仍然成立」的提醒 key：不在集合里的旧提醒一律清掉
    // （截止时间往后推、额度恢复、借贷结清……否则面板会一直挂着已经过时的提醒）
    const touched = new Set();
    const add = (alert) => {
      touched.add(normalizeAlert(alert).dedupeKey);
      return upsert(alert);
    };
    const before = new Set(store.list('alerts').map((a) => a.id + ':' + a.level));

    /* ---- 订阅到期 ---- */
    for (const asset of store.list('assets')) {
      const due = toIso(asset.expiresAt);
      if (!due) continue;
      const remaining = new Date(due).getTime() - now;
      let level = null;
      if (remaining <= 0) level = 'critical';
      else if (remaining <= WINDOW.asset) level = 'warn';
      if (!level) continue;
      const title = remaining <= 0 ? '订阅已过期' : '订阅即将到期';
      add({
        dedupeKey: `asset:${asset.id}`,
        itemKind: 'asset',
        itemId: asset.id,
        level,
        title,
        message: `${asset.name}${asset.amount ? ` · ${money(asset.amount, asset.currency)}/${CYCLE_LABEL[asset.cycle] || asset.cycle}` : ''} · ${humanDelta(due)}`,
        at: nowIso(),
      });
    }

    /* ---- 待办到期 ---- */
    for (const todo of store.list('todos')) {
      if (todo.status !== 'pending') continue;
      const due = toIso(todo.dueAt);
      if (!due) continue;
      const remaining = new Date(due).getTime() - now;
      let level = null;
      if (remaining <= 0) level = 'critical';
      else if (remaining <= todoAdvance(todo)) level = 'warn';
      if (!level) continue;
      add({
        dedupeKey: `todo:${todo.id}`,
        itemKind: 'todo',
        itemId: todo.id,
        level,
        title: remaining <= 0 ? '待办已到期' : '待办即将到期',
        message: `${todo.title}${todo.counterpart ? `（${todo.counterpart}）` : ''} · ${humanDelta(due)}`,
        at: nowIso(),
      });
    }

    /* ---- 借贷到期 ---- */
    for (const debt of store.list('debts')) {
      if (debt.status !== 'open') continue;
      const due = toIso(debt.dueAt);
      if (!due) continue;
      const remaining = new Date(due).getTime() - now;
      let level = null;
      if (remaining <= 0) level = 'critical';
      else if (remaining <= WINDOW.debt) level = 'warn';
      if (!level) continue;
      const who = debt.direction === 'owedToMe' ? `${debt.counterpart} 欠我` : `我欠 ${debt.counterpart}`;
      add({
        dedupeKey: `debt:${debt.id}`,
        itemKind: 'debt',
        itemId: debt.id,
        level,
        title: remaining <= 0 ? '借贷已逾期' : '借贷即将到期',
        message: `${who} · ${money(debt.amount, debt.currency)} · ${humanDelta(due)}`,
        at: nowIso(),
      });
    }

    /* ---- 额度告警 ---- */
    for (const plan of store.list('plans')) {
      const thresholds = plan.thresholds || { warn: 0.8, critical: 0.95 };
      let worst = null;
      let empty = null;
      for (const win of plan.windows || []) {
        // 余额型窗口没有「用了百分之几」，只有「还剩多少」：用完（<=0）才提醒
        if (win.limit === null || win.percent === null) {
          const left = Number(win.remaining);
          if (Number.isFinite(left) && left <= 0 && !empty) empty = win;
          continue;
        }
        const percent = Number(win.percent);
        if (!Number.isFinite(percent)) continue;
        const level = percent >= thresholds.critical ? 'critical' : percent >= thresholds.warn ? 'warn' : null;
        if (!level) continue;
        if (!worst || LEVEL_RANK[level] > LEVEL_RANK[worst.level]) worst = { level, win, percent };
      }
      if (empty) {
        add({
          dedupeKey: `plan:${plan.id}:${empty.key}`,
          itemKind: 'plan',
          itemId: plan.id,
          level: 'critical',
          title: '余额已用完',
          message: `${plan.name} · ${empty.label} 已无可用余额，需要充值或换额度`,
          at: nowIso(),
        });
      }
      if (worst) {
        add({
          dedupeKey: `plan:${plan.id}:${worst.win.key}`,
          itemKind: 'plan',
          itemId: plan.id,
          level: worst.level,
          title: worst.level === 'critical' ? '额度即将耗尽' : '额度接近上限',
          message: `${plan.name} · ${worst.win.label} 已用 ${Math.round((worst.percent || 0) * 100)}%${worst.win.resetAt ? ` · ${humanDelta(worst.win.resetAt)} 重置` : ''}`,
          at: nowIso(),
        });
      }
      if (plan.status === 'error') {
        add({
          dedupeKey: `plan:${plan.id}:error`,
          itemKind: 'plan',
          itemId: plan.id,
          level: 'warn',
          title: '额度查询失败',
          message: `${plan.name}：${safeText(plan.error, 200)}`,
          at: nowIso(),
        });
      }
    }

    // 条件已经不再成立的提醒（截止时间改了、额度恢复了、结清了、记录被删了）一并清掉，
    // 避免面板挂着指向不存在状态或空记录的幽灵提醒
    store.removeWhere('alerts', (alert) => !touched.has(alert.dedupeKey));

    const after = new Set(store.list('alerts').map((a) => a.id + ':' + a.level));
    for (const key of after) if (!before.has(key)) added += 1;
    prune();
    if (added) logger?.info?.(`[butler] 新增 ${added} 条提醒`);
    return { added, total: store.list('alerts').length };
  }

  /** 已确认且超过 7 天的清掉；总数上限 200（保留最新）。 */
  function prune() {
    const now = Date.now();
    store.removeWhere('alerts', (alert) => {
      if (!alert.acknowledged) return false;
      const at = new Date(alert.at || 0).getTime();
      return Number.isFinite(at) && now - at > 7 * DAY;
    });
    const all = store.list('alerts');
    if (all.length > 200) {
      const sorted = all.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const keep = new Set(sorted.slice(0, 200).map((a) => a.id));
      store.removeWhere('alerts', (alert) => !keep.has(alert.id));
    }
  }

  function ack(id) {
    const alert = store.find('alerts', id);
    if (!alert) return null;
    return store.patch('alerts', id, { acknowledged: true, acknowledgedAt: nowIso() });
  }

  function ackAll() {
    const pending = store.list('alerts').filter((a) => !a.acknowledged);
    for (const alert of pending) store.patch('alerts', alert.id, { acknowledged: true, acknowledgedAt: nowIso() });
    return pending.length;
  }

  /** 面板视图：未确认优先、级别降序、时间降序。 */
  function view() {
    return store.list('alerts')
      .slice()
      .sort((a, b) => {
        if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
        const rank = (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0);
        if (rank) return rank;
        return String(b.at).localeCompare(String(a.at));
      });
  }

  function pendingCount() {
    return store.list('alerts').filter((a) => !a.acknowledged).length;
  }

  return { recompute, prune, ack, ackAll, view, pendingCount };
}

export { newId };