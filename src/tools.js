/**
 * 模型工具（butler_*）。
 *
 * 每个工具都是 service 的薄封装：语义、校验、失败原因与面板 HTTP 路由完全一致
 * （插件规范：一个操作两个调用方，结果必须对得上）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { userImageRefs } from './image-refs.js';
import { fmtLocal, humanDelta, jsonSafe } from './util.js';

function text(value, fallback = '完成') {
  if (!value || value.ok !== true) {
    const message = value?.error || fallback;
    return [{ type: 'text', text: `操作失败：${message}` }];
  }
  return [{ type: 'text', text: value.text || fallback }];
}

function sessionOf(exec) {
  const id = exec && exec.agent && exec.agent.id;
  return id ? String(id) : undefined;
}

const COLLECTION_LABEL = { assets: '资产', plans: '额度计划', todos: '待办', debts: '借贷', items: '物品' };

/** 把 reminder 记录的内部形状翻译成人话（syncItem 写的是任务 id，不是 state 字段）。 */
function describeReminder(reminder) {
  if (!reminder) return '未排程（没有提醒时间）';
  const tasks = [reminder.advanceTaskId, reminder.dueTaskId].filter(Boolean);
  if (!tasks.length) return reminder.reason || '未排程（没有建出提醒任务）';
  return tasks.length > 1
    ? `已排入日程（提前提醒 + 到点提醒，共 ${tasks.length} 条任务）`
    : '已排入日程（1 条提醒任务）';
}


export function registerTools(ctx, service, helpers) {
  const { logger, photos } = helpers;
  const disposers = [];

  /** 把用户这一轮发的图都复制进管家数据目录；返回 photoId 数组（失败抛错，由调用方决定是否致命）。 */
  async function keepUserPhoto(args, exec) {
    if (!photos) throw new Error('当前宿主没有图片服务');
    const refs = userImageRefs(exec);
    const wanted = typeof args?.attachmentId === 'string' ? args.attachmentId.trim() : '';
    // 附件对象上可能叫 attachmentId，也可能只有 id —— 两种都认，免得模型指定了某张却永远匹配不上
    const idOf = (ref) => String(ref?.attachmentId ?? ref?.id ?? '');
    let picked;
    if (wanted) {
      const hit = refs.find((r) => idOf(r) === wanted);
      if (!hit) throw new Error(`找不到附件 ${wanted}（只能是本次对话里上传的图片）`);
      picked = [hit];
    } else {
      // 一次发多张（柜子全貌 / 抽屉内部 / 标签特写）时全部存下来，不要只留最后一张
      picked = refs.slice(-12);
    }
    if (!picked.length) throw new Error('本次对话里没有找到图片：先把照片/截图发进来，我才能一起存下');
    const attachments = (() => {
      try { return ctx.get('attachments'); } catch { return undefined; }
    })();
    const ids = [];
    for (const ref of picked) {
      const record = await photos.saveFromRef(ref, { attachments });
      ids.push(record.id);
    }
    return { ids, totalInMessage: refs.length };
  }

  function register(definition) {
    const execute = definition?.execute;
    const candidate =
      typeof execute === 'function'
        ? {
            ...definition,
            async execute(args, exec) {
              return jsonSafe(await execute.call(this, args, exec));
            },
          }
        : definition;
    try {
      const dispose = ctx.tools.register(candidate);
      disposers.push(dispose);
      return dispose;
    } catch (error) {
      const message = String(error?.message || error);
      if (/duplicate/i.test(message)) {
        logger?.warn?.(`[butler] 工具 ${definition.name} 已存在，跳过重复注册`);
        return () => {};
      }
      logger?.error?.(`[butler] 注册工具 ${definition.name} 失败：${message}`);
      return () => {};
    }
  }

  /* ---------------------------- 只读 ---------------------------- */

  register(defineTool({
    name: 'butler_overview',
    description:
      '查看私人管家当前全貌：资产（订阅/到期时间）、额度监控（各窗口用量与重置时间）、待办、借贷、未确认提醒。'
      + '在用户发来截图并做任何写入前，先调它了解已有记录，避免重复录入。',
    parameters: {
      detail: { type: 'boolean', description: '是否附带每类记录的 id 与明细行（默认 true）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value, '已获取管家全貌') },
    async execute(args) {
      const summary = service.summary();
      const state = service.state();
      return {
        ok: true,
        text: summary.text,
        counts: summary.counts,
        subscriptionTotals: state.summary.subscriptionTotals,
        debtTotals: state.summary.debtTotals,
        diagnostics: state.diagnostics,
      };
    },
  }));

  register(defineTool({
    name: 'butler_query',
    description: '按集合查询私人管家的明细记录：assets（资产/订阅）、plans（额度计划）、todos（待办）、debts（借贷）。',
    parameters: {
      collection: { type: 'string', required: true, description: 'assets | plans | todos | debts' },
      id: { type: 'string', description: '指定记录 id 时只返回这一条' },
      status: { type: 'string', description: '按状态过滤，如 pending / done / open / settled / ok / error' },
      kind: { type: 'string', description: '仅 assets 有效：按资产种类过滤，如 subscription、token_plan' },
      limit: { type: 'number', description: '最多返回几条，默认 50，上限 500' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = service.query(args.collection, args);
      if (!result.ok) return result;
      const label = COLLECTION_LABEL[args.collection] || args.collection;
      const lines = result.data.items.map((item) => `- ${JSON.stringify(item)}`);
      return {
        ok: true,
        text: `${label} 共 ${result.data.total} 条${result.data.total > result.data.items.length ? `（显示前 ${result.data.items.length} 条）` : ''}\n${lines.join('\n') || '- （无）'}`,
        ...result.data,
      };
    },
  }));

  /* ---------------------------- 写入 ---------------------------- */

  register(defineTool({
    name: 'butler_asset_save',
    description:
      '新增或更新一项资产（软件订阅、会员、Token 套餐等）。传 id 表示更新，不传表示新增。'
      + '写入前必须已经和用户确认过名称/金额/到期时间/周期。'
      + '同一款软件如果旧记录已经过期，不传 id 也会自动续期到那条旧记录（不会多出一条重复的）；'
      + '如果用户确实有第二个账号要并存，传 allowDuplicate=true。',
    parameters: {
      id: { type: 'string', description: '要更新的资产 id；新增时留空' },
      name: { type: 'string', required: true, description: '资产名称，如 Claude Pro、腾讯视频会员' },
      vendor: { type: 'string', description: '提供方/厂商，如 Anthropic、腾讯' },
      amount: { type: 'number', description: '每个周期的金额，如 20' },
      currency: { type: 'string', description: '币种，如 CNY、USD；留空用配置默认' },
      cycle: { type: 'string', description: '计费周期：monthly | quarterly | yearly | weekly | once' },
      kind: { type: 'string', description: '资产种类：subscription（默认）| token_plan | 其他已注册种类' },
      expiresAt: { type: 'string', description: '到期/下次续费时间，支持 2026-12-10、2026-12-10 18:00、明天 9点 等' },
      autoRenew: { type: 'boolean', description: '是否自动续费' },
      notes: { type: 'string', description: '备注' },
      source: { type: 'string', description: '来源：screenshot | manual | model' },
      allowDuplicate: { type: 'boolean', description: '同一款软件要建第二条（另一个账号）时传 true' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const result = await service.upsertAsset(args, { sessionId: sessionOf(exec) });
      if (!result.ok) return result;
      const record = result.data.record;
      const renewed = Boolean(result.data.renewed);
      const previous = result.data.previous;
      return {
        ok: true,
        text: (renewed
          ? `已续期原有订阅：${record.name}（${record.id}）· 原到期 ${previous?.expiresAt || '—'} → 新到期 ${record.expiresAt || '—'}`
          : `已记录资产：${record.name}（${record.id}）· ${record.amount} ${record.currency}/${record.cycle}`)
          + `${renewed ? ` · ${record.amount} ${record.currency}/${record.cycle}` : ''}`
          + `${!renewed && record.expiresAt ? ` · 到期 ${record.expiresAt}` : ''}`
          + (renewed ? '\n没有新建重复记录，面板里那条旧订阅已经更新。' : '')
          + (result.data.kindAutoRegistered ? `\n注意：种类「${record.kind}」是新建的，已加入资产种类列表。` : ''),
        renewed,
        previous,
        record,
        kindAutoRegistered: result.data.kindAutoRegistered,
      };
    },
  }));

  register(defineTool({
    name: 'butler_plan_save',
    description:
      '新增或更新一个额度监控计划（Token 套餐的用量看板）。凭证本身不在这里传——用 butler_credential_set。'
      + 'sourceId 决定用哪个内置适配器：claude-usage、deepseek、openai、generic（自定义 HTTP）、manual（只手动填）。',
    parameters: {
      id: { type: 'string', description: '要更新的计划 id；新增时留空' },
      name: { type: 'string', required: true, description: '计划名称，如 Claude Pro 额度' },
      sourceId: { type: 'string', description: '额度源：claude-usage | deepseek | openai | generic | manual' },
      assetId: { type: 'string', description: '关联的资产 id（该套餐对应的订阅资产）' },
      planLabel: { type: 'string', description: '套餐档位说明，如 Pro / Max 20x' },
      thresholdsWarn: { type: 'number', description: '告警阈值，0~1，默认 0.8' },
      thresholdsCritical: { type: 'number', description: '严重阈值，0~1，默认 0.95' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = await service.upsertPlan({
        id: args.id,
        name: args.name,
        sourceId: args.sourceId,
        assetId: args.assetId,
        planLabel: args.planLabel,
        thresholds: {
          ...(args.thresholdsWarn === undefined ? {} : { warn: args.thresholdsWarn }),
          ...(args.thresholdsCritical === undefined ? {} : { critical: args.thresholdsCritical }),
        },
      });
      if (!result.ok) return result;
      const record = result.data.record;
      return {
        ok: true,
        text: `已建立额度计划：${record.name}（${record.id}）· 来源 ${record.sourceId}`
          + `\n凭证状态：${record.hasCredential ? '已配置' : '未配置'}`
          + `\n提示：${result.data.credentialHint}`,
        record,
        credentialHint: result.data.credentialHint,
      };
    },
  }));

  register(defineTool({
    name: 'butler_todo_save',
    description:
      '新增或更新一条待办。direction=awaiting_me 表示我要做的事；waiting_other 表示我在等别人。'
      + 'dueAt 同时是提醒时间：管家会在提前 advanceMinutes 分钟提醒一次，到点再加强提醒一次。'
      + '提醒时间必须先和用户确认。',
    parameters: {
      id: { type: 'string', description: '要更新的待办 id；新增时留空' },
      title: { type: 'string', required: true, description: '待办标题（一句话说明要做什么）' },
      detail: { type: 'string', description: '补充细节、原话、来源' },
      direction: { type: 'string', description: 'awaiting_me（默认，我要做）| waiting_other（我在等对方）' },
      counterpart: { type: 'string', description: '对方是谁（如 张三、老板）' },
      dueAt: { type: 'string', description: '到期/提醒时间，支持 明天 9:00、2026-11-11 09:00、+2h' },
      priority: { type: 'string', description: 'low | normal | high' },
      status: { type: 'string', description: 'pending（默认）| done | cancelled' },
      advanceMinutes: { type: 'number', description: '提前多少分钟提醒，默认取配置值' },
      confirmed: { type: 'boolean', description: '是否已和用户确认过提醒时间' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const result = await service.upsertTodo({ ...args, source: args.source || 'model' }, { sessionId: sessionOf(exec) });
      if (!result.ok) return result;
      const record = result.data.record;
      const what = record.direction === 'waiting_other' ? `等 ${record.counterpart || '对方'} 回应` : '我要做';
      return {
        ok: true,
        text: `已记录待办：${record.title}（${record.id}）· ${what}`
          + `${record.dueAt ? ` · 提醒 ${fmtLocal(record.dueAt)}（${humanDelta(record.dueAt)}）` : ' · 未定提醒时间'}`
          + `\n提醒状态：${describeReminder(record.reminder)}`,
        record,
      };
    },
  }));

  register(defineTool({
    name: 'butler_debt_save',
    description:
      '新增或更新一笔借贷。direction=owedToMe 表示别人欠我；iOwe 表示我欠别人。'
      + '有约定归还时间时填 dueAt，管家会在提前几天和到期时提醒。',
    parameters: {
      id: { type: 'string', description: '要更新的借贷 id；新增时留空' },
      counterpart: { type: 'string', required: true, description: '对方姓名' },
      direction: { type: 'string', description: 'owedToMe（默认，别人欠我）| iOwe（我欠别人）' },
      amount: { type: 'number', description: '金额，必须大于 0' },
      currency: { type: 'string', description: '币种，默认取配置' },
      dueAt: { type: 'string', description: '约定归还时间' },
      status: { type: 'string', description: 'open（默认）| settled（已结清）' },
      note: { type: 'string', description: '备注、原话、凭证来源' },
      advanceMinutes: { type: 'number', description: '提前多少分钟提醒' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const result = await service.upsertDebt({ ...args, source: args.source || 'model' }, { sessionId: sessionOf(exec) });
      if (!result.ok) return result;
      const record = result.data.record;
      const who = record.direction === 'owedToMe' ? `${record.counterpart} 欠我` : `我欠 ${record.counterpart}`;
      return {
        ok: true,
        text: `已记录借贷：${who} ${record.amount} ${record.currency}（${record.id}）`
          + ` · ${record.status === 'settled' ? '已结清' : record.dueAt ? `约定 ${record.dueAt} 归还` : '未约定归还时间'}`,
        record,
      };
    },
  }));

  register(defineTool({
    name: 'butler_delete',
    description: '删除一条管家记录（资产/额度计划/待办/借贷）。删除前应和用户确认。',
    parameters: {
      collection: { type: 'string', required: true, description: 'assets | plans | todos | debts' },
      id: { type: 'string', required: true, description: '记录 id' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = await service.removeRecord(args.collection, args.id);
      if (!result.ok) return result;
      return { ok: true, text: `已删除 ${COLLECTION_LABEL[args.collection] || args.collection} 记录 ${args.id}`, ...result.data };
    },
  }));

  /* ---------------------------- 额度 ---------------------------- */

  register(defineTool({
    name: 'butler_credential_set',
    description:
      '保存某个额度计划访问第三方官网用量接口的凭证（API key / 官网 cookie / OAuth token，视平台而定）。'
      + '注意：这不是 DSH 的模型配置，二者互不复用。凭证会落盘到宿主 credentials，不出现在配置文件和面板上。'
      + '**建议优先引导用户在「管家设置」面板里自己填，避免凭证出现在会话记录里**；只有用户明确要求你代填时才调用。',
    parameters: {
      planId: { type: 'string', required: true, description: '额度计划 id' },
      credential: { type: 'string', required: true, description: '凭证原文（key/cookie/token）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = service.setPlanCredential(args.planId, args.credential);
      if (!result.ok) return result;
      return { ok: true, text: `凭证已保存到计划的 credentials 记录（计划 ${args.planId}）。建议紧接着调 butler_quota_refresh 验证是否可用。`, ...result.data };
    },
  }));

  register(defineTool({
    name: 'butler_quota_refresh',
    description:
      '立即查询额度（不传 planId 就查全部）。查询是串行单飞的：上一轮没结束会直接跳过并告知，这是为了避免并发打满宿主机。',
    parameters: {
      planId: { type: 'string', description: '只查这一个计划；留空查全部' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = await service.refreshQuota(args.planId);
      if (!result.ok) return result;
      const data = result.data;
      const lines = (data.results || []).map((item) => {
        const label = item.name ? `${item.name}（${item.planId}）` : item.planId;
        if (item.status === 'no-credential') return `- ${label}：缺凭证，先在面板「填凭证」再查`;
        if (item.status === 'manual') return `- ${label}：手动源，没有自动窗口`;
        if (item.status !== 'ok') return `- ${label}：失败 ${item.error || '未知错误'}`;
        const wins = (item.windows || [])
          .map((w) => (w.percent === null || w.percent === undefined
            ? `${w.label} 余额 ${w.remaining ?? w.used ?? '—'}`
            : `${w.label} ${Math.round(w.percent * 100)}%`))
          .join('；');
        return `- ${label}：${wins || '无窗口数据'}`;
      });
      return { ok: true, text: `额度查询完成（${data.results?.length || 0} 个计划）\n${lines.join('\n') || '- 无计划'}`, ...data };
    },
  }));

  /* ---------------------------- 额度源（模型可写） ---------------------------- */

  const SOURCE_CONTRACT = [
    '查询代码是一个 async 函数，入参一个对象：',
    '{ http, credential, plan, kit, now, console }',
    '- http.get(url, { headers }) / http.post(url, body, { headers }) / http.request({ url, method, headers, body, parse })',
    '  返回 { status, ok, text, json }；只允许访问 hosts 里登记的域名，强制超时。',
    '- credential：这个额度源的用户凭证（可能为空字符串）；自己决定放 Bearer 还是 query 还是 cookie。',
    '- kit.num(v, 兜底) / kit.pct(used, limit) / kit.iso(v) / kit.get(obj, "a.b[0].c") / kit.ms.now()',
    '- console.log 会被收集进 logs，方便调试（不会打扰用户）。',
    '必须返回窗口数组，元素形如：',
    '{ key: "monthly", label: "本月额度", limit: 100, used: 31, remaining: 69, percent: 31, unit: "percent", resetAt: "2026-12-01T00:00:00Z" }',
    'percent 写 0~100 或 0~1 都行（>1 时按百分数处理）；resetAt 可用 ISO 字符串、秒/毫秒时间戳，或 kit.iso(x)。',
    '安全边界（要如实告诉用户，不许淡化）：查询代码按「用户自己写的脚本」对待，',
    '默认在独立 worker 线程里跑（死循环会被强制终止、不卡宿主），只能访问 hosts 登记的域名，',
    '有超时与响应体积上限。但 node:vm 不是安全沙箱——沙箱里默认拿不到 fs/process/require，',
    '那是能力上没提供，不是技术上绕不过去。所以：绝不接受来路不明的代码，一次查询最多发 2~3 个请求。',
  ].join('\n');

  register(defineTool({
    name: 'butler_source_list',
    description:
      '列出可用的额度源：内置（claude-usage / deepseek / openai / generic / manual）和模型之前写好的自定义源（custom:*）。'
      + '要给某个平台建额度监控前先看这里——已经有对应源就直接用 sourceId，不要重复造。',
    parameters: {
      includeCode: { type: 'boolean', description: '是否连查询代码一起返回（默认 false，只看名字/id/hosts）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value, '已列出额度源') },
    async execute(args) {
      const result = service.listSources({ includeCode: Boolean(args.includeCode) });
      if (!result.ok) return result;
      const list = result.data.sources;
      const lines = list.map((s) => `- ${s.id}｜${s.label}${s.custom ? '（自定义）' : ''}${s.hosts?.length ? ' · ' + s.hosts.join(',') : ''}${s.lastTestOk === false ? ' · 上次试跑失败' : ''}`);
      return { ok: true, text: `可选额度源 ${list.length} 个\n${lines.join('\n')}`, sources: list };
    },
  }));

  register(defineTool({
    name: 'butler_source_test',
    description:
      '用真实请求试跑一段额度查询代码（不保存）。遇到没有内置源的平台时，你先写代码、先试跑，'
      + '把试跑结果（抓到哪些窗口、原始响应长什么样）摆给用户看，用户确认后再 butler_source_save。\n'
      + SOURCE_CONTRACT,
    parameters: {
      code: { type: 'string', description: '查询代码（async 函数）。给了 code 就试跑它；不给则试跑 sourceId 指向的已保存源' },
      hosts: { type: 'string', description: '这段代码允许访问的域名，逗号分隔，如 api.cursor.com 或 *.openai.com' },
      label: { type: 'string', description: '给这次试跑起的名字，只用于展示' },
      planId: { type: 'string', description: '可选：借用这个额度计划已保存的凭证来试跑' },
      credential: { type: 'string', description: '可选：直接给一个临时凭证（优先用 planId 里的，避免凭证进会话）' },
      sourceId: { type: 'string', description: '可选：试跑已保存的额度源（改完代码想看效果时用）' },
      needsCredential: { type: 'boolean', description: '这个源是否需要凭证，默认 true' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = await service.testSource({
        code: args.code,
        hosts: args.hosts,
        label: args.label,
        planId: args.planId,
        credential: args.credential,
        sourceId: args.sourceId,
        needsCredential: args.needsCredential,
      });
      if (!result.ok) return result;
      const data = result.data;
      const winLines = data.windows.map((w) => {
        const reset = w.resetAt ? `，重置 ${fmtLocal(w.resetAt)}（${humanDelta(w.resetAt)}）` : '，重置时间未知';
        // 只有余额没有总额度的窗口（DeepSeek 余额等）没有百分比，硬写「已用 —」是假信息
        if (w.percent === null || w.percent === undefined) {
          const left = w.remaining === null || w.remaining === undefined ? '—' : w.remaining;
          return `- ${w.label}：剩余 ${left}${w.unit ? '（' + w.unit + '）' : ''}${reset}`;
        }
        const pct = `${Math.round(w.percent * 100)}%`;
        const left = w.remaining === null || w.remaining === undefined ? '' : `，剩余 ${w.remaining}`;
        return `- ${w.label}：已用 ${pct}${left}${reset}`;
      });
      return {
        ok: true,
        text:
          `试跑成功（${data.ms}ms，访问 ${data.hosts.join(', ') || '无'}）\n`
          + `${winLines.join('\n')}\n`
          + `原始响应（已抹掉凭证、截断）：\n${data.sample || '（代码没有返回 raw 样本）'}\n\n`
          + '下一步：把上面的窗口和样本给用户看，**问一句确认**，用户点头后再调 butler_source_save。',
        windows: data.windows,
        hosts: data.hosts,
        logs: data.logs,
        ms: data.ms,
        sample: data.sample,
      };
    },
  }));

  register(defineTool({
    name: 'butler_source_save',
    description:
      '保存一段查询代码，成为可复用的额度源（id 形如 custom:cursor）。保存后就能在 butler_plan_save 里用 sourceId 指向它，'
      + '由引擎按 pollSeconds 自动刷新。硬要求：**必须先 butler_source_test 跑通并让用户确认**，否则会拒绝保存。\n'
      + SOURCE_CONTRACT,
    parameters: {
      label: { type: 'string', required: true, description: '额度源名称，如「Cursor 用量」' },
      code: { type: 'string', required: true, description: '查询代码（async 函数）' },
      hosts: { type: 'string', required: true, description: '允许访问的域名，逗号分隔，如 api.cursor.com' },
      id: { type: 'string', description: '可选：已有源就用它的 id（custom:xxx）做更新；不给则新建' },
      vendor: { type: 'string', description: '平台名，如 Cursor' },
      needsCredential: { type: 'boolean', description: '是否需要凭证，默认 true' },
      credentialHint: { type: 'string', description: '告诉用户去哪儿拿凭证（写清楚「不是 DSH 模型 key」）' },
      notes: { type: 'string', description: '备注：接口来源、坑位、失效时间等' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = service.saveSource({
        id: args.id,
        label: args.label,
        code: args.code,
        hosts: args.hosts,
        vendor: args.vendor,
        needsCredential: args.needsCredential,
        credentialHint: args.credentialHint,
        notes: args.notes,
      });
      if (!result.ok) return result;
      const source = result.data.source;
      return {
        ok: true,
        text: `${result.data.created ? '已新建' : '已更新'}额度源：${source.label}（${source.id}）\n`
          + `允许访问：${source.hosts.join(', ')}\n`
          + `下一步：butler_plan_save { name, sourceId: "${source.id}" } 建监控计划，然后 butler_quota_refresh 验证一次。`,
        source,
      };
    },
  }));

  register(defineTool({
    name: 'butler_source_delete',
    description: '删除一个自定义额度源；还有计划在用它时会拒绝，先把那些计划的来源换掉。',
    parameters: {
      id: { type: 'string', required: true, description: '额度源 id（custom:xxx）' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = service.deleteSource(args.id);
      if (!result.ok) return result;
      return { ok: true, text: `已删除额度源 ${args.id}` };
    },
  }));

  /* ---------------------------- 扩展/杂项 ---------------------------- */

  register(defineTool({
    name: 'butler_kind_register',
    description: '注册一种新的资产种类（L3 扩展）。当截图里出现现有种类覆盖不了的东西（域名、服务器、保险、会员卡）时先注册再记录。',
    parameters: {
      id: { type: 'string', required: true, description: '种类标识，小写字母/数字/下划线/连字符，如 server、insurance' },
      label: { type: 'string', description: '中文名，如 服务器' },
      hint: { type: 'string', description: '识别提示：什么样的截图属于这一类，给后续识别用' },
      collection: { type: 'string', description: '归属集合，默认 assets' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = service.registerKind(args);
      if (!result.ok) return result;
      return { ok: true, text: `已注册种类：${result.data.kind.label}（${result.data.kind.id}）`, kind: result.data.kind };
    },
  }));

  register(defineTool({
    name: 'butler_alerts',
    description: '查看或处理未确认提醒（到期、额度超阈值、逾期借贷）。action=list 只看；ack 确认一条；ackAll 全部确认。',
    parameters: {
      action: { type: 'string', description: 'list（默认）| ack | ackAll' },
      id: { type: 'string', description: 'action=ack 时的提醒 id' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const action = args.action || 'list';
      if (action === 'ack') {
        if (!args.id) return { ok: false, error: 'ack 需要 id' };
        const result = service.ackAlert(args.id);
        if (!result.ok) return result;
        return { ok: true, text: `已确认提醒 ${args.id}` };
      }
      if (action === 'ackAll') {
        const result = service.ackAllAlerts();
        return { ok: true, text: `已确认 ${result.data.acknowledged} 条提醒` };
      }
      const list = service.state().alerts.filter((a) => !a.acknowledged);
      const lines = list.map((a) => `- [${a.level}] ${a.title}：${a.message} · id=${a.id}`);
      return { ok: true, text: `未确认提醒 ${list.length} 条\n${lines.join('\n') || '- （无）'}`, alerts: list };
    },
  }));

  register(defineTool({
    name: 'butler_reminders_sync',
    description: '把待办/借贷/资产的提醒重新对账到宿主的定时任务（改完时间、修好配置后调一次）。',
    parameters: {
      force: { type: 'boolean', description: '忽略指纹强制重建，默认 false' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = await service.syncReminders({ force: Boolean(args.force) });
      if (!result.ok) return result;
      const data = result.data;
      return {
        ok: true,
        text: `提醒对账完成：新建 ${data.created || 0}，沿用 ${data.kept || 0}，清理 ${data.removed || 0}`
          + (data.skippedPast ? `，已过期跳过 ${data.skippedPast}` : ''),
        ...data,
      };
    },
  }));


  /* ------------------------------ 物品收纳 ------------------------------ */

  register(defineTool({
    name: 'butler_item_save',
    description:
      '记录「家里的东西放在哪了」（收纳）。用户发照片或文字说「这个放哪了」时用。'
      + '必须问清：是什么东西、放在哪（房间/柜子/抽屉都可以；location 与 detail 至少给一个）、多少件、什么时候放的；'
      + '用户发的是照片，就先从图里认出是什么东西、放在哪、有几件，再和他确认。'
      + '用户这次消息里带了图片时会自动把图一起存下来（这条消息里有多张就全部存，最多 12 张；只认这次的消息，不会翻出旧截图）。'
      + '同一个东西换位置时带 id 更新，不要新建；想指定某一张图才传 attachmentId，不要存图时传 keepPhoto=false。'
      + '要改/删已有的照片：把想保留的照片 id 放进 photoIds（可从 butler_item_find 的返回里取），空数组表示全部摘掉。',
    parameters: {
      id: { type: 'string', description: '要更新的物品 id；新增留空' },
      name: { type: 'string', required: true, description: '物品名称，如 充电器、备用钥匙、圣诞装饰' },
      location: { type: 'string', description: '位置，如 书房、阳台储物柜、电视柜抽屉（与 detail 至少给一个）' },
      detail: { type: 'string', description: '更细的位置，如 第 2 层左边、贴着冰箱那侧' },
      quantity: { type: 'number', description: '数量，如 2（0 ~ 1000000）' },
      unit: { type: 'string', description: '数量单位，如 个 / 把 / 盒' },
      category: { type: 'string', description: '分类，如 电子配件 / 证件 / 药' },
      placedAt: { type: 'string', description: '什么时候放的，支持 2026-11-10、昨天、3 天前（不能是将来时间）' },
      note: { type: 'string', description: '备注：干嘛用的、和什么放一起、多久没用过' },
      tags: { type: 'string', description: '关键词，逗号或空格分隔，方便以后搜' },
      photoIds: { type: 'array', description: '要保留的照片 id 列表；不传=不动已有照片，传 []=全部摘掉' },
      attachmentId: { type: 'string', description: '指定某一张图（一般不用传，默认把这条消息里的图都存下来）' },
      keepPhoto: { type: 'boolean', description: '传 false 表示这次不要存图，只记位置' },
      source: { type: 'string', description: '来源：screenshot | manual | model' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const payload = { ...args };
      for (const key of ['attachmentId', 'keepPhoto']) delete payload[key];
      const result = await service.upsertItem(payload);
      if (!result.ok) return result;
      let record = result.data.record;
      let photoNote = '';
      if (args.keepPhoto !== false) {
        const refs = userImageRefs(exec);
        const hasImage = refs.length > 0;
        const wanted = typeof args.attachmentId === 'string' && args.attachmentId.trim();
        if (hasImage || wanted) {
          try {
            const kept = await keepUserPhoto(args, exec);
            const attached = await service.attachPhotos(record.id, kept.ids);
            if (attached.ok) {
              record = attached.data.record;
              const stored = attached.data.attached ?? kept.ids.length;
              const skipped = attached.data.skipped ?? 0;
              photoNote = `\n照片已一起存好（存了 ${stored} 张，这件东西现在共 ${record.photoCount} 张）`
                + (skipped ? `；另有 ${skipped} 张本来就挂在这件东西上，没有重复存` : '')
                + (kept.totalInMessage > kept.ids.length ? `。这条消息一共 ${kept.totalInMessage} 张，只存了最近 ${kept.ids.length} 张` : '');
            } else {
              photoNote = `\n（图片已经存进管家目录，但没挂到记录上：${attached.error}）`;
            }
          } catch (error) {
            // 图片没存上不该让整次调用变成「失败」：物品其实已经记好了，重试会产生重复记录
            photoNote = `\n⚠ 物品已记录，但图片没存上：${error?.message || error}`;
          }
        }
      }
      return {
        ok: true,
        ...(result.data.warning ? { warning: result.data.warning } : {}),
        text: `已收纳：${record.name} · ${record.placeLabel}${record.quantityLabel ? ` · ${record.quantityLabel}` : ''}`
          + `${record.placedAtLabel ? ` · ${record.placedAtLabel} 放的` : ''}（id=${record.id}）${photoNote}`,
        record,
      };
    },
  }));

  register(defineTool({
    name: 'butler_item_find',
    description:
      '按关键词找家里的东西（名称/位置/备注/标签全都能搜）。用户问「我的 XX 在哪」「XX 放哪儿了」时先查这里，再回答。'
      + '查到几条就把位置、数量、放的时间说清楚；同时告诉他有没有照片。',
    parameters: {
      q: { type: 'string', description: '关键词，如 充电器、钥匙、药' },
      location: { type: 'string', description: '只看某个位置，如 书房' },
      limit: { type: 'number', description: '最多返回几条，默认 10' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = service.findItems(args);
      if (!result.ok) return result;
      const { items, total, shown, limit } = result.data;
      if (!items.length) {
        return { ok: true, text: '没找到记录。可以让用户换个说法，或者问问他最近一次见到是什么时候、大概在哪个房间。', items: [], total: 0, shown: 0, limit };
      }
      const lines = items.map((item) => `- ${item.name} → ${item.placeLabel}`
        + `${item.quantityLabel ? ` · ${item.quantityLabel}` : ''}`
        + `${item.placedAtLabel ? ` · ${item.placedAtLabel} 放的` : ''}`
        + `${item.photoCount ? ` · ${item.photoCount} 张照片` : ''}`
        + `${item.note ? ` · 备注：${item.note}` : ''}（id=${item.id}）`);
      const head = total > shown
        ? `共 ${total} 条，这里显示前 ${shown} 条（要更多可以调 limit，最多 50；或加 location 缩小范围）：`
        : `找到 ${total} 条：`;
      return { ok: true, text: `${head}\n${lines.join('\n')}`, items, total, shown, limit };
    },
  }));

  register(defineTool({
    name: 'butler_item_delete',
    description: '删除一条收纳记录（东西拿走了/记错了）。删之前先和用户确认；它会把自己独占的照片一起删掉，仍被别的记录引用的照片会保留。',
    parameters: {
      id: { type: 'string', required: true, description: '物品 id' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = await service.removeItem(args.id);
      if (!result.ok) return result;
      const removed = result.data.removedPhotos || 0;
      return { ok: true, text: `已删除收纳记录 ${args.id}${removed ? `（一起删掉 ${removed} 张照片）` : '（照片被别的记录引用，保留着）'}` };
    },
  }));

  register(defineTool({
    name: 'butler_ask',
    description: '把一次「要用户在几个选项里选一个」的提问落盘，并返回一段可以直接发给用户的编号文本（1/2/3…）。'
      + '用户在 QQ、微信、手机上看不到选项卡片时就用它：文本发过去，用户在任意会话里回「1」，'
      + '你用 butler_pending_resolve 就能对上同一条，不依赖卡片。'
      + '需要确认后直接落库（记资产/待办/借贷、改时间）时，把 collection + op + record（JSON 字符串）一起带上，'
      + '并把第一个选项（也就是「就按这个记」）设成 applies:true —— 用户回 1 就直接写入。'
      + '用法：先 butler_ask 拿到 text，再把 text 原样回复给用户（不要自己重排编号）。',
    parameters: {
      question: { type: 'string', required: true, description: '要问用户的话，一句话说清（如「这笔订阅记成这样对吗？」）' },
      options: { type: 'array', description: '选项数组，2~8 个；字符串如 ["对，就这样记","金额不对","日期不对"]，也可以是对象 {"label":"…","applies":true}' },
      title: { type: 'string', description: '短标题，显示成【标题】，如「确认订阅」；可留空' },
      collection: { type: 'string', description: '选项 1 要落到哪张表：assets / plans / todos / debts / items；不落库就不传' },
      op: { type: 'string', description: 'create（默认）/ update / delete' },
      record: { type: 'string', description: '要写入的记录内容，JSON 字符串（如 {"name":"Claude Pro","amount":20,"cycle":"monthly"}）；delete 时不用传' },
      id: { type: 'string', description: 'update / delete 的目标 id' },
      ttlMinutes: { type: 'number', description: '多少分钟内有效，默认 120，最大 1440' },
      source: { type: 'string', description: '来源：screenshot | manual | model' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => (value?.ok === true
        ? [{ type: 'text', text: `${value.text}\n\n[内部] 待确认 id=${value.id}，用户回答后用 butler_pending_resolve(id, choice) 处理；上面这段才是发给用户看的。` }]
        : text(value)),
    },
    async execute(args) {
      const input = { ...args };
      if (typeof input.record === 'string') {
        try {
          input.record = JSON.parse(input.record);
        } catch {
          return { ok: false, error: 'record 不是合法 JSON，检查一下引号/逗号' };
        }
      }
      const result = await service.createPending(input);
      if (!result.ok) return result;
      return {
        ok: true,
        id: result.data.pending.id,
        text: result.data.text,
        expiresAt: result.data.pending.expiresAt,
        hint: '把 text 原样发给用户。用户回数字（或选项原文）后，调 butler_pending_resolve。',
      };
    },
  }));

  register(defineTool({
    name: 'butler_pending_list',
    description: '看现在有哪些还没回答的待确认问题（跨会话有效，QQ 里问的、Web 里问的都在这里）。'
      + '收到用户一条含义不明的短回复（「1」「好」「行」「改一下」）时，先调它看看是不是在回答某个问题。',
    parameters: {
      status: { type: 'string', description: 'open（默认）/ answered / applied / cancelled / expired / all' },
      limit: { type: 'number', description: '最多几条，默认 20' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = service.listPending(args);
      if (!result.ok) return result;
      return { ok: true, count: result.data.count, pending: result.data.pending, text: result.data.text };
    },
  }));

  register(defineTool({
    name: 'butler_pending_resolve',
    description: '回答一条待确认：choice 可以是编号（1/2/3）、选项原文，或「2. 改日期」这种。'
      + '如果这条带着要落库的内容、且选中的选项标记了 applies，会直接把记录写进去并告诉你结果。'
      + '回答不上就把它返回的可选列表原样回给用户，不要自己猜。',
    parameters: {
      id: { type: 'string', required: true, description: '待确认 id（butler_pending_list 里的 id）' },
      choice: { type: 'string', required: true, description: '用户的选择：1 / 2 / 选项原文' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const result = await service.resolvePending({ ...args, sessionId: sessionOf(exec) });
      if (!result.ok) return result;
      return { ok: true, applied: result.data.applied, text: result.data.text, pending: result.data.pending };
    },
  }));

  register(defineTool({
    name: 'butler_pending_cancel',
    description: '取消一条待确认（用户改主意了、或者问了但已经不需要了）。',
    parameters: {
      id: { type: 'string', required: true, description: '待确认 id' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => text(value) },
    async execute(args) {
      const result = service.cancelPending(args);
      if (!result.ok) return result;
      return { ok: true, text: result.data.text, pending: result.data.pending };
    },
  }));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* 卸载阶段忽略 */
      }
    }
  };
}