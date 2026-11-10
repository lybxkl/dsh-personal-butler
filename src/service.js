/**
 * 管家业务服务层。
 *
 * 唯一语义入口：面板 HTTP 路由和模型工具都调这里的方法，
 * 保证「同一个操作，UI 走一遍、模型走一遍，结果与失败原因一致」
 * （这是插件规范里 user-actions 的核心要求）。
 */

import {
  assetIdentity,
  CYCLE_LABEL,
  currencySymbol,
  deepMerge,
  fmtDate,
  fmtLocal,
  humanDelta,
  isValidIso,
  money,
  monthlyEquivalent,
  newId,
  nextRenewal,
  nowIso,
  parseWhen,
  pick,
  safeText,
  toIso,
  toNumber,
  yearlyEquivalent,
} from './util.js';
import {
  normalizeAlert,
  normalizeAsset,
  normalizeDebt,
  normalizeItem,
  normalizePlan,
  normalizeSource,
  normalizeTodo,
} from './store.js';
import { hostMatches, inspectSourceDraft, normalizeHosts, normalizeSourceId, runSourceCode, sampleOf } from './sources.js';
import { placeLabel, photoView } from './photos.js';
import { createHash } from 'node:crypto';
import { sanitizePanelConfigPatch } from './defaults.js';

const COLLECTIONS = ['assets', 'plans', 'todos', 'debts', 'items'];
const SOURCE_LABEL = { screenshot: '截图', manual: '手动', model: 'AI', import: '导入' };

/** 试跑通过的代码指纹（内存级，30 分钟内有效）：保存前必须先试跑，靠它把关。 */
const SOURCE_TEST_TTL_MS = 30 * 60 * 1000;
const testedSources = new Map(); // digest -> 时间戳

function sourceDigest(code, hosts) {
  return createHash('sha256')
    .update(String(code || ''))
    .update('\n')
    .update((hosts || []).join(','))
    .digest('hex');
}

/** 计划 id → 凭证引用（不受调用方影响，也不允许借别人的凭证）。 */
function newPlanRef() {
  return `plan_${Math.random().toString(36).slice(2, 10)}`;
}

function fail(message) {
  return { ok: false, error: String(message || '未知错误') };
}

/**
 * 找「同一款软件、已经过期」的旧记录：命中就说明这是续费，应该更新那条而不是新建。
 * 只看已过期的（未过期的同名订阅可能是第二个账号，随意合并会吃掉用户的记录）。
 */
function findExpiredTwin(store, input, kind) {
  const key = assetIdentity({ kind, name: input.name });
  if (!key) return null;
  const nowMs = Date.now();
  const expired = store.list('assets').filter((asset) => {
    if (assetIdentity(asset) !== key) return false;
    const at = asset.expiresAt ? new Date(asset.expiresAt).getTime() : NaN;
    return Number.isFinite(at) && at <= nowMs;
  });
  if (!expired.length) return null;
  // 有多条历史时，续最近过期的那条
  expired.sort((a, b) => new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime());
  return expired[0];
}

function done(data) {
  return { ok: true, data };
}

export function createService({ store, config, kinds, credentials, quota, reminders, alerts, photos: photosModule, hooks, recentImageRefs }) {
  /** 这个计划自己的额度源登记了哪些域名。 */
  function planSourceHosts(plan) {
    if (!plan) return [];
    try {
      const source = quota.resolveSource(plan.sourceId);
      return normalizeHosts(source?.hosts || []);
    } catch {
      return [];
    }
  }

  /** 请求要访问的 host 是否都在计划额度源的登记范围内。 */
  function hostsCoveredBy(hosts, plan) {
    const allowed = planSourceHosts(plan);
    if (!allowed.length) return false;
    return (hosts || []).every((host) => hostMatches(host, allowed));
  }
  /* ------------------------------ 读取 ------------------------------ */

  function withDerived(asset, now) {
    const next = nextRenewal(asset.expiresAt, asset.cycle, now);
    const remainingMs = asset.expiresAt ? new Date(asset.expiresAt).getTime() - now.getTime() : null;
    return {
      ...asset,
      cycleLabel: CYCLE_LABEL[asset.cycle] || asset.cycle,
      sourceLabel: SOURCE_LABEL[asset.source] || asset.source,
      nextRenewalAt: next,
      daysUntilExpiry: remainingMs === null ? null : Math.ceil(remainingMs / (24 * 3600 * 1000)),
      monthlyCost: Math.round(monthlyEquivalent(asset.amount, asset.cycle) * 100) / 100,
      yearlyCost: Math.round(yearlyEquivalent(asset.amount, asset.cycle) * 100) / 100,
      amountLabel: money(asset.amount, asset.currency || config.currency),
      expiryLabel: asset.expiresAt ? fmtDate(asset.expiresAt) : null,
      relativeExpiry: asset.expiresAt ? humanDelta(asset.expiresAt, now) : null,
    };
  }

  function planView(plan) {
    const thresholds = plan.thresholds || { warn: 0.8, critical: 0.95 };
    const windows = (plan.windows || []).map((win) => {
      const percent = Number(win.percent);
      // 只有余额、没有总额度的窗口（DeepSeek 余额、自定义源只报余额）没有「用了百分之几」
      // 这个语义，硬套百分比会显示成「已用 0%」——那是假信息，面板按余额单独渲染。
      const isBalance = win.limit === null || win.percent === null;
      let level = 'ok';
      if (isBalance) {
        if (win.remaining !== null && Number.isFinite(Number(win.remaining)) && Number(win.remaining) <= 0) {
          level = 'critical';
        }
      } else if (Number.isFinite(percent)) {
        if (percent >= thresholds.critical) level = 'critical';
        else if (percent >= thresholds.warn) level = 'warn';
      }
      return {
        ...win,
        kind: isBalance ? 'balance' : 'ratio',
        level,
        resetLabel: win.resetAt ? humanDelta(win.resetAt) : null,
      };
    });
    const source = quota.resolveSource(plan.sourceId);
    return {
      ...plan,
      windows,
      sourceLabel: source.label || plan.sourceId,
      sourceCustom: Boolean(source.custom),
      credentialHint: source.credentialHint || '',
      hasCredential: plan.hasCredential || credentials.has(plan.credentialRef),
    };
  }

  function state() {
    const now = new Date();
    const snap = store.snapshot();
    const assets = snap.assets.map((a) => withDerived(a, now)).sort((a, b) => {
      const ax = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bx = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
      return ax - bx;
    });
    const plans = snap.plans.map(planView);

    const totals = { monthly: {}, yearly: {}, byCurrency: {} };
    for (const asset of snap.assets) {
      const currency = asset.currency || config.currency;
      totals.monthly[currency] = (totals.monthly[currency] || 0) + monthlyEquivalent(asset.amount, asset.cycle);
      totals.yearly[currency] = (totals.yearly[currency] || 0) + yearlyEquivalent(asset.amount, asset.cycle);
    }
    for (const key of Object.keys(totals.monthly)) {
      totals.monthly[key] = Math.round(totals.monthly[key] * 100) / 100;
      totals.yearly[key] = Math.round(totals.yearly[key] * 100) / 100;
      totals.byCurrency[key] = {
        monthly: totals.monthly[key],
        yearly: totals.yearly[key],
        monthlyLabel: `${currencySymbol(key)}${totals.monthly[key]}`,
        yearlyLabel: `${currencySymbol(key)}${totals.yearly[key]}`,
      };
    }

    const debtTotals = {};
    for (const debt of snap.debts) {
      if (debt.status !== 'open') continue;
      const currency = debt.currency || config.currency;
      if (!debtTotals[currency]) debtTotals[currency] = { owedToMe: 0, iOwe: 0 };
      if (debt.direction === 'owedToMe') debtTotals[currency].owedToMe += debt.amount;
      else debtTotals[currency].iOwe += debt.amount;
    }
    for (const [currency, value] of Object.entries(debtTotals)) {
      value.owedToMeLabel = money(value.owedToMe, currency);
      value.iOweLabel = money(value.iOwe, currency);
      value.net = value.owedToMe - value.iOwe;
      value.netLabel = `${value.net >= 0 ? '+' : '-'}${money(Math.abs(value.net), currency)}`;
    }

    const pendingTodos = snap.todos.filter((t) => t.status === 'pending');
    const quotaState = quota.state();

    return {
      ok: true,
      now: now.getTime(),
      nowIso: now.toISOString(),
      version: '0.1.0',
      config: pick(config, ['currency', 'pollSeconds', 'advanceMinutes', 'reminderTarget', 'reminderSession', 'maxSnapshots']),
      assets,
      plans,
      todos: snap.todos,
      debts: snap.debts,
      items: snap.items.map(itemView),
      pending: (() => { expirePending(); return store.list('pending').filter((p) => p.status === 'open').map(pendingView); })(),
      alerts: alerts.view(),
      kinds: kinds.view(),
      summary: {
        assetCount: snap.assets.length,
        planCount: snap.plans.length,
        todoPending: pendingTodos.length,
        todoDone: snap.todos.filter((t) => t.status === 'done').length,
        debtOpen: snap.debts.filter((d) => d.status === 'open').length,
        itemCount: snap.items.length,
        photoCount: snap.photos.length,
        alertPending: alerts.pendingCount(),
        pendingCount: store.list('pending').filter((p) => p.status === 'open').length,
        subscriptionTotals: totals.byCurrency || {},
        debtTotals,
      },
      sources: quota.sources(),
      diagnostics: {
        lastQuotaTick: quotaState.lastTick,
        quotaBusy: quotaState.busy,
        quotaSkipped: quotaState.skipped,
        lastError: quotaState.lastError,
        storagePath: store.filePath,
        credentialBackend: credentials.backend(),
        credentialError: credentials.getError(),
        scheduleAvailable: reminders.available(),
        reminderSyncing: reminders.isSyncing(),
        reminderError: reminders.lastError(),
        loadError: store.loadError,
      },
    };
  }

  /* ------------------------------ 资产 ------------------------------ */

  function requireKind(raw) {
    const id = safeText(raw || 'other', 40).toLowerCase() || 'other';
    const known = kinds.get(id);
    if (known) return { kind: known.id, autoRegistered: false };
    // L3 容错：未知种类自动注册，避免截图识别出「新类型」时被硬拦
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(id)) return { kind: 'other', autoRegistered: false };
    try {
      kinds.register({ id, label: id, collection: 'assets' });
      return { kind: id, autoRegistered: true };
    } catch {
      return { kind: 'other', autoRegistered: false };
    }
  }

  /* ------------------------- 待确认（跨通道选择） ------------------------- */

  function pendingView(record) {
    const expired = record.status === 'open' && Date.parse(record.expiresAt) <= Date.now();
    const options = record.options.map((option, index) => ({
      ...option,
      index: index + 1,
      label: `${index + 1}. ${option.label}`,
    }));
    return {
      ...record,
      status: expired ? 'expired' : record.status,
      expired,
      options,
      optionsText: options.map((option) => option.label).join('\n'),
      hasPayload: Boolean(record.payload && record.payload.collection),
    };
  }

  /** 把过了期的待确认标成 expired，免得列表里永远躺着没人能回答的问题。 */
  /** 已处理完的待确认只留 7 天，最多 200 条：它们只是历史，不该无限涨。 */
  function prunePending() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const record of store.list('pending')) {
      if (record.status === 'open') continue;
      const at = Date.parse(record.resolvedAt || record.createdAt);
      if (!Number.isNaN(at) && at < cutoff) {
        store.remove('pending', record.id);
        removed += 1;
      }
    }
    const sorted = store.list('pending').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (sorted.length > 200) {
      for (const record of sorted.slice(0, sorted.length - 200)) {
        store.remove('pending', record.id);
        removed += 1;
      }
    }
    return removed;
  }

  function expirePending() {
    prunePending();
    const now = Date.now();
    let changed = 0;
    for (const record of store.list('pending')) {
      if (record.status !== 'open') continue;
      if (Date.parse(record.expiresAt) > now) continue;
      store.patch('pending', record.id, { status: 'expired' });
      changed += 1;
    }
    return changed;
  }

  function pendingText(view) {
    const title = view.title ? `【${view.title}】` : '【需要你确认】';
    const minutes = Math.max(1, Math.round((Date.parse(view.expiresAt) - Date.now()) / 60000));
    return [
      `${title}${view.question}`,
      ...view.options.map((option) => option.label),
      `直接回数字就行（比如「1」）。这条 ${minutes} 分钟内有效，过期就不作数了。`,
    ].join('\n');
  }

  async function createPending(input = {}) {
    const question = String(input.question || '').trim();
    if (!question) return fail('要问什么？question 不能为空');
    const rawOptions = Array.isArray(input.options) ? input.options : [];
    if (rawOptions.length < 2) return fail('至少给两个选项，用户才有得选');
    if (rawOptions.length > 8) return fail('选项最多 8 个，太长了手机上不好回');

    let payload = null;
    if (input.collection) {
      if (!COLLECTIONS.includes(input.collection)) return fail(`collection 必须是 ${COLLECTIONS.join(' / ')}`);
      const op = String(input.op || 'create');
      if (!['create', 'update', 'delete'].includes(op)) return fail('op 只能是 create / update / delete');
      if (op === 'delete' && !input.id) return fail('delete 要带 id');
      if (op !== 'delete' && (!input.record || typeof input.record !== 'object')) return fail('要落地就得带 record（记录内容）');
      payload = { collection: input.collection, op, id: input.id || null, record: op === 'delete' ? null : input.record };
    }

    const hasApplies = rawOptions.some((option) => option && typeof option === 'object' && option.applies);
    const options = rawOptions.map((option, index) => {
      if (typeof option === 'string') {
        return { label: option, applies: Boolean(payload) && !hasApplies && index === 0 };
      }
      return { label: String(option.label || ''), applies: Boolean(option.applies) };
    });
    if (options.some((option) => !option.label)) return fail('每个选项都要有 label');

    const record = store.put('pending', {
      title: input.title || '',
      question,
      options,
      payload,
      status: 'open',
      source: input.source || 'model',
      ttlMinutes: input.ttlMinutes,
    });
    const view = pendingView(record);
    return done({ pending: view, text: pendingText(view) });
  }

  function listPending(input = {}) {
    expirePending();
    const status = input.status || 'open';
    const limit = Math.min(50, Math.max(1, Math.round(Number(input.limit) || 20)));
    const views = store
      .list('pending')
      .filter((record) => (status === 'all' ? true : record.status === status))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
      .map(pendingView);
    const digest = views
      .map((view) => `- id=${view.id} · ${view.title ? `【${view.title}】` : ''}${view.question}`
        + `\n  选项：${view.options.map((option) => option.label).join(' / ')}`
        + `\n  有效期到 ${toIso(view.expiresAt)}（status=${view.status}）`)
      .join('\n');
    const text = views.length === 0 ? '没有待确认的问题。' : `待确认 ${views.length} 条：\n${digest}`;
    return done({ pending: views, count: views.length, text });
  }

  /** 用户回的「1」/「2. 改一下」/某个选项原文，都要能对上。 */
  function matchOption(options, choice) {
    const text = String(choice ?? '').trim();
    if (!text) return null;
    const numeric = text.match(/^(\d{1,2})(?:[.、,，)）\s]|$)/);
    if (numeric) {
      const picked = options[Number(numeric[1]) - 1];
      if (picked) return picked;
    }
    const lower = text.toLowerCase();
    return options.find((option) => option.label.toLowerCase() === lower) || null;
  }

  async function resolvePending(input = {}) {
    const id = String(input.id || '').trim();
    if (!id) return fail('要回答哪一条？请带 id（可以先 butler_pending_list 看）');
    const record = store.find('pending', id);
    if (!record) return fail(`待确认 ${id} 不存在（可能已经被处理或过期清掉了）`);
    expirePending();
    const current = store.find('pending', id) || record;
    if (current.status !== 'open') {
      return fail(`这条已经${current.status === 'expired' ? '过期了' : '处理过了'}（${current.status}），不用再回`);
    }
    const chosen = matchOption(current.options, input.choice);
    if (!chosen) {
      const view = pendingView(current);
      return fail(`「${String(input.choice ?? '').trim() || '空回答'}」对不上选项。可回：${view.options.map((option, index) => `${index + 1}=${current.options[index].label}`).join(' / ')}`);
    }

    let applied = null;
    if (chosen.applies && current.payload && current.payload.collection) {
      const { collection, op, id: targetId, record: payloadRecord } = current.payload;
      const result = await mutate({ collection, op, id: op === 'create' ? null : targetId, record: payloadRecord }, { sessionId: input.sessionId });
      if (!result.ok) {
        return fail(`选项选好了，但落库失败：${result.error}（这条还开着，可以改完再回）`);
      }
      applied = result.data?.record || null;
    }

    const patched = store.patch('pending', current.id, {
      status: applied ? 'applied' : 'answered',
      choice: chosen.label,
      resultId: applied ? applied.id : null,
      resolvedAt: new Date().toISOString(),
    });
    const view = pendingView(patched);
    return done({
      pending: view,
      applied,
      text: applied
        ? `已按「${chosen.label}」处理：${applied.name || applied.title || applied.id}`
        : `记下你的选择：${chosen.label}`,
    });
  }

  function cancelPending(input = {}) {
    const id = String(input.id || '').trim();
    if (!id) return fail('要取消哪一条？请带 id');
    const record = store.find('pending', id);
    if (!record) return fail(`待确认 ${id} 不存在`);
    if (record.status !== 'open') return fail(`这条已经是 ${record.status}，不用再取消`);
    const patched = store.patch('pending', id, { status: 'cancelled', resolvedAt: new Date().toISOString() });
    return done({ pending: pendingView(patched), text: '已取消这条待确认。' });
  }

  async function upsertAsset(input, context = {}) {
    if (!input || typeof input !== 'object') return fail('缺少资产字段');
    const existing = input.id ? store.find('assets', input.id) : null;
    if (input.id && !existing) return fail(`资产 ${input.id} 不存在`);

    const expiresAt = input.expiresAt === undefined ? existing?.expiresAt : toIso(parseWhen(input.expiresAt));
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '' && !expiresAt) {
      return fail(`无法解析到期时间「${input.expiresAt}」，请用 2026-12-10 或 2026-12-10 18:00 这类格式`);
    }

    const kindRes = requireKind(input.kind ?? existing?.kind ?? 'subscription');
    if (!existing && !safeText(input.name, 120)) return fail('资产必须有名称（照截图里的软件名填）');

    // 同一款软件、旧记录已经过期 → 这是下一期订阅，直接续期到旧记录，别再堆一条重复的。
    // 想并存第二个账号时传 allowDuplicate: true。
    let target = existing;
    let renewedFrom = null;
    if (!target && !input.allowDuplicate) {
      const twin = findExpiredTwin(store, input, kindRes.kind);
      if (twin) {
        target = twin;
        renewedFrom = { id: twin.id, name: twin.name, expiresAt: twin.expiresAt, amount: twin.amount };
      }
    }

    const record = normalizeAsset({
      ...(target || {}),
      ...pick(input, ['name', 'vendor', 'amount', 'currency', 'cycle', 'startedAt', 'autoRenew', 'notes', 'source', 'tags', 'reminder']),
      kind: kindRes.kind,
      expiresAt,
      id: target?.id,
    }, { currency: config.currency });

    if (!record.name) return fail('资产必须有名称');
    if (input.amount !== undefined && input.amount !== null && input.amount !== '') {
      const n = Number(input.amount);
      if (!Number.isFinite(n)) return fail(`金额「${input.amount}」不是数字`);
      if (n < 0) return fail('金额不能是负数');
      if (n > 1e12) return fail('金额太大了（上限 1 万亿），请检查是不是填错了');
    }
    if (record.startedAt === undefined) record.startedAt = null;

    // 记住这条是从哪个会话记的：reminderTarget=origin 时提醒投回这里（QQ 里记的就回 QQ）
    if (context.sessionId) record.originSessionId = String(context.sessionId).slice(0, 120);
    const saved = store.put('assets', record);
    await reminders.syncItem('assets', saved);
    alerts.recompute();
    hooks?.onDataChanged?.('assets');
    return done({ record: store.find('assets', saved.id), kindAutoRegistered: kindRes.autoRegistered, renewed: Boolean(renewedFrom), previous: renewedFrom });
  }

  async function removeAsset(id) {
    const record = store.find('assets', id);
    if (!record) return fail(`资产 ${id} 不存在`);
    await reminders.removeAllFor(record);
    store.remove('assets', id);
    // 关联的额度计划一起清理，避免留下孤儿（走 removePlan 才能同时清快照与凭证）
    for (const plan of store.list('plans').filter((p) => p.assetId === id)) {
      await removePlan(plan.id);
    }
    alerts.recompute();
    hooks?.onDataChanged?.('assets');
    return done({ deleted: true, id });
  }

  /* ------------------------------ 额度计划 ------------------------------ */

  async function upsertPlan(input) {
    if (!input || typeof input !== 'object') return fail('缺少额度计划字段');
    const existing = input.id ? store.find('plans', input.id) : null;
    if (input.id && !existing) return fail(`额度计划 ${input.id} 不存在`);

    const sourceId = safeText(input.sourceId || input.provider || existing?.sourceId || 'generic', 60);
    if (!existing && !safeText(input.name, 120)) return fail('额度计划必须有名称（例如「Claude Pro 额度」）');
    if (sourceId.startsWith('custom:') && !store.find('sources', sourceId)) {
      return fail(`额度源 ${sourceId} 不存在：先用 butler_source_save 建好这个平台的查询方式`);
    }
    const source = quota.resolveSource(sourceId);
    const record = normalizePlan({
      ...(existing || {}),
      ...pick(input, ['name', 'provider', 'planLabel', 'thresholds']),
      sourceId,
      provider: safeText(input.provider || existing?.provider || sourceId, 40),
      assetId: input.assetId !== undefined ? input.assetId : existing?.assetId,
      id: existing?.id,
      // credentialRef 由计划 id 派生，不接受调用方指定：否则可以把别人的凭证借用/覆盖到任意键上
      credentialRef: existing?.credentialRef || `butler.quota.${existing?.id || newPlanRef()}`,
    }, { currency: config.currency });

    if (!record.name) return fail('额度计划必须有名称');
    if (record.assetId && !store.find('assets', record.assetId)) return fail(`资产 ${record.assetId} 不存在`);
    record.hasCredential = credentials.has(record.credentialRef);
    if (source.needsCredential && !record.hasCredential) record.status = 'no-credential';
    // 手动源不需要凭证
    if (!source.needsCredential) record.status = record.status === 'no-credential' ? 'unknown' : record.status;

    const saved = store.put('plans', record);
    alerts.recompute();
    hooks?.onDataChanged?.('plans');
    return done({ record: store.find('plans', saved.id), credentialHint: source.credentialHint || '' });
  }

  async function removePlan(id) {
    const plan = store.find('plans', id);
    if (!plan) return fail(`额度计划 ${id} 不存在`);
    store.remove('plans', id);
    store.removeWhere('snapshots', (s) => s.planId === id);
    // 删计划就把凭证一起清掉：不然 API key / cookie 会永远留在磁盘上
    if (plan.credentialRef) credentials.set(plan.credentialRef, '');
    alerts.recompute();
    hooks?.onDataChanged?.('plans');
    return done({ deleted: true, id });
  }

  function setPlanCredential(planId, rawValue) {
    const plan = store.find('plans', planId);
    if (!plan) return fail(`额度计划 ${planId} 不存在`);
    const value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
    const ok = credentials.set(plan.credentialRef, value);
    if (!ok) return fail('凭证写入失败（详见诊断信息）');
    const has = credentials.has(plan.credentialRef);
    store.patch('plans', planId, { hasCredential: has, status: has ? 'unknown' : 'no-credential', error: has ? null : '未配置额度查询凭证' });
    hooks?.onDataChanged?.('plans');
    return done({ planId, hasCredential: has });
  }

  function setPlanWindows(planId, windows) {
    const plan = store.find('plans', planId);
    if (!plan) return fail(`额度计划 ${planId} 不存在`);
    // 缺字段不能被当成「清空窗口」：宁可报错也不要静默把数据抹掉
    if (!Array.isArray(windows)) return fail('windows 必须是数组（要清空请显式传 []）');
    const saved = store.patch('plans', planId, { windows, status: 'ok', error: null, lastCheckedAt: nowIso() });
    alerts.recompute();
    hooks?.onDataChanged?.('plans');
    return done({ record: saved });
  }

  async function refreshQuota(planId) {
    const result = await quota.tick(planId ? { planId } : {});
    alerts.recompute();
    hooks?.onDataChanged?.('plans');
    if (result.status === 'busy') return fail('上一轮额度查询还没结束，本次跳过（串行查询，避免并发）');
    return done(result);
  }

  /* ---------------------------- 额度源（模型可写） ---------------------------- */

  function sourceView(source, includeCode) {
    const record = source.custom ? store.find('sources', source.id) : null;
    const view = {
      id: source.id,
      label: source.label,
      vendor: record?.vendor || source.vendor || '',
      needsCredential: source.needsCredential !== false,
      credentialHint: source.credentialHint || '',
      custom: Boolean(source.custom),
      hosts: record?.hosts || source.hosts || [],
      notes: record?.notes || '',
      lastTestAt: record?.lastTestAt || null,
      lastTestOk: record?.lastTestOk ?? null,
      lastTestError: record?.lastTestError || '',
      updatedAt: record?.updatedAt || null,
    };
    // 只有在明确要求时才带代码：undefined 字段会让工具的输出失去「无损 JSON」属性。
    if (includeCode && record) view.code = record.code;
    return view;
  }

  function listSources(options = {}) {
    const includeCode = Boolean(options.includeCode);
    return done({
      build: 'quota-sources-v1',
      sources: quota.sources().map((source) => sourceView(source, includeCode)),
    });
  }

  /**
   * 试跑额度源：给一段代码（或已有 sourceId）立刻跑一次。
   * 只读——不落库，不写计划；成功后建议再 saveSource。
   */
  async function testSource(input = {}) {
    const wantedId = input.sourceId ? normalizeSourceId(input.sourceId) || String(input.sourceId) : '';
    const saved = wantedId ? store.find('sources', wantedId) : null;
    if (wantedId && !saved) return fail(`额度源 ${input.sourceId} 不存在`);

    const code = String(input.code || saved?.code || '').trim();
    const hosts = normalizeHosts(input.hosts !== undefined ? input.hosts : saved?.hosts || []);
    const needsCredential = input.needsCredential === undefined ? (saved ? saved.needsCredential !== false : true) : Boolean(input.needsCredential);
    const label = safeText(input.label || saved?.label || '试跑额度源', 60);

    const inspected = inspectSourceDraft({ code, hosts });
    if (!inspected.ok) return fail('这段查询代码还不能跑：' + inspected.problems.join('；'));

    const plan = input.planId ? store.find('plans', input.planId) : null;
    if (input.planId && !plan) return fail(`额度计划 ${input.planId} 不存在`);
    let credential = input.credential ? String(input.credential).trim() : '';
    const credentialFromPlan = !credential && Boolean(plan?.credentialRef) && credentials.has(plan.credentialRef);
    if (credentialFromPlan) credential = credentials.get(plan.credentialRef) || '';
    // 借用某个计划的凭证时，绝不允许把请求指向该计划额度源没登记过的域名：
    // 否则 butler_source_test({planId:<claude 计划>, hosts:'evil.example', code:...}) 就能把已存 key 发走。
    if (credentialFromPlan && !hostsCoveredBy(inspected.hosts, plan)) {
      const allowed = planSourceHosts(plan);
      return fail(
        `不能用计划 ${plan.id} 的凭证访问 ${inspected.hosts.join(', ')}：`
        + `这个计划的额度源只登记了 ${allowed.join(', ') || '（无）'}。要试跑新域名，请直接传 credential，或先给这个计划换源。`,
      );
    }
    if (needsCredential && !credential) {
      return fail('这个额度源要凭证才能跑：先给凭证（或指定一个已填好凭证的 planId）再试跑');
    }

    try {
      const out = await runSourceCode({
        code: inspected.code,
        credential,
        plan: plan || { id: 'test', name: label },
        allowHosts: inspected.hosts,
        timeoutMs: Math.max(3000, Number(config.quotaTimeoutMs) || 15000),
      });
      const digest = sourceDigest(inspected.code, inspected.hosts);
      const testedAt = testedSources.get(digest) || 0;
      if (saved) store.patch('sources', saved.id, { lastTestAt: nowIso(), lastTestOk: true, lastTestError: '' });
      testedSources.set(digest, Date.now());
      if (testedSources.size > 200) {
        const cutoff = Date.now() - SOURCE_TEST_TTL_MS;
        for (const [key, at] of testedSources) if (at < cutoff) testedSources.delete(key);
      }
      return done({
        id: saved?.id || '',
        testToken: digest.slice(0, 12),
        windows: out.windows,
        hosts: out.hosts,
        allowedHosts: out.allowedHosts,
        request: out.request || null,
        logs: out.logs,
        ms: out.ms,
        sample: sampleOf(out.raw, credential ? [credential] : [], 2000),
      });
    } catch (error) {
      const message = safeText(error?.message || error, 400);
      if (saved) store.patch('sources', saved.id, { lastTestAt: nowIso(), lastTestOk: false, lastTestError: message });
      return fail(message);
    }
  }

  /**
   * 保存模型写的额度源。要求先试跑通过（skipTest 可绕过，仅给高级用户）。
   */
  function saveSource(input = {}) {
    const label = safeText(input.label, 60);
    if (!label) return fail('额度源要有名称，例如「Cursor 用量」');
    const code = String(input.code || '').trim();
    const hosts = normalizeHosts(input.hosts);
    const inspected = inspectSourceDraft({ code, hosts });
    if (!inspected.ok) return fail('额度源不合法：' + inspected.problems.join('；'));

    const requestedId = input.id ? normalizeSourceId(input.id) : '';
    if (input.id && !requestedId) return fail(`额度源 id 不合法：${input.id}（要形如 custom:cursor）`);
    const existing = requestedId ? store.find('sources', requestedId) : null;
    const codeChanged = !existing || existing.code !== code || String((existing.hosts || []).join(',')) !== hosts.join(',');

    // 强门槛：代码改过就必须重新试跑。没有「跳过」开关——这条路径既能被模型调，也能被面板 HTTP 调，
    // 留一个布尔旁路等于把「用户确认过」这件事变成摆设。
    if (codeChanged) {
      const digest = sourceDigest(code, hosts);
      const testedAt = Math.max(
        testedSources.get(digest) || 0,
        existing && existing.code === code && existing.lastTestOk ? Date.now() : 0,
      );
      const fresh = testedAt > 0 && Date.now() - testedAt <= SOURCE_TEST_TTL_MS;
      if (!fresh) {
        return fail('这段代码还没试跑通过：先 butler_source_test 跑一次，把抓到的窗口给用户看过再保存');
      }
    }

    const id = existing?.id || requestedId || normalizeSourceId(newId('custom:src')) || `custom:src_${Date.now().toString(36)}`;
    const record = normalizeSource({
      ...(existing || {}),
      id,
      label,
      vendor: safeText(input.vendor, 60),
      needsCredential: input.needsCredential === undefined ? true : Boolean(input.needsCredential),
      credentialHint: safeText(input.credentialHint, 240),
      hosts,
      code,
      notes: safeText(input.notes, 400),
      lastTestAt: existing?.lastTestAt || nowIso(),
      lastTestOk: existing?.lastTestOk ?? null,
      lastTestError: existing?.lastTestError || '',
    });
    const savedRecord = store.put('sources', record);
    hooks?.onDataChanged?.('sources');
    return done({ created: !existing, source: sourceView({ ...savedRecord, custom: true }, true) });
  }

  function deleteSource(id) {
    const record = store.find('sources', String(id));
    if (!record) return fail(`额度源 ${id} 不存在`);
    const used = store.list('plans').filter((plan) => plan.sourceId === record.id);
    if (used.length) {
      return fail(`还有额度计划在用这个源（${used.map((plan) => plan.name).join('、')}），先把它们的来源换掉再删`);
    }
    store.remove('sources', record.id);
    hooks?.onDataChanged?.('sources');
    return done({ deleted: true, id: record.id });
  }

  /* ------------------------------ 待办 ------------------------------ */

  async function upsertTodo(input, context = {}) {
    if (!input || typeof input !== 'object') return fail('缺少待办字段');
    const existing = input.id ? store.find('todos', input.id) : null;
    if (input.id && !existing) return fail(`待办 ${input.id} 不存在`);

    const dueAt = input.dueAt === undefined ? existing?.dueAt : toIso(parseWhen(input.dueAt));
    if (input.dueAt !== undefined && input.dueAt !== null && input.dueAt !== '' && !dueAt) {
      return fail(`无法解析提醒时间「${input.dueAt}」，可用 2026-11-11 09:00、明天 9:00、+2h`);
    }

    const record = normalizeTodo({
      ...(existing || {}),
      ...pick(input, ['title', 'detail', 'direction', 'counterpart', 'status', 'priority', 'source', 'confirmed', 'advanceMinutes', 'reminder']),
      dueAt,
      id: existing?.id,
    });
    if (!record.title) return fail('待办必须有标题');

    if (context.sessionId) record.originSessionId = String(context.sessionId).slice(0, 120);
    const saved = store.put('todos', record);
    await reminders.syncItem('todos', saved);
    alerts.recompute();
    hooks?.onDataChanged?.('todos');
    return done({ record: store.find('todos', saved.id) });
  }

  async function removeTodo(id) {
    const record = store.find('todos', id);
    if (!record) return fail(`待办 ${id} 不存在`);
    await reminders.removeAllFor(record);
    store.remove('todos', id);
    alerts.recompute();
    hooks?.onDataChanged?.('todos');
    return done({ deleted: true, id });
  }

  /* ------------------------------ 借贷 ------------------------------ */

  async function upsertDebt(input, context = {}) {
    if (!input || typeof input !== 'object') return fail('缺少借贷字段');
    const existing = input.id ? store.find('debts', input.id) : null;
    if (input.id && !existing) return fail(`借贷 ${input.id} 不存在`);

    const dueAt = input.dueAt === undefined ? existing?.dueAt : toIso(parseWhen(input.dueAt));
    if (input.dueAt !== undefined && input.dueAt !== null && input.dueAt !== '' && !dueAt) {
      return fail(`无法解析约定归还时间「${input.dueAt}」`);
    }
    if (input.amount !== undefined && toNumber(input.amount, -1) <= 0) return fail('借贷金额必须大于 0');

    const record = normalizeDebt({
      ...(existing || {}),
      ...pick(input, ['direction', 'counterpart', 'amount', 'currency', 'status', 'note', 'source', 'advanceMinutes', 'reminder', 'settledAt']),
      dueAt,
      id: existing?.id,
    }, { currency: config.currency });
    if (!record.counterpart) return fail('借贷必须有对方');

    if (record.status === 'settled' && !record.settledAt) record.settledAt = nowIso();
    if (record.status !== 'settled') record.settledAt = null;

    if (context.sessionId) record.originSessionId = String(context.sessionId).slice(0, 120);
    const saved = store.put('debts', record);
    await reminders.syncItem('debts', saved);
    alerts.recompute();
    hooks?.onDataChanged?.('debts');
    return done({ record: store.find('debts', saved.id) });
  }

  async function removeDebt(id) {
    const record = store.find('debts', id);
    if (!record) return fail(`借贷 ${id} 不存在`);
    await reminders.removeAllFor(record);
    store.remove('debts', id);
    alerts.recompute();
    hooks?.onDataChanged?.('debts');
    return done({ deleted: true, id });
  }

  /* ------------------------------ 物品收纳 ------------------------------ */

  /** 面板/模型看到的物品：补上位置描述、数量文案、照片 URL。 */
  function itemView(item) {
    const photos = (item.photoIds || [])
      // 用带签名的视图：配了 apiToken 时 <img src> 也能直接取图
      .map((id) => (photosModule?.view ? photosModule.view(store.find('photos', id)) : photoView(store.find('photos', id))))
      .filter(Boolean);
    const quantity = item.quantity === null || item.quantity === undefined ? null : item.quantity;
    return {
      ...item,
      placeLabel: placeLabel(item),
      quantityLabel: quantity === null ? '' : `${quantity}${item.unit ? ` ${item.unit}` : ''}`,
      photos,
      photoCount: photos.length,
      placedAtLabel: item.placedAt ? fmtDate(item.placedAt) : '',
    };
  }

  function itemHaystack(item) {
    return [item.name, item.location, item.detail, item.note, item.category, (item.tags || []).join(' ')]
      .join(' ')
      .toLowerCase();
  }

  /** 找东西：多词按 AND（「玄关 钥匙」这种最自然的问法也要命中），名称命中的排前面。 */
  function findItems(options = {}) {
    const q = String(options.q || options.query || '').trim().toLowerCase();
    const location = String(options.location || '').trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, Number(options.limit) || 10));
    const words = q.split(/\s+/).filter(Boolean);
    let list = store.list('items').slice();
    if (location) list = list.filter((item) => `${item.location} ${item.detail}`.toLowerCase().includes(location));
    if (words.length) list = list.filter((item) => { const hay = itemHaystack(item); return words.every((word) => hay.includes(word)); });
    list.sort((a, b) => {
      const an = words.length && String(a.name).toLowerCase().includes(words[0]) ? 0 : 1;
      const bn = words.length && String(b.name).toLowerCase().includes(words[0]) ? 0 : 1;
      if (an !== bn) return an - bn;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
    const total = list.length;
    return done({ items: list.slice(0, limit).map(itemView), total, shown: Math.min(total, limit), limit });
  }

  /** 把入参里的照片 id 校验成「已登记、且没被别的物件占用」的字符串 id。 */
  function resolvePhotoIds(rawIds, ownerId) {
    if (rawIds === undefined) return { ids: null };
    if (!Array.isArray(rawIds)) return { error: 'photoIds 必须是数组（元素是照片 id）' };
    const ids = [];
    for (const raw of rawIds) {
      const id = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.id : '';
      if (!id) return { error: 'photoIds 里有认不出来的元素：要传照片 id（字符串），不是整个照片对象' };
      const photo = store.find('photos', id);
      if (!photo) return { error: `照片 ${id} 不存在（可能已经被删了）` };
      if (photo.itemId && photo.itemId !== ownerId) return { error: `照片 ${id} 已经挂在别的物件上了，先从那边移除` };
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length > 12) return { error: `一件东西最多挂 12 张照片，这次给了 ${ids.length} 张` };
    return { ids };
  }

  async function upsertItem(input) {
    if (!input || typeof input !== 'object') return fail('缺少物品字段');
    const existing = input.id ? store.find('items', input.id) : null;
    if (input.id && !existing) return fail(`物品 ${input.id} 不存在`);

    // location 只有「明确给了非空值」才覆盖：空串按未提供处理，免得改个位置把原地点抹掉
    const fields = pick(input, ['name', 'detail', 'quantity', 'unit', 'category', 'note', 'tags', 'photoIds', 'source']);
    if (typeof input.location === 'string' && input.location.trim()) fields.location = input.location;
    else if (input.location && typeof input.location === 'object') return fail('location 要写成文字（房间/柜子/抽屉）');

    const record = normalizeItem({
      ...(existing || {}),
      ...fields,
      // 「昨天」「3 天前」这类说法要按自然语言解析，不能直接喂给 toIso
      placedAt: input.placedAt === undefined ? existing?.placedAt : toIso(parseWhen(input.placedAt)),
      id: existing?.id,
    });
    if (!record.name) return fail('物品要有名字（写清楚是什么东西，比如「充电器」「备用钥匙」）');
    if (!record.location && !record.detail) {
      return fail('要记位置才能帮你找回来：告诉我大概放在哪（房间 / 柜子 / 抽屉都行）');
    }
    const placeAtInput = input.placedAt !== undefined && input.placedAt !== null && input.placedAt !== '';
    if (placeAtInput && !record.placedAt) {
      return fail(`无法解析「${input.placedAt}」这个时间，可以用 2026-11-10、昨天、3 天前 这类说法`);
    }
    // 「明天放的」说不通：只校验这次真正传进来的时间，别拿存量值拦住改名字/改位置。
    if (placeAtInput && record.placedAt && Date.parse(record.placedAt) > Date.now() + 5 * 60 * 1000) {
      return fail(`「${input.placedAt}」是将来时间，收纳记的是已经放好的东西，把日期改成今天或更早`);
    }
    if (record.quantity !== null && (record.quantity < 0 || record.quantity > 1e6)) return fail('数量要在 0 ~ 1000000 之间');

    const resolved = resolvePhotoIds(input.photoIds, record.id || existing?.id);
    if (resolved.error) return fail(resolved.error);
    const photoIds = resolved.ids === null ? [...record.photoIds] : resolved.ids;
    // 只保留真正存在的照片（防止照片记录被删后 item.photoIds 留死链）
    record.photoIds = photoIds.filter((id) => store.find('photos', id));
    for (const id of record.photoIds) {
      const photo = store.find('photos', id);
      if (photo && photo.itemId !== record.id) store.patch('photos', id, { itemId: record.id });
    }
    // 从这条记录上摘掉的图要解绑，否则它既不属于任何物件、又因为「还挂在物件上」而删不掉
    for (const photo of store.list('photos')) {
      if (photo.itemId === record.id && !record.photoIds.includes(photo.id)) {
        store.patch('photos', photo.id, { itemId: null });
      }
    }

    const saved = store.put('items', record);
    hooks?.onDataChanged?.('items');
    const view = itemView(store.find('items', saved.id));
    return done({
      record: view,
      ...(record.photoIds.length < photoIds.length
        ? { warning: `有 ${photoIds.length - record.photoIds.length} 张照片找不到，已经忽略` }
        : {}),
    });
  }

  /** 给已有物品挂照片（工具在写入前先落图，再走这里）。 */
  async function attachPhotos(itemId, photoIds) {
    const item = store.find('items', itemId);
    if (!item) return fail(`物品 ${itemId} 不存在`);
    const existing = (item.photoIds || []).filter((id) => store.find('photos', id));
    const resolved = resolvePhotoIds(Array.isArray(photoIds) ? photoIds : [photoIds], itemId);
    if (resolved.error) return fail(resolved.error);
    const added = resolved.ids.filter((id) => !existing.includes(id));
    if (existing.length + added.length > 12) {
      return fail(`这件东西已经有 ${existing.length} 张照片，最多 12 张；这次要加的 ${added.length} 张没挂上`);
    }
    const merged = [...existing, ...added];
    for (const id of merged) {
      const photo = store.find('photos', id);
      if (photo && photo.itemId !== itemId) store.patch('photos', id, { itemId });
    }
    const saved = store.patch('items', itemId, { photoIds: merged });
    hooks?.onDataChanged?.('items');
    return done({ record: itemView(saved), attached: added.length, skipped: resolved.ids.length - added.length });
  }

  async function removeItem(id) {
    const item = store.find('items', id);
    if (!item) return fail(`物品 ${id} 不存在`);
    let removedPhotos = 0;
    for (const photoId of item.photoIds || []) {
      // 只删属于这条物件的照片；同一张图被多条引用时保留，并把它交还给仍引用它的物件
      const others = store.list('items').filter((other) => other.id !== id && (other.photoIds || []).includes(photoId));
      if (!others.length) {
        photosModule.remove(photoId);
        removedPhotos += 1;
      } else {
        store.patch('photos', photoId, { itemId: others[0].id });
      }
    }
    store.remove('items', id);
    hooks?.onDataChanged?.('items');
    return done({ deleted: true, id, removedPhotos });
  }

  /** 删掉一张没挂在任何物品上的照片（面板取消/换图时用）。已被任何物件引用就拒绝。 */
  async function removePhoto(id) {
    if (!id) return fail('缺少照片 id');
    const photo = store.find('photos', id);
    if (!photo) return fail(`照片 ${id} 不存在`);
    // 以 items.photoIds 为准：photo.itemId 可能是脏数据（过继/历史遗留）
    const owner = store.list('items').find((item) => (item.photoIds || []).includes(id));
    if (owner) return fail(`这张照片还挂在「${owner.name}」上，先从物件里移除再删`);
    photosModule.remove(id);
    hooks?.onDataChanged?.('items');
    return done({ deleted: true, id });
  }

  /* ------------------------------ 通用 ------------------------------ */

  function query(collection, options = {}) {
    const name = String(collection || '').trim();
    if (!COLLECTIONS.includes(name)) return fail(`collection 必须是 ${COLLECTIONS.join(' / ')}`);
    let list = store.list(name).slice();
    if (options.id) {
      const found = list.find((item) => item.id === options.id);
      return done({ collection: name, items: found ? [found] : [], total: found ? 1 : 0 });
    }
    if (options.status) list = list.filter((item) => item.status === options.status);
    if (options.kind) list = list.filter((item) => item.kind === options.kind);
    const total = list.length;
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 50));
    return done({ collection: name, items: list.slice(0, limit), total, limit });
  }

  async function removeRecord(collection, id) {
    switch (collection) {
      case 'assets': return removeAsset(id);
      case 'plans': return removePlan(id);
      case 'todos': return removeTodo(id);
      case 'debts': return removeDebt(id);
      case 'items': return removeItem(id);
      default: return fail(`collection 必须是 ${COLLECTIONS.join(' / ')}`);
    }
  }

  /** 面板的统一写入口。 */
  async function mutate({ collection, op, id, record }, context = {}) {
    if (!COLLECTIONS.includes(collection)) return fail(`collection 必须是 ${COLLECTIONS.join(' / ')}`);
    if (op === 'delete') {
      if (!id) return fail('delete 需要 id');
      return removeRecord(collection, id);
    }
    if (op === 'create' || op === 'update') {
      if (op === 'update' && !id) return fail('update 需要 id');
      // create 带 id 会静默变成 update 并覆盖别人的记录，直接拒掉
      if (op === 'create' && record && record.id) return fail('新建时不要带 id；要改已有记录请用 op=update');
      const payload = { ...(record || {}), ...(id ? { id } : {}) };
      if (collection === 'assets') return upsertAsset(payload, context);
      if (collection === 'plans') return upsertPlan(payload);
      if (collection === 'todos') return upsertTodo(payload, context);
      if (collection === 'debts') return upsertDebt(payload, context);
      if (collection === 'items') return upsertItem(payload);
    }
    return fail(`不支持的 op「${op}」`);
  }

  function registerKind(input) {
    try {
      const rec = kinds.register(input || {});
      hooks?.onDataChanged?.('kinds');
      return done({ kind: rec });
    } catch (error) {
      return fail(error?.message || error);
    }
  }

  /* ------------------------------ 设置 ------------------------------ */

  async function updateSettings(patch) {
    const clean = sanitizePanelConfigPatch(patch);
    if (clean.currency) clean.currency = String(clean.currency).toUpperCase();
    if (!Object.keys(clean).length) return fail('没有可更新的字段');
    if (clean.reminderTarget === 'session' && !String(clean.reminderSession || config.reminderSession || '').trim()) {
      return fail('投递到指定会话需要填会话 id（reminderSession）');
    }
    const overrides = { ...(store.getMeta('settings', {}) || {}), ...clean };
    store.setMeta('settings', overrides);
    const next = deepMerge({ ...config }, clean);
    for (const key of Object.keys(clean)) config[key] = next[key];
    if (clean.pollSeconds !== undefined) hooks?.onPollIntervalChanged?.(Number(config.pollSeconds));
    // 投递目标变了，已排好的提醒必须重排，否则新设置要等下次改记录才生效
    if (clean.reminderTarget !== undefined || clean.reminderSession !== undefined) {
      await reminders.syncAll({ force: true });
    }
    hooks?.onDataChanged?.('settings');
    return done({ config: pick(config, ['currency', 'pollSeconds', 'advanceMinutes', 'reminderTarget', 'reminderSession', 'maxSnapshots']) });
  }

  async function syncReminders(options = {}) {
    const result = await reminders.syncAll({ force: Boolean(options.force) });
    if (result.status === 'busy') return fail('提醒同步正在进行中');
    if (result.status === 'unavailable') return fail('宿主的 schedule 服务不可用，提醒无法建立');
    hooks?.onDataChanged?.('reminders');
    return done(result);
  }

  /* ------------------------------ 给模型看的摘要 ------------------------------ */

  function summary() {
    const now = new Date();
    const assets = store.list('assets').slice().sort((a, b) => {
      const ax = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bx = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
      return ax - bx;
    });
    const todos = store.list('todos').filter((t) => t.status === 'pending')
      .sort((a, b) => String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')));
    const debts = store.list('debts').filter((d) => d.status === 'open');
    const plans = store.list('plans');
    const pendingAlerts = alerts.view().filter((a) => !a.acknowledged);

    const lines = [];
    lines.push(`现在：${fmtLocal(now)}`);

    if (assets.length) {
      lines.push(`\n## 资产（${assets.length} 项）`);
      for (const asset of assets.slice(0, 20)) {
        const expiry = asset.expiresAt ? `${fmtDate(asset.expiresAt)}（${humanDelta(asset.expiresAt, now)}）` : '无到期时间';
        lines.push(`- ${asset.name}${asset.vendor ? ` · ${asset.vendor}` : ''} · ${money(asset.amount, asset.currency)}/${CYCLE_LABEL[asset.cycle] || asset.cycle} · 到期 ${expiry} · id=${asset.id}`);
      }
    } else {
      lines.push('\n## 资产（0 项）—— 还没有记录任何订阅');
    }

    if (plans.length) {
      lines.push(`\n## 额度（${plans.length} 个计划）`);
      for (const plan of plans) {
        const wins = (plan.windows || []).map((w) => {
          const percent = Number.isFinite(Number(w.percent)) ? `${Math.round(Number(w.percent) * 100)}%` : '—';
          const left = w.remaining !== null && w.remaining !== undefined ? `剩 ${w.remaining}` : '';
          return `${w.label} ${percent}${left ? `（${left}${w.unit === 'percent' ? '%' : ''}）` : ''}${w.resetAt ? ` · ${humanDelta(w.resetAt, now)}重置` : ''}`;
        });
        const head = wins.length ? wins.join('；') : plan.status === 'no-credential' ? '未配置额度凭证' : plan.status === 'error' ? `查询失败：${safeText(plan.error, 120)}` : '尚无数据';
        lines.push(`- ${plan.name}（${plan.sourceId}）${plan.lastCheckedAt ? ' · 上次查询 ' + humanDelta(plan.lastCheckedAt, now) : ''}：${head} · id=${plan.id}`);
      }
    }

    lines.push(`\n## 待办（${todos.length} 项待处理）`);
    for (const todo of todos.slice(0, 20)) {
      const due = todo.dueAt ? `${fmtLocal(todo.dueAt)}（${humanDelta(todo.dueAt, now)}）` : '未定时间';
      const who = todo.direction === 'waiting_other' ? `等 ${todo.counterpart || '对方'} 回应` : '我要做';
      lines.push(`- [${todo.priority}] ${todo.title} · ${who} · ${due} · id=${todo.id}`);
    }
    if (!todos.length) lines.push('- （无）');

    const debtTotals = {};
    for (const debt of debts) {
      const currency = debt.currency || config.currency;
      if (!debtTotals[currency]) debtTotals[currency] = { owedToMe: 0, iOwe: 0 };
      if (debt.direction === 'owedToMe') debtTotals[currency].owedToMe += debt.amount;
      else debtTotals[currency].iOwe += debt.amount;
    }
    lines.push(`\n## 借贷（${debts.length} 笔未结清）`);
    for (const debt of debts.slice(0, 20)) {
      const who = debt.direction === 'owedToMe' ? `${debt.counterpart} 欠我` : `我欠 ${debt.counterpart}`;
      lines.push(`- ${who} ${money(debt.amount, debt.currency)}${debt.dueAt ? ` · 约定 ${fmtDate(debt.dueAt)}（${humanDelta(debt.dueAt, now)}）` : ''} · id=${debt.id}`);
    }
    if (!debts.length) lines.push('- （无）');
    if (Object.keys(debtTotals).length) {
      const totals = Object.entries(debtTotals)
        .map(([currency, v]) => `${currency}：别人欠我 ${money(v.owedToMe, currency)} / 我欠别人 ${money(v.iOwe, currency)}`)
        .join('；');
      lines.push(`合计：${totals}`);
    }

    if (pendingAlerts.length) {
      lines.push(`\n## 未确认提醒（${pendingAlerts.length} 条）`);
      for (const alert of pendingAlerts.slice(0, 10)) {
        lines.push(`- [${alert.level}] ${alert.title}：${alert.message} · id=${alert.id}`);
      }
    }

    // 收纳也要出现在「全貌」里：不然模型不知道有这些记录，用户说「挪到书房了」它只能新建一条
    const items = store.list('items').slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const photoTotal = store.list('photos').length;
    if (items.length) {
      lines.push(`\n## 收纳（${items.length} 件，${photoTotal} 张照片）`);
      for (const item of items.slice(0, 20)) {
        const qty = item.quantity === null || item.quantity === undefined ? '' : `${item.quantity}${item.unit ? ` ${item.unit}` : ''} · `;
        const pics = (item.photoIds || []).length ? ` · ${(item.photoIds || []).length} 张照片` : '';
        lines.push(`- ${item.name} · ${placeLabel(item)} · ${qty}${item.placedAt ? fmtDate(item.placedAt) + ' 放入' : '时间未记'}${pics} · id=${item.id}`);
      }
      if (items.length > 20) lines.push(`- （还有 ${items.length - 20} 件，用 butler_item_find 按关键词查）`);
    } else {
      lines.push('\n## 收纳（0 件）—— 还没有记过东西放在哪');
    }

    return {
      text: lines.join('\n'),
      counts: {
        assets: assets.length,
        plans: plans.length,
        todos: todos.length,
        debts: debts.length,
        alerts: pendingAlerts.length,
        items: items.length,
        photos: photoTotal,
      },
    };
  }

  return {
    state,
    summary,
    query,
    mutate,
    removeRecord,
    createPending,
    listPending,
    resolvePending,
    cancelPending,
    upsertAsset,
    upsertPlan,
    upsertTodo,
    upsertDebt,
    upsertItem,
    attachPhotos,
    removePhoto,
    findItems,
    removeAsset,
    removePlan,
    removeTodo,
    removeDebt,
    removeItem,
    setPlanCredential,
    setPlanWindows,
    refreshQuota,
    registerKind,
    updateSettings,
    syncReminders,
    ackAlert(id) {
      const rec = alerts.ack(id);
      if (!rec) return fail(`提醒 ${id} 不存在`);
      hooks?.onDataChanged?.('alerts');
      return done({ alert: rec });
    },
    ackAllAlerts() {
      const count = alerts.ackAll();
      hooks?.onDataChanged?.('alerts');
      return done({ acknowledged: count });
    },
    /** 提醒引擎/额度引擎写库后由 index.js 调回来的通知 */
    notifyChanged(reason) {
      alerts.recompute();
      hooks?.onDataChanged?.(reason);
    },

    /* 额度源（模型可写） */
    listSources,
    testSource,
    saveSource,
    deleteSource,
  };
}

export { isValidIso, normalizeAlert };