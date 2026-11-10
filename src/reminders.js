/**
 * 提醒引擎：把「到期/到点」翻译成宿主 schedule 服务里的定时任务。
 *
 * 为什么不自己 setInterval 轮询投递：宿主已经挂了 dsh-schedule（Automation
 * tasks），它负责持久化、重启后补投、投递到会话。管家只做「建/改/删任务」，
 * 把执行权交给它——这既符合插件协作规范，也让用户在 Automation tasks 页
 * 能看到并手动干预每一条提醒。
 *
 * 加强提醒的实现：到点那条任务的 prompt 指示目标会话的 Agent 立刻用
 * butler_ask 发一组编号选项（纯文字，QQ / 微信也能回），用户必须表态才会继续。
 */

import { fmtLocal, humanDelta, minutesBetween, safeText, toIso } from './util.js';

const MIN_DELAY_SECONDS = 1;
const MIN_USEFUL_MS = 2000;
// 提醒正文改过之后，老任务必须重建（否则已排期的任务还挂着旧文案、旧工具名）。
// 改动提醒文案时把这个版本号 +1，下次 syncAll 会自动重建一遍。
const PROMPT_VERSION = 4;

/** schedule.create 的 timing 入参在不同版本里可能是 at/scheduledAt 或 after_seconds，按顺序试一次并记住可用形状。 */
const TIMING_SHAPES = ['at', 'scheduledAt', 'atMs', 'afterSnake', 'afterCamel'];

function buildTiming(shape, date) {
  const iso = date.toISOString();
  const seconds = Math.max(MIN_DELAY_SECONDS, Math.round((date.getTime() - Date.now()) / 1000));
  switch (shape) {
    case 'at': return { kind: 'at', at: iso };
    case 'scheduledAt': return { kind: 'at', scheduledAt: iso };
    case 'atMs': return { kind: 'at', at: date.getTime() };
    case 'afterSnake': return { kind: 'after', after_seconds: seconds };
    case 'afterCamel': return { kind: 'after', afterSeconds: seconds };
    default: return { kind: 'at', at: iso };
  }
}

function refuseReason(error) {
  const text = String(error?.message || error || '');
  if (/schedule_not_found|not_found/i.test(text)) return 'not-found';
  if (/conflict/i.test(text)) return 'conflict';
  return 'invalid';
}

/**
 * 判断错误是否「可能是 timings 入参形状不对」。
 * 不是所有错误都值得换形状重试：例如指定的会话不存在、权限被拒，换十种形状也照样失败，
 * 反而会把真正的错误掩盖成「schedule.create 失败」。
 */
function looksLikeShapeError(error) {
  const text = String(error?.message || error || '');
  return /timing|scheduled[\s_-]?at|after[\s_-]?seconds|unexpected|unknown|invalid|required|must be|expected|schema|参数|字段/i.test(text);
}

export function createReminders({ store, config, logger, getSchedule, onChange }) {
  let workingTiming = null;
  let syncing = false;
  const lastError = { at: null, message: null };

  function logError(message) {
    lastError.at = new Date().toISOString();
    lastError.message = message;
    logger?.warn?.('[butler] ' + message);
  }

  function schedule() {
    try {
      const svc = getSchedule?.();
      return svc && typeof svc.create === 'function' ? svc : null;
    } catch {
      return null;
    }
  }

  function buildTarget(record) {
    switch (config.reminderTarget) {
      case 'new': return { kind: 'new' };
      // 投回「当初记这条的那个会话」：QQ 里记的，到点提醒就回到那个 QQ 会话
      case 'origin': return record && record.originSessionId
        ? { kind: 'session', sessionId: String(record.originSessionId) }
        : undefined;
      case 'session': return config.reminderSession ? { kind: 'session', sessionId: config.reminderSession } : undefined;
      case 'new_once':
      default: return undefined; // 省略即 new_once（预留一个会话、首次投递创建后复用）
    }
  }

  async function createTask({ title, prompt, when, record }) {
    const svc = schedule();
    if (!svc) throw new Error('schedule service unavailable');

    async function attempt(request) {
      const entry = await svc.create(request);
      const id = entry && (entry.id || entry.record?.id);
      if (!id) throw new Error('schedule.create 未返回 id');
      return String(id);
    }

    const shapes = workingTiming ? [workingTiming, ...TIMING_SHAPES.filter((s) => s !== workingTiming)] : TIMING_SHAPES.slice();
    let lastError = null;
    for (const shape of shapes) {
      const request = { title, prompt, timing: buildTiming(shape, when) };
      const target = buildTarget(record);
      if (target) request.target = target;
      try {
        const id = await attempt(request);
        workingTiming = shape;
        return { id, timingShape: shape };
      } catch (error) {
        lastError = error;
        const reason = refuseReason(error);
        if (reason === 'conflict' || reason === 'not-found') break;
        // 指定的提醒会话可能被归档或删掉了：退回 new_once，否则该条提醒会整体建不起来
        if (request.target && /session/i.test(String(error?.message || error || ''))) {
          delete request.target;
          try {
            const id = await attempt(request);
            workingTiming = shape;
            logError('指定的提醒会话不可用，已退回 new_once 投递');
            return { id, timingShape: shape };
          } catch (retryError) {
            lastError = retryError;
          }
        }
        if (!looksLikeShapeError(error)) break;
      }
    }
    throw lastError || new Error('schedule.create 失败');
  }

  async function deleteTask(id) {
    if (!id) return false;
    const svc = schedule();
    if (!svc || typeof svc.edit !== 'function') return false;
    try {
      await svc.edit({ id, action: 'delete' });
      return true;
    } catch (error) {
      const reason = refuseReason(error);
      if (reason !== 'not-found') logError(`删除提醒任务 ${id} 失败：${error?.message || error}`);
      return false;
    }
  }

  /* -------------------------- 提醒文案 -------------------------- */

  function itemRef(collection, record) {
    const label = record.name || record.title || record.counterpart || record.id;
    return { label: safeText(label, 80), id: record.id };
  }

  function describeItem(collection, record) {
    if (collection === 'assets') {
      const money = `${record.currency || ''} ${record.amount ?? ''}`.trim();
      return `订阅「${record.name}」${money ? `（${money}）` : ''}${record.vendor ? ` · ${record.vendor}` : ''}`;
    }
    if (collection === 'todos') {
      return `待办「${record.title}」${record.counterpart ? `（对方：${record.counterpart}）` : ''}`;
    }
    if (collection === 'debts') {
      const who = record.direction === 'owedToMe' ? `${record.counterpart} 欠我` : `我欠 ${record.counterpart}`;
      return `借贷：${who} ${record.currency || ''} ${record.amount ?? ''}`.trim();
    }
    return `记录 ${record.id}`;
  }

  function buildPrompt({ collection, record, when, kind }) {
    const { label } = itemRef(collection, record);
    const due = fmtLocal(when);
    const delta = humanDelta(when);
    const actionHint = collection === 'assets'
      ? '（若用户表示已续费，用 butler_asset_save 带 id 更新 expiresAt；若已取消，用 butler_delete 删除该条）'
      : collection === 'todos'
        ? '（若已完成，用 butler_todo_save 带 id 把 status 改成 done；若需延后，改 dueAt）'
        : '（若已还清，用 butler_debt_save 带 id 把 status 改成 settled；若延期，改 dueAt）';

    if (kind === 'advance') {
      return [
        `[管家提前提醒] ${describeItem(collection, record)} 约定时间：${due}（${delta}）。`,
        '请依次做三件事，不要复述这条消息的措辞：',
        `1. 先用 butler_query 读一次这条记录的最新状态（collection=${collection}，id=${record.id}），确认它还没被处理；`,
        '2. 用 butler_ask 建一条待确认：question 写「这条要不要现在处理？」，options 给 [现在就处理, 稍后再提醒 10 分钟, 推迟到今晚, 已经处理完了]；',
        '   把它返回的 text 原样发给用户 —— 这段带 1/2/3 编号，用户在 QQ / 手机上直接回数字也能对上。不要用 ask_user_question，聊天通道看不到卡片会卡住。',
        `3. 用户回数字后先 butler_pending_resolve 处理，再按结果更新记录${actionHint}；不要自作主张改动金额与时间。`,
      ].join('\n');
    }

    return [
      `[管家到点提醒·加强] ${describeItem(collection, record)} 已经到时间：${due}（${delta}）。`,
      '这是到点提醒：用 butler_ask 建一条待确认（options 给 [已处理完, 我这就去, 延后 10 分钟, 延后到明天]），把返回的 text 原样发给用户。',
      '不要用 ask_user_question（QQ / 微信看不到，会卡住整轮）；编号文字就是提醒本体。',
      `用户回数字后先 butler_pending_resolve，再按结果更新记录（collection=${collection}，id=${record.id}）${actionHint}；如果延后，把新的 dueAt 设置好，本插件会自动重建下一条提醒。`,
    ].join('\n');
  }

  function taskTitle(collection, record, kind) {
    const { label } = itemRef(collection, record);
    const suffix = kind === 'advance' ? '提前提醒' : '到点提醒';
    const title = `${config.reminderTitlePrefix} · ${label}（${suffix}）`;
    return title.length > 120 ? title.slice(0, 119) + '…' : title;
  }

  /* -------------------------- 同步逻辑 -------------------------- */

  function dueOf(collection, record) {
    if (collection === 'assets') return toIso(record.expiresAt);
    return toIso(record.dueAt);
  }

  function shouldRemind(collection, record) {
    if (record.reminder && record.reminder.enabled === false) return false;
    if (collection === 'todos' && record.status !== 'pending') return false;
    if (collection === 'debts' && record.status !== 'open') return false;
    return true;
  }

  function advanceMinutesFor(record) {
    const raw = record.advanceMinutes ?? record.reminder?.advanceMinutes;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
    return config.advanceMinutes;
  }

  /** 为单条记录建立提醒任务；已存在且指纹一致时跳过。 */
  async function syncItem(collection, record) {
    const svc = schedule();
    if (!svc) return { status: 'unavailable' };

    const dueIso = dueOf(collection, record);
    const existing = record.reminder && typeof record.reminder === 'object' ? record.reminder : {};
    const advanceMinutes = advanceMinutesFor(record);
    const enabled = shouldRemind(collection, record) && Boolean(dueIso);

    if (!enabled) {
      await cleanup(collection, record);
      return { status: 'skipped' };
    }

    const signature = `v${PROMPT_VERSION}|${dueIso}|${advanceMinutes}|${record.status || ''}`;
    const due = new Date(dueIso);
    const now = Date.now();
    if (Number.isNaN(due.getTime()) || due.getTime() < now - 60 * 1000) {
      // 已经过期：清掉陈旧任务，不再制造新提醒
      await cleanup(collection, record);
      return { status: 'past' };
    }

    // 这一轮到底需要哪几条任务——幂等判断必须按「需要的都还在」来算，
    // 否则 advanceMinutes=0 这类只建一条的情况会每次都被判成需要重建。
    const dueSoon = due.getTime() - now;
    const advanceAt = due.getTime() - advanceMinutes * 60 * 1000;
    // advanceMinutes=0 的语义是「只在到点提醒」：这时候再建一条提前提醒，
    // 等于同一时刻叮两次。必须按 advanceMinutes>0 才算需要提前任务。
    const needsAdvance = advanceMinutes > 0 && advanceAt - now > MIN_USEFUL_MS;
    const needsDue = dueSoon > MIN_USEFUL_MS;

    if (existing.sig === signature
      && (!needsAdvance || existing.advanceTaskId)
      && (!needsDue || existing.dueTaskId)) {
      return { status: 'unchanged' };
    }

    // 时间/内容变了：先撤旧任务，再建新任务，避免同一个记录叮两次。
    // 这里把两个 task id 显式清成 null——否则「上一轮有提前任务、这一轮只要到点」时
    // 会留下一个指向已删除任务的死 id，幂等判断也会被它带歪。
    await cleanup(collection, record);

    const patch = {
      reminder: {
        advanceMinutes,
        sig: signature,
        syncedAt: new Date().toISOString(),
        advanceTaskId: null,
        dueTaskId: null,
      },
    };

    try {
      if (needsAdvance) {
        const created = await createTask({
          title: taskTitle(collection, record, 'advance'),
          prompt: buildPrompt({ collection, record, when: new Date(advanceAt), kind: 'advance' }),
          when: new Date(advanceAt),
          record,
        });
        patch.reminder.advanceTaskId = created.id;
      }
      if (needsDue) {
        const created = await createTask({
          title: taskTitle(collection, record, 'due'),
          prompt: buildPrompt({ collection, record, when: due, kind: 'due' }),
          when: due,
          record,
        });
        patch.reminder.dueTaskId = created.id;
      }
      store.patch(collection, record.id, patch);
      onChange?.();
      return { status: 'created' };
    } catch (error) {
      logError(`建立提醒失败（${collection}/${record.id}）：${error?.message || error}`);
      patch.reminder.lastError = String(error?.message || error).slice(0, 300);
      store.patch(collection, record.id, patch);
      return { status: 'error', error: String(error?.message || error) };
    }
  }

  async function cleanup(collection, record) {
    const reminder = record.reminder;
    if (!reminder || typeof reminder !== 'object') return;
    const ids = [reminder.advanceTaskId, reminder.dueTaskId].filter(Boolean);
    if (!ids.length) return;
    for (const id of ids) await deleteTask(id);
    store.patch(collection, record.id, { reminder: { ...reminder, advanceTaskId: null, dueTaskId: null, sig: null } });
  }

  async function removeAllFor(record) {
    const reminder = record?.reminder;
    if (!reminder) return;
    for (const id of [reminder.advanceTaskId, reminder.dueTaskId].filter(Boolean)) await deleteTask(id);
  }

  /** 全量对账：启动时、或用户点「同步提醒」时跑一次。 */
  async function syncAll({ force = false } = {}) {
    if (syncing) return { status: 'busy' };
    const svc = schedule();
    if (!svc) return { status: 'unavailable' };
    syncing = true;
    const stats = { created: 0, unchanged: 0, skipped: 0, past: 0, error: 0, unavailable: 0 };
    try {
      for (const collection of ['assets', 'todos', 'debts']) {
        for (const record of store.list(collection).slice()) {
          let result;
          try {
            result = await syncItem(collection, force ? { ...record, reminder: { ...(record.reminder || {}), sig: null } } : record);
          } catch (error) {
            result = { status: 'error', error };
          }
          stats[result.status] = (stats[result.status] || 0) + 1;
        }
      }
    } finally {
      syncing = false;
    }
    return stats;
  }

  return {
    available() {
      return Boolean(schedule());
    },
    syncItem,
    syncAll,
    cleanup,
    removeAllFor,
    isSyncing() {
      return syncing;
    },
    lastError() {
      return lastError;
    },
    timingShape() {
      return workingTiming;
    },
  };
}