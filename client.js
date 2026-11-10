/**
 * 桌面私人管家 · Client 半片（工作台形态）
 *
 * 视觉与交互目标：
 *  - 关键数字先看见：顶部四张汇总卡（本月订阅 / 最近到期 / 待办 / 净债）
 *  - 少填少跳：点一行就在原地展开编辑；新建默认只露必填项，其余收在「更多」
 *  - 找得到：搜索 + 筛选 + 排序，全部在工具条里
 *  - 宽窄都好看：CSS Grid auto-fit，宽屏多列、窄屏单列
 *  - 不用术语：设置页说人话（「每 30 秒查一次」而不是 pollSeconds），技术项收进「高级」
 *
 * 数据契约（与 Host 半片 src/routes.js 严格一致）：
 *  GET  /butler/api/state             -> { ok, ...state }
 *  POST /butler/api/mutate            -> { collection, op, id, record } -> { ok, result, state }
 *  POST /butler/api/settings          -> { patch } -> { ok, state }
 *  POST /butler/api/quota/refresh     -> { planId }
 *  POST /butler/api/plans/credential  -> { planId, credential }
 *  POST /butler/api/alerts/ack        -> { id } | { all: true }
 *
 * 单文件、零构建：React 从宿主浏览器模块表取，样式全部走主题变量。
 */
(function () {
  var MODULE_ID = '@local/butler';
  var API = '/butler/api';

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: function factory(require) {
      var React = require('react');
      var h = React.createElement;

      /* ------------------------------------------------------------------ *
       * 文案
       * ------------------------------------------------------------------ */

      var ZH = {
        'app.title': '管家',
        'app.subtitle': '截图丢进对话，我来记账、盯额度、按时提醒',
        'app.updated': '数据更新于',
        'app.refresh': '刷新',
        'app.retry': '重试',
        'app.loading': '正在读取数据…',
        'app.search': '搜索名称、对方、备注…',
        'app.searchEmpty': '没有匹配的记录',
        'app.clearSearch': '清空搜索',

        'tab.assets': '资产',
        'tab.todos': '待办',
        'tab.debts': '账本',
        'tab.items': '收纳',
        'tab.alerts': '提醒',

        'items.section': '家里的东西',
        'items.add': '收纳一件',
        'items.addTitle': '收纳一件东西',
        'items.name': '物品',
        'items.namePh': '如：充电器、备用钥匙',
        'items.location': '放在哪',
        'items.locationPh': '如：书房 / 阳台储物柜',
        'items.detail': '更细的位置',
        'items.detailPh': '如：第 2 层左边',
        'items.quantity': '数量',
        'items.unit': '单位',
        'items.unitPh': '个 / 把 / 盒',
        'items.placedAt': '什么时候放的',
        'items.placedAtPh': '昨天 / 3 天前 / 2026-11-10',
        'items.note': '备注',
        'items.notePh': '干嘛用的、和什么东西放一起',
        'items.tags': '关键词',
        'items.tagsPh': '逗号或空格分隔，方便以后搜',
        'items.empty': '还没有收纳记录',
        'items.emptyHint': '拍张照或说一句「某样东西放在哪」，以后直接问我东西在哪儿就行。',
        'items.viewPhoto': '查看大图',
        'items.addPhoto': '加照片',
        'items.removePhoto': '删掉这张',
        'items.uploading': '上传中…',
        'items.uploaded': '照片已存好',
        'items.readFail': '读取图片失败',
        'items.photoCount': '{n} 张照片',
        'items.placedAtShort': '{at} 放入',
        'items.noPlace': '未填位置',
        'items.lightHint': '点任意处关闭',

        'stat.monthly': '每月订阅支出',
        'stat.monthly.sub': '折合每年',
        'stat.nextExpiry': '最近到期',
        'stat.nextExpiry.sub': '没有即将到期的订阅',
        'stat.todos': '待处理',
        'stat.todos.sub': '其中已逾期',
        'stat.debt': '净债权',
        'stat.debt.sub': '别人欠我 / 我欠别人',
        'stat.monthly.none': '还没有订阅',
        'stat.todos.count': '{n} 条',
        'stat.todos.overdue': '{n} 条已逾期',
        'stat.todos.none': '没有逾期',
        'stat.debt.none': '还没有借贷记录',

        'assets.title': '订阅与额度',
        'assets.empty': '还没有资产',
        'assets.emptyHint': '把订阅页截图发进对话说「记一下」，或者在下面手动加一条。',
        'assets.add': '新增订阅',
        'assets.planAdd': '接入额度',
        'assets.plans': '额度计划',
        'assets.plansEmpty': '还没有盯额度的套餐',
        'assets.plansEmptyHint': '把 Token 套餐的用量截图发进对话，或说「帮我盯着这个套餐的余量」。',
        'assets.filter.all': '全部',
        'assets.filter.sub': '订阅',
        'assets.filter.plan': '额度',
        'assets.sort.expiry': '按到期时间',
        'assets.sort.amount': '按金额',
        'assets.sort.name': '按名称',

        'plans.status.ok': '正常',
        'plans.status.unknown': '未查询',
        'plans.status.error': '查询失败',
        'plans.status.no-credential': '缺凭证',
        'plans.refresh': '查询余量',
        'plans.refreshing': '查询中…',
        'plans.credential': '填凭证',
        'plans.credentialTitle': '额度查询凭证',
        'plans.credentialHint':
          '这是去该平台官网读你自己用量账户的凭证（API key / Cookie / OAuth token 都可能），和 DeepSeek Harness 的模型 key 是两回事，不要填模型 key。',
        'plans.credentialSave': '保存凭证',
        'plans.credentialSaved': '凭证已保存，正在查询…',
        'plans.lastChecked': '上次查询',
        'plans.never': '还没查过',
        'plans.manual': '手动填写余量',
        'plans.manualHint': '手动源的窗口值请直接改下面的数字。',
        'plans.window': '窗口',
        'plans.remaining': '剩余',
        'plans.reset': '刷新于',
        'plans.noWindows': '还没有窗口数据',
        'plans.needCredential': '填一次凭证，之后会自动帮你盯额度',
        'plans.credentialSet': '填入凭证',

        'settings.sources': '额度来源',
        'settings.sourcesHint': '内置几家之外，遇到没覆盖的平台可以让模型自己写查询代码，试跑通过再保存。',
        'sources.builtin': '内置',
        'sources.custom': '自己写的',
        'sources.needsCredential': '需要凭证',
        'sources.test': '试跑',
        'sources.testing': '试跑中…',
        'sources.testOk': '试跑通过：{n} 个窗口',
        'sources.code': '看代码',
        'sources.codeHide': '收起代码',
        'sources.credentialFirst': '这个源需要凭证：先给它建一个额度计划并填好凭证，再回来试跑。',
        'sources.hosts': '只访问',

        'todos.title': '待办',
        'todos.mine': '我要做',
        'todos.theirs': '等别人',
        'todos.empty': '没有待办',
        'todos.emptyHint': '截图里别人让你干的事，发进对话就自动记下来。',
        'todos.emptyHintTheirs': '你在等别人办的事，也记在这里并按时提醒。',
        'todos.add': '新增待办',
        'todos.done': '已完成',
        'todos.reopen': '标回未完成',
        'todos.overdue': '已逾期',
        'todos.filter.open': '未完成',
        'todos.filter.all': '全部',
        'todos.filter.done': '已完成',
        'todos.showDone': '显示已完成',

        'debts.title': '账本',
        'debts.owedToMe': '别人欠我',
        'debts.iOwe': '我欠别人',
        'debts.empty': '还没有记账',
        'debts.emptyHint': '借出或借入的聊天截图发进对话，说一句「记一下」。',
        'debts.add': '记一笔',
        'debts.settle': '结清',
        'debts.settled': '已结清',
        'debts.net': '净额',
        'debts.filter.open': '未结清',
        'debts.filter.all': '全部',

        'alerts.title': '待处理提醒',
        'alerts.empty': '没有待处理的提醒',
        'alerts.emptyHint': '到期、逾期、额度超阈值时会自动出现在这里。',
        'alerts.ack': '知道了',
        'alerts.ackAll': '全部确认',
        'alerts.level.critical': '紧急',
        'alerts.level.warn': '注意',
        'alerts.level.info': '提示',

        'form.new': '新增',
        'form.edit': '编辑',
        'form.save': '保存',
        'form.saving': '保存中…',
        'form.cancel': '取消',
        'form.more': '更多选项',
        'form.less': '收起',
        'form.required': '必填',
        'form.delete': '删除',
        'form.deleteConfirm': '再点一次删除',
        'form.dirty': '有未保存的修改',

        'field.name': '名称',
        'field.kind': '种类',
        'field.vendor': '提供方',
        'field.amount': '金额',
        'field.currency': '币种',
        'field.cycle': '计费周期',
        'field.expiresAt': '到期 / 下次扣费',
        'field.startedAt': '开始时间',
        'field.autoRenew': '自动续费',
        'field.notes': '备注',
        'field.tags': '标签',
        'field.title': '要做什么',
        'field.detail': '细节',
        'field.direction': '方向',
        'field.counterpart': '对方',
        'field.dueAt': '提醒时间',
        'field.priority': '优先级',
        'field.advanceMinutes': '提前提醒',
        'field.status': '状态',
        'field.counterpartName': '对方姓名',
        'field.planName': '套餐名称',
        'field.sourceId': '平台',
        'field.planLabel': '档位',
        'field.thresholds': '告警阈值',

        'cycle.monthly': '每月',
        'cycle.quarterly': '每季',
        'cycle.yearly': '每年',
        'cycle.weekly': '每周',
        'cycle.once': '一次性',
        'prio.low': '不急',
        'prio.normal': '一般',
        'prio.high': '重要',
        'dir.awaiting_me': '我要做',
        'dir.waiting_other': '等别人',
        'debt.owedToMe': '别人欠我',
        'debt.iOwe': '我欠别人',

        'time.today': '今天',
        'time.tomorrow': '明天',
        'time.yesterday': '昨天',
        'time.inDays': '还有 {n} 天',
        'time.inHours': '{n} 小时后',
        'time.inMinutes': '{n} 分钟后',
        'time.overdueDays': '已逾期 {n} 天',
        'time.overdueHours': '已逾期 {n} 小时',
        'time.none': '未设置',

        'advance.0': '到点提醒',
        'advance.10': '提前 10 分钟',
        'advance.30': '提前 30 分钟',
        'advance.60': '提前 1 小时',
        'advance.1440': '提前 1 天',
        'advance.2880': '提前 2 天',
        'advance.4320': '提前 3 天',
        'advance.10080': '提前 1 周',

        'settings.title': '管家设置',
        'settings.poll': '额度自动刷新',
        'settings.pollHint': '一次只查一个平台，不会同时打多个请求。',
        'settings.advance': '默认提前提醒',
        'settings.advanceHint': '单条记录可以单独改',
        'settings.currency': '默认币种',
        'settings.reminder': '提醒投递到',
        'settings.reminder.hint': '到期提醒会发到这里，你在会话里回一句就行',
        'settings.reminder.new_once': '专属提醒会话',
        'settings.reminder.new': '每次新建会话',
        'settings.reminder.session': '指定会话',
        'settings.advanced': '高级',
        'settings.snapshots': '每个套餐保留采样条数',
        'settings.dataFile': '数据文件',
        'settings.credentialBackend': '凭证存储',
        'settings.schedule': '提醒服务',
        'settings.schedule.ok': '可用',
        'settings.schedule.no': '未挂载（不会建提醒）',
        'settings.diagnostics': '诊断信息',
        'settings.saved': '设置已保存',
        'settings.pollOff': '关闭',
        'settings.every': '每 {n}',

        'toast.saved': '已保存',
        'toast.renewed': '已续期到原有订阅',
        'toast.deleted': '已删除',
        'toast.acked': '已确认',
        'toast.synced': '已同步提醒',
        'toast.failed': '操作失败',
        'error.load': '读取数据失败',
        'error.network': '连不上管家服务，确认插件还在启用状态。',
        'badge.autoRenew': '自动续费',
        'badge.manual': '手动',
        'badge.today': '今天',
        'badge.soon': '即将到期',
        'badge.expired': '已过期',
        'misc.count': '{n} 条',
        'misc.none': '—',
        'misc.listSep': '、',
        'misc.sep': ' · ',
        'misc.edit': '编辑',

        'app.stale': '已 {n} 分钟未更新',

        'time.soon': '马上',
        'time.justNow': '刚刚',
        'time.agoMinutes': '{n} 分钟前',
        'time.agoHours': '{n} 小时前',
        'time.seconds': '{n} 秒',
        'time.minutes': '{n} 分钟',
        'time.noExpiry': '未设置到期时间',

        'stat.monthly.other': '另有 {amount}/月',
        'stat.debt.other': '另有 {amount}',

        'plans.used': '已用 {v}',
        'toast.quotaRequested': '已发起查询',
        'todos.waitingOn': '等 {name}',
        'debt.in': '收',
        'debt.out': '付',
        'debt.status.open': '未结清',
        'debt.status.settled': '已结清',
        'field.amountHint': '必填，不确定就填 0',
        'form.requiredMissing': '请先填：{fields}',
        'settings.snapshotsHint': '保存后按这个条数裁剪旧采样，改小会丢弃更早的历史',
        'settings.snapshotsInvalid': '请输入 0 或更大的整数',
        'settings.snapshotsSaved': '保留条数已更新',
        'settings.apiToken': '接口令牌（可选）',
        'settings.apiTokenHint': '只在你自己配了 apiToken 时才需要填，保存在本机浏览器',
        'settings.apiTokenSave': '保存令牌',
        'settings.apiTokenSaved': '令牌已保存，刷新页面后生效',
        'ph.assetName': 'Claude Pro / 腾讯视频会员',
        'ph.expiresAt': '2026-12-10 或 明天 9:00',
        'ph.planName': 'Claude Pro 额度',
        'ph.todoTitle': '周五之前把合同发给张三',
        'ph.counterpart': '张三',
        'ph.debtCounterpart': '李雷',
        'ph.todoDueAt': '明天 9:00',
        'ph.debtDueAt': '下个月 1 号'
      };

      var EN = {
        'app.title': 'Butler',
        'app.subtitle': 'Drop a screenshot in chat — I record, monitor and remind.',
        'app.updated': 'Updated',
        'app.refresh': 'Refresh',
        'app.retry': 'Retry',
        'app.loading': 'Loading…',
        'app.search': 'Search name, person, note…',
        'app.searchEmpty': 'No matching records',
        'app.clearSearch': 'Clear search',
        'tab.assets': 'Assets',
        'tab.todos': 'To-dos',
        'tab.debts': 'Ledger',
        'tab.items': 'Storage',
        'tab.alerts': 'Alerts',
        'items.section': 'Household items',
        'items.add': 'Add item',
        'items.addTitle': 'Store an item',
        'items.name': 'Item',
        'items.namePh': 'e.g. charger, spare keys',
        'items.location': 'Where',
        'items.locationPh': 'e.g. Study / balcony cabinet',
        'items.detail': 'More detail',
        'items.detailPh': 'e.g. 2nd shelf, left side',
        'items.quantity': 'Quantity',
        'items.unit': 'Unit',
        'items.unitPh': 'pcs / boxes',
        'items.placedAt': 'When stored',
        'items.placedAtPh': 'yesterday / 3 days ago / 2026-11-10',
        'items.note': 'Notes',
        'items.notePh': "What it's for, what it's stored with",
        'items.tags': 'Tags',
        'items.tagsPh': 'Comma or space separated',
        'items.empty': 'Nothing stored yet',
        'items.emptyHint': 'Send a photo or say where something goes — later just ask me where it is.',
        'items.viewPhoto': 'View photo',
        'items.addPhoto': 'Add photo',
        'items.removePhoto': 'Remove photo',
        'items.uploading': 'Uploading…',
        'items.uploaded': 'Photo saved',
        'items.readFail': 'Could not read the image',
        'items.photoCount': '{n} photo(s)',
        'items.placedAtShort': 'put away {at}',
        'items.noPlace': 'No location',
        'items.lightHint': 'Click anywhere to close',
        'stat.monthly': 'Monthly spend',
        'stat.monthly.sub': 'Per year',
        'stat.nextExpiry': 'Next renewal',
        'stat.nextExpiry.sub': 'Nothing due soon',
        'stat.todos': 'Open to-dos',
        'stat.todos.sub': 'overdue',
        'stat.debt': 'Net balance',
        'stat.debt.sub': 'owed to me / I owe',
        'stat.monthly.none': 'No subscriptions yet',
        'stat.todos.count': '{n}',
        'stat.todos.overdue': '{n} overdue',
        'stat.todos.none': 'none overdue',
        'stat.debt.none': 'No loans yet',
        'assets.title': 'Subscriptions & quotas',
        'assets.empty': 'No assets yet',
        'assets.emptyHint': 'Send a subscription screenshot in chat, or add one manually.',
        'assets.add': 'New subscription',
        'assets.planAdd': 'Track quota',
        'assets.plans': 'Quota plans',
        'assets.plansEmpty': 'No quota plans',
        'assets.plansEmptyHint': 'Send a token-plan usage screenshot, or ask me to watch the quota.',
        'assets.filter.all': 'All',
        'assets.filter.sub': 'Subscriptions',
        'assets.filter.plan': 'Quotas',
        'assets.sort.expiry': 'By expiry',
        'assets.sort.amount': 'By amount',
        'assets.sort.name': 'By name',
        'plans.status.ok': 'OK',
        'plans.status.unknown': 'Not checked',
        'plans.status.error': 'Failed',
        'plans.status.no-credential': 'No credential',
        'plans.refresh': 'Check quota',
        'plans.refreshing': 'Checking…',
        'plans.credential': 'Credential',
        'plans.credentialTitle': 'Quota credential',
        'plans.credentialHint':
          'Credential for that vendor usage page (API key / cookie / OAuth token). It is NOT your model key.',
        'plans.credentialSave': 'Save credential',
        'plans.lastChecked': 'Last checked',
        'plans.never': 'never',
        'plans.noWindows': 'No quota windows yet',
        'plans.needCredential': 'Add a credential once and quota checks run themselves',
        'plans.credentialSet': 'Add credential',
        'settings.sources': 'Quota sources',
        'settings.sourcesHint':
          'For platforms not covered by the built-in ones, the model can write its own query script — test it first, then save.',
        'sources.builtin': 'Built-in',
        'sources.custom': 'Custom',
        'sources.needsCredential': 'Needs credential',
        'sources.test': 'Test',
        'sources.testing': 'Testing…',
        'sources.testOk': 'Test passed: {n} window(s)',
        'sources.code': 'View code',
        'sources.codeHide': 'Hide code',
        'sources.credentialFirst':
          'This source needs a credential: create a quota plan for it, fill the credential, then test again.',
        'sources.hosts': 'Only reaches',
        'todos.title': 'To-dos',
        'todos.mine': 'Mine',
        'todos.theirs': 'Waiting on',
        'todos.empty': 'No to-dos',
        'todos.emptyHint': 'Screenshot something you must do and drop it in chat.',
        'todos.emptyHintTheirs': 'Things you are waiting on others to do also live here.',
        'todos.add': 'New to-do',
        'todos.done': 'Done',
        'todos.reopen': 'Reopen',
        'todos.overdue': 'Overdue',
        'debts.title': 'Ledger',
        'debts.owedToMe': 'Owed to me',
        'debts.iOwe': 'I owe',
        'debts.empty': 'Empty ledger',
        'debts.emptyHint': 'Drop a chat screenshot about lending or borrowing.',
        'debts.add': 'Add entry',
        'debts.settle': 'Settle',
        'debts.settled': 'Settled',
        'debts.net': 'Net',
        'alerts.title': 'Open alerts',
        'alerts.empty': 'Nothing to handle',
        'alerts.emptyHint': 'Expiry, overdue and quota thresholds show up here.',
        'alerts.ack': 'Got it',
        'alerts.ackAll': 'Acknowledge all',
        'alerts.level.critical': 'Critical',
        'alerts.level.warn': 'Warning',
        'alerts.level.info': 'Info',
        'form.new': 'New',
        'form.edit': 'Edit',
        'form.save': 'Save',
        'form.saving': 'Saving…',
        'form.cancel': 'Cancel',
        'form.more': 'More options',
        'form.less': 'Less',
        'form.delete': 'Delete',
        'form.deleteConfirm': 'Click again to delete',
        'field.name': 'Name',
        'field.amount': 'Amount',
        'field.currency': 'Currency',
        'field.cycle': 'Cycle',
        'field.expiresAt': 'Expires / renews',
        'field.notes': 'Notes',
        'field.title': 'What to do',
        'field.direction': 'Direction',
        'field.counterpart': 'Person',
        'field.dueAt': 'Remind at',
        'field.priority': 'Priority',
        'field.detail': 'Details',
        'field.sourceId': 'Platform',
        'field.planLabel': 'Tier',
        'time.inDays': 'in {n}d',
        'time.inHours': 'in {n}h',
        'time.inMinutes': 'in {n}m',
        'time.overdueDays': '{n}d overdue',
        'time.overdueHours': '{n}h overdue',
        'time.none': 'not set',
        'settings.title': 'Butler settings',
        'settings.saved': 'Settings saved',
        'toast.saved': 'Saved',
        'toast.renewed': 'Renewed the existing subscription',
        'toast.deleted': 'Deleted',
        'toast.acked': 'Acknowledged',
        'toast.failed': 'Failed',
        'error.load': 'Could not load data',
        'misc.count': '{n}',
        'misc.none': '—',

        'plans.credentialSaved': 'Credential saved, checking…',
        'plans.manual': 'Fill in remaining quota',
        'plans.manualHint': 'For a manual source, edit the numbers below.',
        'plans.window': 'Window',
        'plans.remaining': 'Left',
        'plans.reset': 'Resets',
        'todos.filter.open': 'Open',
        'todos.filter.all': 'All',
        'todos.filter.done': 'Done',
        'todos.showDone': 'Show completed',
        'debts.filter.open': 'Outstanding',
        'debts.filter.all': 'All',
        'form.required': 'required',
        'form.dirty': 'Unsaved changes',
        'field.kind': 'Kind',
        'field.vendor': 'Vendor',
        'field.startedAt': 'Started',
        'field.autoRenew': 'Auto-renew',
        'field.tags': 'Tags',
        'field.advanceMinutes': 'Remind me',
        'field.status': 'Status',
        'field.counterpartName': 'Person',
        'field.planName': 'Plan name',
        'field.thresholds': 'Alert thresholds',
        'cycle.monthly': 'monthly',
        'cycle.quarterly': 'quarterly',
        'cycle.yearly': 'yearly',
        'cycle.weekly': 'weekly',
        'cycle.once': 'one-off',
        'prio.low': 'Low',
        'prio.normal': 'Normal',
        'prio.high': 'Important',
        'dir.awaiting_me': 'Mine',
        'dir.waiting_other': 'Waiting on',
        'debt.owedToMe': 'Owed to me',
        'debt.iOwe': 'I owe',
        'time.today': 'today',
        'time.tomorrow': 'tomorrow',
        'time.yesterday': 'yesterday',
        'advance.0': 'At the deadline',
        'advance.10': '10 min before',
        'advance.30': '30 min before',
        'advance.60': '1 hour before',
        'advance.1440': '1 day before',
        'advance.2880': '2 days before',
        'advance.4320': '3 days before',
        'advance.10080': '1 week before',
        'settings.poll': 'Auto-refresh quotas',
        'settings.pollHint': 'One platform at a time — never concurrent requests.',
        'settings.advance': 'Default reminder lead time',
        'settings.advanceHint': 'Each record can override it',
        'settings.currency': 'Default currency',
        'settings.reminder': 'Reminders go to',
        'settings.reminder.hint': 'Due reminders land here; just reply in the session',
        'settings.reminder.new_once': 'A dedicated reminder session',
        'settings.reminder.new': 'A new session each time',
        'settings.reminder.session': 'A specific session',
        'settings.advanced': 'Advanced',
        'settings.snapshots': 'Samples kept per plan',
        'settings.dataFile': 'Data file',
        'settings.credentialBackend': 'Credential store',
        'settings.schedule': 'Reminder service',
        'settings.schedule.ok': 'available',
        'settings.schedule.no': 'not mounted (no reminders)',
        'settings.diagnostics': 'Diagnostics',
        'settings.pollOff': 'Off',
        'settings.every': 'Every {n}',
        'toast.synced': 'Reminders synced',
        'error.network': 'Cannot reach the butler service — check that the plugin is still enabled.',
        'badge.autoRenew': 'auto-renew',
        'badge.manual': 'manual',
        'badge.today': 'today',
        'badge.soon': 'expiring soon',
        'badge.expired': 'expired',
        'misc.listSep': ', ',
        'misc.sep': ' · ',
        'misc.edit': 'Edit',
        'app.stale': 'not updated for {n} min',
        'time.soon': 'soon',
        'time.justNow': 'just now',
        'time.agoMinutes': '{n}m ago',
        'time.agoHours': '{n}h ago',
        'time.seconds': '{n}s',
        'time.minutes': '{n} min',
        'time.noExpiry': 'no expiry date',
        'stat.monthly.other': 'plus {amount}/mo',
        'stat.debt.other': 'plus {amount}',
        'plans.used': '{v} used',
        'toast.quotaRequested': 'Quota check requested',
        'todos.waitingOn': 'waiting on {name}',
        'debt.in': 'IN',
        'debt.out': 'OUT',
        'debt.status.open': 'Open',
        'debt.status.settled': 'Settled',
        'field.amountHint': 'required — use 0 if unsure',
        'form.requiredMissing': 'Fill in: {fields}',
        'settings.snapshotsHint': 'Older samples are trimmed to this count — lowering it drops earlier history',
        'settings.snapshotsInvalid': 'Enter a whole number, 0 or larger',
        'settings.snapshotsSaved': 'Sample count updated',
        'settings.apiToken': 'API token (optional)',
        'settings.apiTokenHint': 'Only needed if you set apiToken yourself; stored in this browser',
        'settings.apiTokenSave': 'Save token',
        'settings.apiTokenSaved': 'Token saved — refresh the page to apply',
        'ph.assetName': 'Claude Pro / Netflix',
        'ph.expiresAt': '2026-12-10 or tomorrow 9:00',
        'ph.planName': 'Claude Pro quota',
        'ph.todoTitle': 'Send the contract to Alex before Friday',
        'ph.counterpart': 'Alex',
        'ph.debtCounterpart': 'Alex',
        'ph.todoDueAt': 'tomorrow 9:00',
        'ph.debtDueAt': 'the 1st of next month'
      };

      var dict = ZH;
      var dictLocale = 'zh';
      var listeners = [];

      function resolveLocale(ctx) {
        var raw = '';
        try {
          var svc = ctx.get('locale');
          if (svc && typeof svc.getLocale === 'function') {
            var snap = svc.getLocale();
            raw = snap && (snap.id || snap.locale || snap.language) || '';
          }
        } catch (error) {
          raw = '';
        }
        if (!raw && typeof navigator !== 'undefined' && navigator.language) raw = navigator.language;
        return String(raw || 'zh').toLowerCase().indexOf('en') === 0 ? 'en' : 'zh';
      }

      function applyLocale(next) {
        if (next === dictLocale) return false;
        dictLocale = next;
        dict = next === 'en' ? EN : ZH;
        return true;
      }

      function t(key, vars) {
        var text = dict[key];
        if (text === undefined) text = ZH[key];
        if (text === undefined) return key;
        if (!vars) return text;
        return String(text).replace(/\{(\w+)\}/g, function (match, name) {
          return vars[name] === undefined ? match : String(vars[name]);
        });
      }

      function useT() {
        var pair = React.useState(0);
        var bump = pair[1];
        React.useEffect(function () {
          var listener = function () {
            bump(function (n) {
              return n + 1;
            });
          };
          listeners.push(listener);
          return function () {
            var index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          };
        }, []);
        return t;
      }

      /* ------------------------------------------------------------------ *
       * 格式化
       * ------------------------------------------------------------------ */

      var CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$' };

      function toDate(value) {
        if (!value) return null;
        var date = value instanceof Date ? value : new Date(value);
        return Number.isFinite(date.getTime()) ? date : null;
      }

      function pad(n) {
        return n < 10 ? '0' + n : String(n);
      }

      function startOfDay(date) {
        var d = new Date(date.getTime());
        d.setHours(0, 0, 0, 0);
        return d;
      }

      function dayDiff(iso) {
        var date = toDate(iso);
        if (!date) return null;
        var days = Math.round((startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / 86400000);
        return days;
      }

      function fmtMoney(amount, currency) {
        var code = String(currency || 'CNY').toUpperCase();
        var value = Number(amount);
        if (!Number.isFinite(value)) return '—';
        var symbol = CURRENCY_SYMBOL[code] || '';
        var digits = Math.abs(value) >= 1000 ? 0 : Math.abs(value) % 1 === 0 ? 0 : 2;
        var text = value.toLocaleString(undefined, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits
        });
        return symbol + text;
      }

      /** 带正负号的金额：符号永远在货币符号前（-¥30，不是 ¥-30） */
      function fmtSignedMoney(amount, currency) {
        var value = Number(amount);
        if (!Number.isFinite(value)) return '—';
        var text = fmtMoney(Math.abs(value), currency);
        if (value > 0) return '+' + text;
        if (value < 0) return '-' + text;
        return text;
      }

      /** 主卡副标题：主币种文案后面追加其它币种，跨币种数据不许被静默丢掉 */
      function joinExtras(base, others, labelOf) {
        if (!others || !others.length) return base;
        return base + ' · ' + others.map(labelOf).join(' · ');
      }

      function fmtDate(iso, withTime) {
        var date = toDate(iso);
        if (!date) return '—';
        var base = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
        if (!withTime) return base;
        return base + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
      }

      function fmtClock(iso) {
        var date = toDate(iso);
        if (!date) return '—';
        return pad(date.getHours()) + ':' + pad(date.getMinutes());
      }

      function fmtRelative(iso) {
        var date = toDate(iso);
        if (!date) return t('time.none');
        var diff = date.getTime() - Date.now();
        var abs = Math.abs(diff);
        var minutes = Math.round(abs / 60000);
        var hours = Math.round(abs / 3600000);
        var days = dayDiff(iso);
        var future = diff >= 0;
        if (abs < 60000) return future ? t('time.soon') : t('time.justNow');
        if (days !== null && Math.abs(days) >= 1) {
          return future
            ? t('time.inDays', { n: days })
            : t('time.overdueDays', { n: Math.abs(days) });
        }
        if (hours >= 1) {
          return future ? t('time.inHours', { n: hours }) : t('time.overdueHours', { n: hours });
        }
        /* 过去方向用独立的「N 分钟前」，不能用负数的「-20 分钟后」 */
        return future ? t('time.inMinutes', { n: minutes }) : t('time.agoMinutes', { n: minutes });
      }

      function fmtAgo(iso) {
        var date = toDate(iso);
        if (!date) return t('plans.never');
        var diff = Date.now() - date.getTime();
        if (diff < 60000) return t('time.justNow');
        var minutes = Math.round(diff / 60000);
        if (minutes < 60) return t('time.agoMinutes', { n: minutes });
        var hours = Math.round(minutes / 60);
        if (hours < 24) return t('time.agoHours', { n: hours });
        return fmtDate(iso, true);
      }

      function expiryTone(days) {
        if (days === null) return '';
        if (days <= 0) return 'danger';
        if (days <= 1) return 'danger';
        if (days <= 7) return 'warn';
        return '';
      }

      function toneOfLevel(level) {
        if (level === 'critical') return 'danger';
        if (level === 'warn') return 'warn';
        if (level === 'ok') return 'ok';
        return '';
      }

      function percentLabel(value) {
        var n = Number(value);
        if (!Number.isFinite(n)) return '—';
        return Math.round(n * 100) + '%';
      }

      function fmtNumber(value) {
        var n = Number(value);
        if (!Number.isFinite(n)) return '—';
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
      }

      /** 额度窗口「还剩多少」的可读文案；percent 单位不该显示成 38/100 */
      function windowRemainingLabel(window) {
        if (!window) return '';
        var remain = window.remaining;
        if (remain === undefined || remain === null) {
          if (window.limit !== undefined && window.limit !== null && window.used !== undefined && window.used !== null) {
            remain = Number(window.limit) - Number(window.used);
          }
        }
        if (remain === undefined || remain === null || !Number.isFinite(Number(remain))) return '';
        var unit = String(window.unit || '');
        if (unit === 'percent') return Math.max(0, Math.round(Number(remain))) + '%';
        if (unit === 'usd') return '$' + fmtNumber(remain);
        if (unit === 'cny') return '¥' + fmtNumber(remain);
        return fmtNumber(remain);
      }

      /** 只有余额、没有总额度的窗口（DeepSeek 余额等）：显示「还剩多少」，不显示百分比 */
      function isBalanceWindow(window) {
        if (!window) return false;
        if (window.kind === 'balance') return true;
        return window.limit === null || window.limit === undefined || window.percent === null || window.percent === undefined;
      }

      function balanceLabel(window) {
        var value = window.remaining;
        if (value === undefined || value === null) value = window.used;
        if (value === undefined || value === null || !Number.isFinite(Number(value))) return '—';
        var unit = String(window.unit || '');
        if (unit === 'usd') return '$' + fmtNumber(value);
        if (unit === 'cny') return '¥' + fmtNumber(value);
        if (unit === 'percent') return Math.max(0, Math.round(Number(value))) + '%';
        return fmtNumber(value);
      }

      /* ------------------------------------------------------------------ *
       * 请求层
       * ------------------------------------------------------------------ */

      function toQuery(path) {
        return API + path;
      }

      var TOKEN_KEY = 'butler.apiToken';

      /** 可选接口令牌：只在用户自己配了 config.apiToken 时才有意义，存本机浏览器 */
      function readToken() {
        try {
          if (typeof window === 'undefined' || !window.localStorage) return '';
          return String(window.localStorage.getItem(TOKEN_KEY) || '');
        } catch (error) {
          return '';
        }
      }

      function writeToken(value) {
        try {
          if (typeof window === 'undefined' || !window.localStorage) return false;
          var text = String(value === undefined || value === null ? '' : value).trim();
          if (text) window.localStorage.setItem(TOKEN_KEY, text);
          else window.localStorage.removeItem(TOKEN_KEY);
          return true;
        } catch (error) {
          return false;
        }
      }

      async function request(path, options) {
        var opts = Object.assign({}, options || {});
        var headers = Object.assign({}, opts.headers || {});
        var token = readToken();
        if (token) headers['x-butler-token'] = token;
        opts.headers = headers;
        var response;
        try {
          response = await fetch(toQuery(path), opts);
        } catch (error) {
          throw new Error(t('error.network'));
        }
        var payload = null;
        try {
          payload = await response.json();
        } catch (error) {
          payload = null;
        }
        if (!payload || payload.ok !== true) {
          var message = (payload && payload.error) || 'HTTP ' + response.status;
          throw new Error(message);
        }
        return payload;
      }

      function getState() {
        return request('/state', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      }

      function post(path, body) {
        return request(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body || {})
        });
      }

      /* ------------------------------------------------------------------ *
       * 数据 hook
       * ------------------------------------------------------------------ */

      var POLL_MS = 5000;

      function useButler(tr) {
        var dataState = React.useState(null);
        var data = dataState[0];
        var setData = dataState[1];
        var errorState = React.useState('');
        var error = errorState[0];
        var setError = errorState[1];
        var loadingState = React.useState(true);
        var loading = loadingState[0];
        var setLoading = loadingState[1];
        var busyState = React.useState({});
        var busyMap = busyState[0];
        var setBusyMap = busyState[1];
        var failState = React.useState(0);
        var failCount = failState[0];
        var setFailCount = failState[1];
        var lastErrState = React.useState('');
        var lastError = lastErrState[0];
        var setLastError = lastErrState[1];
        var okAtState = React.useState(0);
        var lastOkAt = okAtState[0];
        var setLastOkAt = okAtState[1];
        var flashState = React.useState(null);
        var flash = flashState[0];
        var setFlash = flashState[1];
        var aliveRef = React.useRef(true);
        var timerRef = React.useRef(null);
        /* 请求序号：先发出却后返回的响应，不许覆盖已经应用的新数据 */
        var seqRef = React.useRef(0);
        var appliedRef = React.useRef(0);

        var notify = React.useCallback(function (message, tone) {
          setFlash({ id: Date.now() + Math.random(), message: message, tone: tone || 'ok' });
        }, []);

        React.useEffect(function () {
          if (!flash) return undefined;
          var id = setTimeout(function () {
            setFlash(null);
          }, 2600);
          return function () {
            clearTimeout(id);
          };
        }, [flash]);

        var bumpBusy = React.useCallback(function (key, delta) {
          setBusyMap(function (prev) {
            var next = Object.assign({}, prev);
            var count = (next[key] || 0) + delta;
            if (count > 0) next[key] = count;
            else delete next[key];
            return next;
          });
        }, []);

        var isBusy = React.useCallback(
          function (key) {
            return Boolean(busyMap[key]);
          },
          [busyMap]
        );

        var load = React.useCallback(
          function (silent) {
            if (!silent) setLoading(true);
            var seq = ++seqRef.current;
            return getState()
              .then(function (payload) {
                if (!aliveRef.current) return;
                setFailCount(0);
                setLastError('');
                setLastOkAt(Date.now());
                setError('');
                if (seq < appliedRef.current) return;
                appliedRef.current = seq;
                var next = Object.assign({}, payload);
                delete next.ok;
                setData(next);
              })
              .catch(function (cause) {
                if (!aliveRef.current) return;
                var message = String(cause.message || cause);
                setFailCount(function (n) {
                  return n + 1;
                });
                setLastError(message);
                if (!silent) {
                  setError(message);
                  notify(tr('toast.failed') + '：' + message, 'error');
                }
              })
              .then(function () {
                if (aliveRef.current) setLoading(false);
              });
          },
          [notify, tr]
        );

        React.useEffect(function () {
          aliveRef.current = true;
          load(false);
          timerRef.current = setInterval(function () {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            load(true);
          }, POLL_MS);
          var onVisible = function () {
            if (document.visibilityState === 'visible') load(true);
          };
          document.addEventListener('visibilitychange', onVisible);
          return function () {
            aliveRef.current = false;
            clearInterval(timerRef.current);
            document.removeEventListener('visibilitychange', onVisible);
          };
        }, [load]);

        /* 写操作：失败一律 toast 并 reject（调用方要能区分成败），由 mutate 再兜成 {ok} */
        var send = React.useCallback(
          function (path, body, options) {
            var opts = options || {};
            var key = opts.key || path;
            var seq = ++seqRef.current;
            bumpBusy(key, 1);
            return post(path, body)
              .then(function (payload) {
                if (payload.state && seq >= appliedRef.current) {
                  appliedRef.current = seq;
                  var next = Object.assign({}, payload.state);
                  delete next.ok;
                  setData(next);
                }
                if (opts.success) notify(opts.success, 'ok');
                return payload.result || payload;
              })
              .catch(function (cause) {
                notify(tr('toast.failed') + '：' + String(cause.message || cause), 'error');
                throw cause;
              })
              .then(
                function (value) {
                  bumpBusy(key, -1);
                  return value;
                },
                function (cause) {
                  bumpBusy(key, -1);
                  throw cause;
                }
              );
          },
          [bumpBusy, notify, tr]
        );

        /* mutate 永不 reject：fire-and-forget 的调用点也留不下 unhandled rejection */
        var mutate = React.useCallback(
          function (collection, op, record, id) {
            return send(
              '/mutate',
              { collection: collection, op: op, id: id, record: record },
              { key: 'mutate:' + collection, success: op === 'delete' ? tr('toast.deleted') : tr('toast.saved') }
            ).then(
              function (result) {
                return { ok: true, result: result };
              },
              function (cause) {
                return { ok: false, error: cause };
              }
            );
          },
          [send, tr]
        );

        return {
          data: data,
          error: error,
          loading: loading,
          busyMap: busyMap,
          isBusy: isBusy,
          failCount: failCount,
          lastError: lastError,
          lastOkAt: lastOkAt,
          flash: flash,
          reload: load,
          notify: notify,
          send: send,
          mutate: mutate
        };
      }

      /* ------------------------------------------------------------------ *
       * 图标（16px 线性，currentColor）
       * ------------------------------------------------------------------ */

      var PATHS = {
        refresh: 'M13.5 3.5a6 6 0 1 0 1.4 6.2M13.5 3.5V7h-3.5',
        plus: 'M8 3v10M3 8h10',
        search: 'M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4zM11 11l2.6 2.6',
        edit: 'M11.3 2.7l2 2L6 12H4v-2l7.3-7.3z',
        trash: 'M3.5 4.5h9M6 4.5V3h4v1.5M4.8 4.5l.5 8h5.4l.5-8',
        close: 'M4 4l8 8M12 4l-8 8',
        check: 'M3.5 8.5l3 3 6-7',
        chevron: 'M6 4l4 4-4 4',
        wallet: 'M2.5 5.5h11v7h-11zM2.5 5.5l1.2-2h9l1.2 2M10.5 9h2.5',
        card: 'M2 5.5h12v6H2zM2 8h12',
        clock: 'M8 4.5V8l2.5 1.6M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z',
        bell: 'M8 13.2a4.8 4.8 0 0 0 4.5-3h-9A4.8 4.8 0 0 0 8 13.2zM6.4 3.6a1.6 1.6 0 1 1 3.2 0c1.7.5 2.9 2 2.9 3.9v2.7h-9V7.5c0-1.9 1.2-3.4 2.9-3.9z',
        alert: 'M8 2.5l6 10.5H2l6-10.5zM8 6.5v3M8 11.2v.6',
        list: 'M3 4.5h10M3 8h10M3 11.5h6',
        bolt: 'M9 2L4 9h3.2L7 14l5-7H8.8L9 2z',
        box: 'M2.6 5.4l5.4-2.4 5.4 2.4v5.2L8 13l-5.4-2.4zM2.6 5.4L8 8l5.4-2.6M8 8v5',
        user: 'M8 8a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 8zM3.2 13.4c.5-2.4 2.4-3.9 4.8-3.9s4.3 1.5 4.8 3.9',
        coin: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.8v6.4M6.2 6.4h3a1.4 1.4 0 0 1 0 2.8h-3',
        gear: 'M8 10.2A2.2 2.2 0 1 0 8 5.8a2.2 2.2 0 0 0 0 4.4zM8 1.8v1.6M8 12.6v1.6M2.9 4.6l1.3.8M11.8 10.6l1.3.8M2 8h1.6M12.4 8H14M2.9 11.4l1.3-.8M11.8 5.4l1.3-.8',
        copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
        dot: 'M8 9.6A1.6 1.6 0 1 0 8 6.4a1.6 1.6 0 0 0 0 3.2z'
      };

      function Ico(props) {
        var size = props.size || 16;
        var name = props.name;
        var d = PATHS[name] || PATHS.dot;
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: props.strokeWidth || 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            className: 'btl-ico' + (props.className ? ' ' + props.className : '')
          },
          h('path', { d: d })
        );
      }

      /* ------------------------------------------------------------------ *
       * 基础控件
       * ------------------------------------------------------------------ */

      function Btn(props) {
        var tone = props.tone || 'ghost';
        var className = ['btl-btn', 'btl-btn-' + tone];
        if (props.size === 'sm') className.push('btl-btn-sm');
        if (props.block) className.push('btl-btn-block');
        if (props.className) className.push(props.className);
        var content = [];
        if (props.icon) content.push(h(Ico, { name: props.icon, size: props.size === 'sm' ? 13 : 15 }));
        if (props.children) content.push(h('span', { key: 'label', className: 'btl-btn-label' }, props.children));
        return h(
          'button',
          {
            type: 'button',
            className: className.join(' '),
            onClick: props.disabled ? undefined : props.onClick,
            disabled: Boolean(props.disabled),
            title: props.title,
            'aria-label': props.ariaLabel || props.title
          },
          content
        );
      }

      function IconBtn(props) {
        return h(
          'button',
          {
            type: 'button',
            className: 'btl-iconbtn' + (props.tone ? ' btl-iconbtn-' + props.tone : ''),
            onClick: props.disabled ? undefined : props.onClick,
            disabled: Boolean(props.disabled),
            title: props.title,
            'aria-label': props.ariaLabel || props.title
          },
          h(Ico, { name: props.icon, size: 15 })
        );
      }

      function Chip(props) {
        var className = ['btl-chip'];
        if (props.tone) className.push('btl-chip-' + props.tone);
        if (props.mono) className.push('btl-chip-mono');
        return h('span', { className: className.join(' ') }, props.children);
      }

      function Field(props) {
        var className = ['btl-field'];
        if (props.wide) className.push('btl-field-wide');
        return h(
          'label',
          { className: className.join(' ') },
          h(
            'span',
            { className: 'btl-field-label' },
            props.label,
            props.required ? h('em', { className: 'btl-req' }, '*') : null,
            props.hint ? h('span', { className: 'btl-field-hint' }, props.hint) : null
          ),
          props.children
        );
      }

      function TextInput(props) {
        return h('input', {
          type: props.type || 'text',
          className: 'btl-input' + (props.invalid ? ' btl-input-invalid' : ''),
          value: props.value === undefined || props.value === null ? '' : props.value,
          placeholder: props.placeholder,
          inputMode: props.inputMode,
          min: props.min,
          max: props.max,
          step: props.step,
          onChange: function (event) {
            props.onChange(event.target.value);
          },
          onBlur: props.onBlur,
          onKeyDown: props.onKeyDown,
          'aria-invalid': props.invalid ? 'true' : undefined,
          spellCheck: props.spellCheck === undefined ? false : props.spellCheck,
          autoFocus: props.autoFocus
        });
      }

      function TextArea(props) {
        return h('textarea', {
          className: 'btl-input btl-textarea' + (props.invalid ? ' btl-input-invalid' : ''),
          rows: props.rows || 2,
          value: props.value === undefined || props.value === null ? '' : props.value,
          placeholder: props.placeholder,
          onChange: function (event) {
            props.onChange(event.target.value);
          }
        });
      }

      function Select(props) {
        return h(
          'select',
          {
            className:
              'btl-input btl-select' +
              (props.invalid ? ' btl-input-invalid' : '') +
              (props.className ? ' ' + props.className : ''),
            value: props.value === undefined || props.value === null ? '' : props.value,
            onChange: function (event) {
              props.onChange(event.target.value);
            }
          },
          (props.options || []).map(function (option) {
            return h('option', { key: String(option.value), value: option.value }, option.label);
          })
        );
      }

      function Switch(props) {
        return h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': props.checked ? 'true' : 'false',
            className: 'btl-switch' + (props.checked ? ' btl-switch-on' : ''),
            onClick: function () {
              props.onChange(!props.checked);
            }
          },
          h('span', { className: 'btl-switch-knob' })
        );
      }

      function Segmented(props) {
        return h(
          'div',
          { className: 'btl-seg', role: 'tablist' },
          props.items.map(function (item) {
            var active = item.value === props.value;
            return h(
              'button',
              {
                key: String(item.value),
                type: 'button',
                role: 'tab',
                'aria-selected': active ? 'true' : 'false',
                className: 'btl-seg-item' + (active ? ' btl-seg-active' : ''),
                onClick: function () {
                  props.onChange(item.value);
                }
              },
              item.label,
              item.count ? h('span', { className: 'btl-seg-count' }, String(item.count)) : null
            );
          })
        );
      }

      function Empty(props) {
        return h(
          'div',
          { className: 'btl-empty' },
          h('div', { className: 'btl-empty-icon' }, h(Ico, { name: props.icon || 'list', size: 20 })),
          h('div', { className: 'btl-empty-title' }, props.title),
          props.hint ? h('div', { className: 'btl-empty-hint' }, props.hint) : null,
          props.action || null
        );
      }

      function Bar(props) {
        var percent = Math.max(0, Math.min(1, Number(props.percent) || 0));
        var tone = props.tone || '';
        return h(
          'div',
          {
            className: 'btl-bar' + (tone ? ' btl-bar-' + tone : ''),
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.round(percent * 100),
            'aria-label': props.label
          },
          h('span', { className: 'btl-bar-fill', style: { width: Math.max(2, percent * 100) + '%' } })
        );
      }

      function Skeleton() {
        return h(
          'div',
          { className: 'btl-skeleton-wrap' },
          h('div', { className: 'btl-skeleton btl-skeleton-row' }),
          h('div', { className: 'btl-skeleton btl-skeleton-row' }),
          h('div', { className: 'btl-skeleton btl-skeleton-row' })
        );
      }

      function Toast(props) {
        if (!props.flash) return null;
        var isError = props.flash.tone === 'error';
        return h(
          'div',
          {
            className: 'btl-toast btl-toast-' + props.flash.tone,
            key: props.flash.id,
            role: isError ? 'alert' : 'status',
            'aria-live': isError ? 'assertive' : 'polite',
            'aria-atomic': 'true'
          },
          props.flash.message
        );
      }

/* ------------------------------------------------------------------ *
       * 表单（就地编辑 / 快速新增共用一个渲染器）
       * ------------------------------------------------------------------ */

      /** Enter / Space 都算激活（Space 默认滚页面，要 preventDefault） */
      function activateOnKey(handler) {
        return function (event) {
          if (!event) return;
          var key = event.key;
          if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
          event.preventDefault();
          handler(event);
        };
      }

      /** 空串别提交：后端会把 '' 当数字解析失败，直接报「不能为负」 */
      function dropEmptyNumbers(record, keys) {
        var out = Object.assign({}, record || {});
        (keys || []).forEach(function (key) {
          if (!(key in out)) return;
          var value = out[key];
          if (value === undefined || value === null) {
            delete out[key];
            return;
          }
          if (typeof value === 'string' && value.trim() === '') delete out[key];
        });
        return out;
      }

      function optionsFrom(list, labelOf) {
        return (list || []).map(function (item) {
          return { value: item, label: labelOf ? labelOf(item) : item };
        });
      }

      function renderControl(field, value, onChange, invalid) {
        if (field.type === 'select') {
          return h(Select, { value: value, options: field.options || [], onChange: onChange, invalid: invalid });
        }
        if (field.type === 'switch') {
          return h('div', { className: 'btl-switch-row' }, h(Switch, { checked: Boolean(value), onChange: onChange }));
        }
        if (field.type === 'textarea') {
          return h(TextArea, { value: value, placeholder: field.placeholder, onChange: onChange, rows: field.rows, invalid: invalid });
        }
        if (field.type === 'number') {
          return h(TextInput, {
            value: value,
            placeholder: field.placeholder,
            inputMode: 'decimal',
            onChange: onChange,
            invalid: invalid
          });
        }
        return h(TextInput, {
          value: value,
          placeholder: field.placeholder,
          onChange: onChange,
          autoFocus: field.autoFocus,
          invalid: invalid
        });
      }

      function Form(props) {
        var moreState = React.useState(false);
        var more = moreState[0];
        var setMore = moreState[1];
        var localErrorState = React.useState('');
        var localError = localErrorState[0];
        var setLocalError = localErrorState[1];
        var fields = props.fields;
        var primary = fields.filter(function (field) {
          return !field.advanced;
        });
        var advanced = fields.filter(function (field) {
          return field.advanced;
        });

        function isEmptyValue(value) {
          return String(value === undefined || value === null ? '' : value).trim() === '';
        }

        /** 必填项在本地就拦住：不依赖服务端 400 / toast */
        function missingLabels() {
          return fields
            .filter(function (field) {
              return field.required && isEmptyValue(props.draft[field.key]);
            })
            .map(function (field) {
              return field.label;
            });
        }

        function submit() {
          if (props.busy) return;
          var missing = missingLabels();
          if (missing.length) {
            setLocalError(t('form.requiredMissing', { fields: missing.join(t('misc.listSep')) }));
            return;
          }
          setLocalError('');
          props.onSubmit();
        }

        function renderField(field) {
          var invalid = Boolean(localError) && field.required && isEmptyValue(props.draft[field.key]);
          return h(
            Field,
            {
              key: field.key,
              label: field.label,
              hint: field.hint,
              required: field.required,
              wide: field.wide || field.type === 'textarea'
            },
            renderControl(field, props.draft[field.key], function (next) {
              var patch = {};
              patch[field.key] = next;
              props.onChange(patch);
              if (localError) setLocalError('');
            }, invalid)
          );
        }

        return h(
          'div',
          { className: 'btl-form-wrap' },
          props.title
            ? h(
                'div',
                { className: 'btl-form-head' },
                h('span', { className: 'btl-form-title' }, props.title),
                props.dirty ? h('span', { className: 'btl-form-dirty' }, t('form.dirty')) : null
              )
            : null,
          props.photoBlock ? h('div', { className: 'btl-form-photos' }, props.photoBlock) : null,
          h(
            'div',
            { className: 'btl-form' },
            primary.map(renderField),
            more ? advanced.map(renderField) : null
          ),
          advanced.length
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'btl-link',
                  onClick: function () {
                    setMore(!more);
                  }
                },
                more ? t('form.less') : t('form.more')
              )
            : null,
          h(
            'div',
            { className: 'btl-form-actions' },
            h(
              Btn,
              { tone: 'primary', onClick: submit, disabled: props.busy },
              props.busy ? t('form.saving') : props.submitLabel || t('form.save')
            ),
            h(Btn, { tone: 'ghost', onClick: props.onCancel, disabled: props.busy }, t('form.cancel')),
            props.onDelete
              ? h(ConfirmButton, { onConfirm: props.onDelete, disabled: props.busy })
              : null
          ),
          localError ? h('div', { className: 'btl-form-error', role: 'alert' }, localError) : null,
          props.error ? h('div', { className: 'btl-form-error' }, props.error) : null
        );
      }

      function ConfirmButton(props) {
        var armedState = React.useState(false);
        var armed = armedState[0];
        var setArmed = armedState[1];
        React.useEffect(function () {
          if (!armed) return undefined;
          var id = setTimeout(function () {
            setArmed(false);
          }, 3000);
          return function () {
            clearTimeout(id);
          };
        }, [armed]);
        return h(
          Btn,
          {
            tone: 'danger',
            icon: 'trash',
            size: props.size,
            disabled: props.disabled,
            onClick: function () {
              if (!armed) {
                setArmed(true);
                return;
              }
              setArmed(false);
              props.onConfirm();
            }
          },
          armed ? t('form.deleteConfirm') : props.label || t('form.delete')
        );
      }

      /* ------------------------------------------------------------------ *
       * 汇总卡
       * ------------------------------------------------------------------ */

      function StatCard(props) {
        return h(
          'button',
          {
            type: 'button',
            className: 'btl-stat' + (props.tone ? ' btl-stat-' + props.tone : ''),
            onClick: props.onClick
          },
          h(
            'span',
            { className: 'btl-stat-head' },
            h('span', { className: 'btl-stat-label' }, props.label),
            h(Ico, { name: props.icon || 'dot', size: 14 })
          ),
          h('span', { className: 'btl-stat-value' }, props.value),
          h('span', { className: 'btl-stat-sub' }, props.sub)
        );
      }

      /** 主币种取默认币种（没有就取第一个），其余币种一并带回，调用方负责展示 */
      function pickPrimaryTotal(totals, preferred) {
        var map = totals || {};
        var keys = Object.keys(map);
        if (!keys.length) return null;
        var code = keys[0];
        if (preferred && keys.indexOf(preferred) >= 0) code = preferred;
        var others = keys
          .filter(function (key) {
            return key !== code;
          })
          .sort()
          .map(function (key) {
            return { code: key, total: map[key] };
          });
        return { code: code, total: map[code], others: others };
      }

      function Hero(props) {
        var data = props.data;
        var summary = data.summary || {};
        var currency = (data.config && data.config.currency) || 'CNY';
        var totals = pickPrimaryTotal(summary.subscriptionTotals, currency);

        var monthlyValue = '—';
        var monthlySub = t('stat.monthly.none');
        if (totals && totals.total) {
          monthlyValue = fmtMoney(totals.total.monthly, totals.code);
          monthlySub = joinExtras(
            t('stat.monthly.sub') + ' ' + fmtMoney(totals.total.yearly, totals.code),
            totals.others,
            function (entry) {
              return t('stat.monthly.other', { amount: fmtMoney(entry.total.monthly, entry.code) });
            }
          );
        }

        var next = props.nextAsset;
        var nextValue = next ? next.name : '—';
        var nextSub = next ? fmtDate(next.expiresAt) + ' · ' + fmtRelative(next.expiresAt) : t('stat.nextExpiry.sub');
        var nextTone = next ? expiryTone(dayDiff(next.expiresAt)) : '';

        var todoPending = summary.todoPending || 0;
        var overdue = (data.todos || []).filter(function (todo) {
          return todo.status === 'pending' && todo.dueAt && toDate(todo.dueAt) && toDate(todo.dueAt).getTime() < Date.now();
        }).length;
        var todoValue = t('stat.todos.count', { n: todoPending });
        var todoSub = overdue ? t('stat.todos.overdue', { n: overdue }) : t('stat.todos.none');

        var debts = pickPrimaryTotal(summary.debtTotals, currency);
        var debtValue = '—';
        var debtSub = t('misc.none');
        var debtTone = '';
        if (debts && debts.total) {
          var total = debts.total;
          /* 正负号放在货币符号前：-¥30，不是 ¥-30 */
          debtValue = fmtSignedMoney(total.net, debts.code);
          debtSub = joinExtras(
            fmtMoney(total.owedToMe, debts.code) + ' / ' + fmtMoney(total.iOwe, debts.code),
            debts.others,
            function (entry) {
              return t('stat.debt.other', { amount: fmtSignedMoney(entry.total.net, entry.code) });
            }
          );
          debtTone = total.net > 0 ? 'ok' : total.net < 0 ? 'danger' : '';
        }
        if (!debts) {
          debtValue = fmtMoney(0, currency);
          debtSub = t('stat.debt.none');
        }

        return h(
          'div',
          { className: 'btl-hero' },
          h(StatCard, {
            label: t('stat.monthly'),
            value: monthlyValue,
            sub: monthlySub,
            icon: 'card',
            onClick: function () {
              props.onJump('assets');
            }
          }),
          h(StatCard, {
            label: t('stat.nextExpiry'),
            value: nextValue,
            sub: nextSub,
            tone: nextTone,
            icon: 'clock',
            onClick: function () {
              props.onJump('assets');
            }
          }),
          h(StatCard, {
            label: t('stat.todos'),
            value: todoValue,
            sub: todoSub,
            tone: overdue ? 'danger' : '',
            icon: 'list',
            onClick: function () {
              props.onJump('todos');
            }
          }),
          h(StatCard, {
            label: t('stat.debt'),
            value: debtValue,
            sub: debtSub,
            tone: debtTone,
            icon: 'wallet',
            onClick: function () {
              props.onJump('debts');
            }
          })
        );
      }

      /* ------------------------------------------------------------------ *
       * 资产：订阅行 + 额度卡
       * ------------------------------------------------------------------ */

      function assetFields(forCreate) {
        var kinds = CYCLES;
        void kinds;
        return [
          {
            key: 'name',
            label: t('field.name'),
            required: true,
            placeholder: t('ph.assetName')
          },
          {
            key: 'amount',
            label: t('field.amount'),
            type: 'number',
            /* 只在新增时本地必填：历史记录可能是 0/空，编辑时不拦，避免把旧记录锁死 */
            required: Boolean(forCreate),
            hint: t('field.amountHint'),
            placeholder: '20'
          },
          {
            key: 'currency',
            label: t('field.currency'),
            type: 'select',
            options: optionsFrom(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'HKD'])
          },
          {
            key: 'cycle',
            label: t('field.cycle'),
            type: 'select',
            options: [
              { value: 'monthly', label: t('cycle.monthly') },
              { value: 'quarterly', label: t('cycle.quarterly') },
              { value: 'yearly', label: t('cycle.yearly') },
              { value: 'weekly', label: t('cycle.weekly') },
              { value: 'once', label: t('cycle.once') }
            ]
          },
          {
            key: 'expiresAt',
            label: t('field.expiresAt'),
            placeholder: t('ph.expiresAt')
          },
          {
            key: 'kind',
            label: t('field.kind'),
            type: 'select',
            advanced: true,
            options: []
          },
          { key: 'vendor', label: t('field.vendor'), advanced: true, placeholder: 'Anthropic' },
          { key: 'autoRenew', label: t('field.autoRenew'), type: 'switch', advanced: true },
          { key: 'startedAt', label: t('field.startedAt'), advanced: true, placeholder: '2026-01-01' },
          { key: 'notes', label: t('field.notes'), type: 'textarea', wide: true, advanced: true }
        ];
      }

      var CYCLES = ['monthly', 'quarterly', 'yearly', 'weekly', 'once'];

      function kindOptions(kinds) {
        return (kinds || []).map(function (kind) {
          return { value: kind.id, label: kind.label };
        });
      }

      function AssetRow(props) {
        var asset = props.asset;
        var editingState = React.useState(false);
        var editing = editingState[0];
        var setEditing = editingState[1];
        var draftState = React.useState({});
        var draft = draftState[0];
        var setDraft = draftState[1];
        var days = dayDiff(asset.expiresAt);
        var tone = expiryTone(days);

        function begin() {
          setDraft({
            name: asset.name || '',
            amount: asset.amount === undefined || asset.amount === null ? '' : asset.amount,
            currency: asset.currency || props.defaultCurrency,
            cycle: asset.cycle || 'monthly',
            expiresAt: asset.expiresAt || '',
            kind: asset.kind || 'subscription',
            vendor: asset.vendor || '',
            autoRenew: Boolean(asset.autoRenew),
            startedAt: asset.startedAt || '',
            notes: asset.notes || ''
          });
          setEditing(true);
        }

        if (editing) {
          var fields = assetFields(false);
          fields[0].autoFocus = true;
          fields[5].options = kindOptions(props.kinds);
          return h(
            'li',
            { className: 'btl-item btl-item-editing' },
            h(Form, {
              title: asset.name,
              fields: fields,
              draft: draft,
              dirty: true,
              busy: props.busy,
              onChange: function (patch) {
                setDraft(Object.assign({}, draft, patch));
              },
              onSubmit: function () {
                props.onSave(Object.assign({ id: asset.id }, draft), function (ok) {
                  if (ok) setEditing(false);
                });
              },
              onCancel: function () {
                setEditing(false);
              },
              onDelete: function () {
                props.onDelete(asset.id);
              }
            })
          );
        }

        var cycleText = t('cycle.' + (asset.cycle || 'monthly'));
        return h(
          'li',
          { className: 'btl-item btl-item-hover' },
          h('span', { className: 'btl-item-mark', 'data-tone': tone || 'idle' }, (asset.name || '?').slice(0, 1).toUpperCase()),
          h(
            'span',
            {
              className: 'btl-item-main btl-item-clickable',
              onClick: begin,
              role: 'button',
              tabIndex: 0,
              onKeyDown: activateOnKey(begin)
            },
            h(
              'span',
              { className: 'btl-item-title btl-item-title-clamp' },
              h('span', { className: 'btl-item-name' }, asset.name),
              asset.autoRenew ? h(Chip, { tone: 'muted' }, t('badge.autoRenew')) : null
            ),
            h(
              'span',
              { className: 'btl-item-meta' },
              h('span', { className: 'btl-item-amount' }, fmtMoney(asset.amount, asset.currency)),
              h('span', { className: 'btl-sep' }, '·'),
              h('span', null, cycleText),
              asset.expiresAt
                ? h('span', { className: 'btl-sep' }, '·')
                : null,
              asset.expiresAt
                ? h('span', null, fmtDate(asset.expiresAt))
                : h('span', null, t('time.noExpiry'))
            )
          ),
          h(
            'span',
            { className: 'btl-item-side' },
            asset.expiresAt
              ? h(Chip, { tone: tone || 'ok' }, fmtRelative(asset.expiresAt))
              : null,
            h(IconBtn, { icon: 'edit', title: t('form.edit'), onClick: function (event) {
              event.stopPropagation();
              begin();
            } })
          )
        );
      }

      function PlanCard(props) {
        var plan = props.plan;
        var windows = plan.windows || [];
        var credOpenState = React.useState(false);
        var credOpen = credOpenState[0];
        var setCredOpen = credOpenState[1];
        var credState = React.useState('');
        var cred = credState[0];
        var setCred = credState[1];
        var busy = Boolean(props.busy);
        var statusTone =
          plan.status === 'ok' ? 'ok' : plan.status === 'error' ? 'danger' : plan.status === 'no-credential' ? 'warn' : 'muted';

        return h(
          'li',
          { className: 'btl-plan' },
          h(
            'div',
            { className: 'btl-plan-head' },
            h(
              'div',
              { className: 'btl-plan-title' },
              h('span', { className: 'btl-plan-name' }, plan.name),
              plan.planLabel ? h(Chip, { tone: 'muted' }, plan.planLabel) : null,
              h(Chip, { tone: statusTone }, t('plans.status.' + (plan.status || 'unknown')))
            ),
            h(
              'div',
              { className: 'btl-plan-actions' },
              h(
                IconBtn,
                {
                  icon: 'refresh',
                  title: t('plans.refresh'),
                  disabled: busy,
                  onClick: function () {
                    props.onRefresh(plan.id);
                  }
                }
              ),
              h(
                IconBtn,
                {
                  icon: 'user',
                  title: t('plans.credential'),
                  onClick: function () {
                    setCredOpen(!credOpen);
                  }
                }
              ),
              h(ConfirmButton, {
                size: 'sm',
                disabled: busy,
                onConfirm: function () {
                  props.onDelete(plan.id);
                }
              })
            )
          ),
          windows.length
            ? h(
                'div',
                { className: 'btl-plan-windows' },
                windows.map(function (window) {
                  var tone = toneOfLevel(window.level);
                  // 余额型窗口没有「用了百分之几」这个语义，画进度条会显示成「已用 0%」——那是假信息
                  if (isBalanceWindow(window)) {
                    return h(
                      'div',
                      { className: 'btl-window btl-window-balance', key: window.key },
                      h(
                        'div',
                        { className: 'btl-window-head' },
                        h('span', { className: 'btl-window-label' }, window.label),
                        h(
                          'span',
                          {
                            className: 'btl-window-value btl-balance-value' + (tone ? ' btl-tone-' + tone : '')
                          },
                          balanceLabel(window)
                        )
                      ),
                      window.resetAt
                        ? h(
                            'div',
                            { className: 'btl-window-foot' },
                            h('span', null, t('plans.reset') + ' ' + fmtDate(window.resetAt, true)),
                            h('span', null, '')
                          )
                        : null
                    );
                  }
                  var usedText = t('plans.used', { v: percentLabel(window.percent) });
                  return h(
                    'div',
                    { className: 'btl-window', key: window.key },
                    h(
                      'div',
                      { className: 'btl-window-head' },
                      h('span', { className: 'btl-window-label' }, window.label),
                      h(
                        'span',
                        { className: 'btl-window-value' + (tone ? ' btl-tone-' + tone : '') },
                        usedText
                      )
                    ),
                    h(Bar, {
                      percent: window.percent,
                      tone: tone,
                      label: window.label ? window.label + ' · ' + usedText : usedText
                    }),
                    h(
                      'div',
                      { className: 'btl-window-foot' },
                      h(
                        'span',
                        null,
                        windowRemainingLabel(window)
                          ? t('plans.remaining') + ' ' + windowRemainingLabel(window)
                          : ''
                      ),
                      window.resetAt ? h('span', null, t('plans.reset') + ' ' + fmtDate(window.resetAt, true)) : null
                    )
                  );
                })
              )
            : h(
                'div',
                { className: 'btl-plan-empty' },
                h(
                  'span',
                  null,
                  plan.status === 'error'
                    ? plan.error || t('plans.noWindows')
                    : plan.hasCredential
                    ? t('plans.noWindows')
                    : t('plans.needCredential')
                ),
                plan.hasCredential
                  ? h(Btn, {
                      tone: 'ghost',
                      size: 'sm',
                      icon: 'refresh',
                      disabled: busy,
                      onClick: function () {
                        props.onRefresh(plan.id);
                      }
                    }, t('plans.refresh'))
                  : h(Btn, {
                      tone: 'primary',
                      size: 'sm',
                      icon: 'user',
                      onClick: function () {
                        setCredOpen(true);
                      }
                    }, t('plans.credentialSet'))
              ),
          h(
            'div',
            { className: 'btl-plan-foot' },
            h('span', null, t('plans.lastChecked') + ' ' + fmtAgo(plan.lastCheckedAt)),
            plan.sourceLabel
              ? h('span', { className: 'btl-plan-source' }, plan.sourceLabel + (plan.sourceCustom ? ' · ' + t('sources.custom') : ''))
              : null
          ),
          credOpen
            ? h(
                'div',
                { className: 'btl-cred' },
                h('div', { className: 'btl-cred-hint' }, t('plans.credentialHint')),
                h(TextInput, {
                  value: cred,
                  placeholder: 'sk-… / cookie / token',
                  onChange: setCred
                }),
                h(
                  'div',
                  { className: 'btl-form-actions' },
                  h(
                    Btn,
                    {
                      tone: 'primary',
                      disabled: !cred.trim() || busy,
                      onClick: function () {
                        props.onCredential(plan.id, cred.trim(), function (ok) {
                          if (!ok) return;
                          setCred('');
                          setCredOpen(false);
                        });
                      }
                    },
                    t('plans.credentialSave')
                  ),
                  h(
                    Btn,
                    {
                      tone: 'ghost',
                      onClick: function () {
                        setCredOpen(false);
                        setCred('');
                      }
                    },
                    t('form.cancel')
                  )
                )
              )
            : null
        );
      }

      function AssetsTab(props) {
        var data = props.data;
        var api = props.api;
        var filterState = React.useState('all');
        var filter = filterState[0];
        var setFilter = filterState[1];
        var sortState = React.useState('expiry');
        var sort = sortState[0];
        var setSort = sortState[1];
        var addingState = React.useState(null);
        var adding = addingState[0];
        var setAdding = addingState[1];
        var draftState = React.useState({});
        var draft = draftState[0];
        var setDraft = draftState[1];
        var query = props.query;

        var assets = (data.assets || []).filter(function (asset) {
          if (!query) return true;
          var haystack = [asset.name, asset.vendor, asset.notes, asset.kind].join(' ').toLowerCase();
          return haystack.indexOf(query) >= 0;
        });
        var plans = (data.plans || []).filter(function (plan) {
          if (!query) return true;
          return [plan.name, plan.planLabel, plan.provider].join(' ').toLowerCase().indexOf(query) >= 0;
        });

        var defaultCurrency = (data.config && data.config.currency) || 'CNY';

        assets = assets.slice().sort(function (a, b) {
          if (sort === 'name') return String(a.name).localeCompare(String(b.name));
          if (sort === 'amount') {
            /* 跨币种不可比：先按币种分组，组内再比金额 */
            var codeA = String(a.currency || defaultCurrency).toUpperCase();
            var codeB = String(b.currency || defaultCurrency).toUpperCase();
            if (codeA !== codeB) return codeA < codeB ? -1 : 1;
            return Number(b.amount || 0) - Number(a.amount || 0);
          }
          var left = toDate(a.expiresAt);
          var right = toDate(b.expiresAt);
          if (!left && !right) return 0;
          if (!left) return 1;
          if (!right) return -1;
          return left.getTime() - right.getTime();
        });

        function startAdd(kind) {
          if (kind === 'plan') {
            setDraft({ name: '', sourceId: 'generic', planLabel: '' });
            setAdding('plan');
            return;
          }
          setDraft({
            name: '',
            amount: '',
            currency: (data.config && data.config.currency) || 'CNY',
            cycle: 'monthly',
            expiresAt: '',
            kind: 'subscription',
            vendor: '',
            autoRenew: true,
            startedAt: '',
            notes: ''
          });
          setAdding('asset');
        }

        var showSubs = filter !== 'plan';
        var showPlans = filter !== 'sub';

        var subFields = assetFields(true);
        subFields[0].autoFocus = true;
        subFields[5].options = kindOptions(data.kinds);
        var planFields = [
          { key: 'name', label: t('field.planName'), required: true, placeholder: t('ph.planName'), autoFocus: true },
          {
            key: 'sourceId',
            label: t('field.sourceId'),
            type: 'select',
            options: (data.sources || []).map(function (source) {
              return { value: source.id, label: source.label || source.id };
            })
          },
          { key: 'planLabel', label: t('field.planLabel'), placeholder: 'Pro / Max 20x' }
        ];

        return h(
          'div',
          { className: 'btl-tab-body' },
          h(
            'div',
            { className: 'btl-toolbar' },
            h(Segmented, {
              value: filter,
              onChange: setFilter,
              items: [
                { value: 'all', label: t('assets.filter.all') },
                { value: 'sub', label: t('assets.filter.sub'), count: (data.assets || []).length },
                { value: 'plan', label: t('assets.filter.plan'), count: (data.plans || []).length }
              ]
            }),
            h('span', { className: 'btl-toolbar-gap' }),
            showSubs
              ? h(Select, {
                  className: 'btl-select-inline',
                  value: sort,
                  onChange: setSort,
                  options: [
                    { value: 'expiry', label: t('assets.sort.expiry') },
                    { value: 'amount', label: t('assets.sort.amount') },
                    { value: 'name', label: t('assets.sort.name') }
                  ]
                })
              : null,
            h(Btn, { tone: 'primary', icon: 'plus', size: 'sm', onClick: function () {
              startAdd('asset');
            } }, t('assets.add')),
            h(Btn, { tone: 'ghost', icon: 'bolt', size: 'sm', onClick: function () {
              startAdd('plan');
            } }, t('assets.planAdd'))
          ),
          showSubs
            ? h(
                'section',
                { className: 'btl-section' },
                h(
                  'div',
                  { className: 'btl-section-head' },
                  h('h3', null, t('assets.title')),
                  h('span', { className: 'btl-count' }, t('misc.count', { n: assets.length }))
                ),
                adding === 'asset'
                  ? h(
                      'div',
                      { className: 'btl-card btl-card-form' },
                      h(Form, {
                        title: t('assets.add'),
                        fields: subFields,
                        draft: draft,
                        busy: api.isBusy('mutate:assets'),
                        onChange: function (patch) {
                          setDraft(Object.assign({}, draft, patch));
                        },
                        onSubmit: function () {
                          var record = dropEmptyNumbers(draft, ['amount']);
                          api.mutate('assets', 'create', record).then(function (outcome) {
                            if (!outcome || !outcome.ok) return;
                            setAdding(null);
                            // 后端发现这是「同款软件的新一期订阅」时会把旧记录续期，别让用户以为没记上
                            var payload = outcome.result && outcome.result.result;
                            if (payload && payload.renewed) api.notify(t('toast.renewed'));
                          });
                        },
                        onCancel: function () {
                          setAdding(null);
                        }
                      })
                    )
                  : null,
                assets.length
                  ? h(
                      'ul',
                      { className: 'btl-list btl-list-grid' },
                      assets.map(function (asset) {
                        return h(AssetRow, {
                          key: asset.id,
                          asset: asset,
                          kinds: data.kinds,
                          defaultCurrency: defaultCurrency,
                          busy: api.isBusy('mutate:assets'),
                          onSave: function (record, done) {
                            api.mutate('assets', 'update', dropEmptyNumbers(record, ['amount']), record.id).then(function (outcome) {
                              done(Boolean(outcome && outcome.ok));
                            });
                          },
                          onDelete: function (id) {
                            api.mutate('assets', 'delete', null, id);
                          }
                        });
                      })
                    )
                  : adding === 'asset'
                  ? null
                  : h(Empty, {
                      icon: 'card',
                      title: query ? t('app.searchEmpty') : t('assets.empty'),
                      hint: query ? null : t('assets.emptyHint'),
                      action: query
                        ? null
                        : h(Btn, { tone: 'primary', icon: 'plus', onClick: function () {
                            startAdd('asset');
                          } }, t('assets.add'))
                    })
              )
            : null,
          showPlans
            ? h(
                'section',
                { className: 'btl-section' },
                h(
                  'div',
                  { className: 'btl-section-head' },
                  h('h3', null, t('assets.plans')),
                  h('span', { className: 'btl-count' }, t('misc.count', { n: plans.length }))
                ),
                adding === 'plan'
                  ? h(
                      'div',
                      { className: 'btl-card btl-card-form' },
                      h(Form, {
                        title: t('assets.planAdd'),
                        fields: planFields,
                        draft: draft,
                        busy: api.isBusy('mutate:plans'),
                        onChange: function (patch) {
                          setDraft(Object.assign({}, draft, patch));
                        },
                        onSubmit: function () {
                          api.mutate('plans', 'create', draft).then(function (outcome) {
                            if (outcome && outcome.ok) setAdding(null);
                          });
                        },
                        onCancel: function () {
                          setAdding(null);
                        }
                      })
                    )
                  : null,
                plans.length
                  ? h(
                      'ul',
                      { className: 'btl-plan-list' },
                      plans.map(function (plan) {
                        return h(PlanCard, {
                          key: plan.id,
                          plan: plan,
                          busy: api.isBusy('quota:' + plan.id),
                          onRefresh: function (id) {
                            api
                              .send('/quota/refresh', { planId: id }, { key: 'quota:' + id, success: t('toast.quotaRequested') })
                              .catch(function () {});
                          },
                          onDelete: function (id) {
                            api.mutate('plans', 'delete', null, id);
                          },
                          onCredential: function (id, credential, done) {
                            api
                              .send('/plans/credential', { planId: id, credential: credential }, {
                                key: 'cred:' + id,
                                success: t('plans.credentialSaved')
                              })
                              .then(function () {
                                api.send('/quota/refresh', { planId: id }, { key: 'quota:' + id }).catch(function () {});
                                done(true);
                              }, function () {
                                done(false);
                              });
                          }
                        });
                      })
                    )
                  : adding === 'plan'
                  ? null
                  : h('div', { className: 'btl-empty-narrow' }, h(Empty, {
                      icon: 'bolt',
                      title: t('assets.plansEmpty'),
                      hint: t('assets.plansEmptyHint'),
                      action: h(Btn, { tone: 'ghost', icon: 'plus', onClick: function () {
                        startAdd('plan');
                      } }, t('assets.planAdd'))
                    }))
              )
            : null
        );
      }

/* ------------------------------------------------------------------ *
       * 待办
       * ------------------------------------------------------------------ */

      function advanceOptions() {
        return [0, 10, 30, 60, 1440, 2880, 4320, 10080].map(function (minutes) {
          return { value: minutes, label: t('advance.' + minutes) };
        });
      }

      function todoFields() {
        return [
          { key: 'title', label: t('field.title'), required: true, wide: true, placeholder: t('ph.todoTitle'), autoFocus: true },
          {
            key: 'direction',
            label: t('field.direction'),
            type: 'select',
            options: [
              { value: 'awaiting_me', label: t('dir.awaiting_me') },
              { value: 'waiting_other', label: t('dir.waiting_other') }
            ]
          },
          { key: 'counterpart', label: t('field.counterpart'), placeholder: t('ph.counterpart') },
          { key: 'dueAt', label: t('field.dueAt'), placeholder: t('ph.todoDueAt') },
          { key: 'advanceMinutes', label: t('field.advanceMinutes'), type: 'select', options: advanceOptions() },
          {
            key: 'priority',
            label: t('field.priority'),
            type: 'select',
            options: [
              { value: 'low', label: t('prio.low') },
              { value: 'normal', label: t('prio.normal') },
              { value: 'high', label: t('prio.high') }
            ]
          },
          { key: 'detail', label: t('field.detail'), type: 'textarea', wide: true }
        ];
      }

      function TodoRow(props) {
        var todo = props.todo;
        var editingState = React.useState(false);
        var editing = editingState[0];
        var setEditing = editingState[1];
        var draftState = React.useState({});
        var draft = draftState[0];
        var setDraft = draftState[1];
        var done = todo.status === 'done';
        var days = dayDiff(todo.dueAt);
        var overdue = !done && todo.dueAt && toDate(todo.dueAt) && toDate(todo.dueAt).getTime() < Date.now();

        function begin() {
          setDraft({
            title: todo.title || '',
            direction: todo.direction || 'awaiting_me',
            counterpart: todo.counterpart || '',
            dueAt: todo.dueAt || '',
            advanceMinutes: todo.advanceMinutes === undefined || todo.advanceMinutes === null ? 30 : todo.advanceMinutes,
            priority: todo.priority || 'normal',
            detail: todo.detail || '',
            status: todo.status || 'pending'
          });
          setEditing(true);
        }

        if (editing) {
          return h(
            'li',
            { className: 'btl-item btl-item-editing' },
            h(Form, {
              title: todo.title,
              fields: todoFields(),
              draft: draft,
              dirty: true,
              busy: props.busy,
              onChange: function (patch) {
                setDraft(Object.assign({}, draft, patch));
              },
              onSubmit: function () {
                props.onSave(Object.assign({ id: todo.id }, draft), function (ok) {
                  if (ok) setEditing(false);
                });
              },
              onCancel: function () {
                setEditing(false);
              },
              onDelete: function () {
                props.onDelete(todo.id);
              }
            })
          );
        }

        return h(
          'li',
          { className: 'btl-item btl-item-todo' + (done ? ' btl-item-done' : '') },
          h(
            'button',
            {
              type: 'button',
              className: 'btl-check' + (done ? ' btl-check-on' : ''),
              title: done ? t('todos.reopen') : t('todos.done'),
              'aria-label': done ? t('todos.reopen') : t('todos.done'),
              onClick: function (event) {
                event.stopPropagation();
                props.onToggle(todo);
              }
            },
            done ? h(Ico, { name: 'check', size: 12, strokeWidth: 2.2 }) : null
          ),
          h(
            'span',
            { className: 'btl-item-main btl-item-clickable', onClick: begin, role: 'button', tabIndex: 0, onKeyDown: activateOnKey(begin) },
            h(
              'span',
              { className: 'btl-item-title' },
              todo.title,
              todo.priority === 'high' ? h(Chip, { tone: 'danger' }, t('prio.high')) : null,
              todo.counterpart
                ? h(
                    Chip,
                    { tone: 'muted' },
                    todo.direction === 'waiting_other'
                      ? t('todos.waitingOn', { name: todo.counterpart })
                      : todo.counterpart
                  )
                : null
            ),
            h(
              'span',
              { className: 'btl-item-meta' },
              todo.dueAt ? h('span', null, fmtDate(todo.dueAt, true)) : h('span', null, t('time.none')),
              todo.dueAt ? h('span', { className: 'btl-sep' }, '·') : null,
              todo.dueAt ? h('span', null, fmtRelative(todo.dueAt)) : null,
              overdue ? h('span', { className: 'btl-badge btl-badge-danger' }, t('todos.overdue')) : null
            )
          ),
          h(
            'span',
            { className: 'btl-item-side' },
            h(IconBtn, { icon: 'edit', title: t('form.edit'), onClick: begin })
          )
        );
      }

      function TodosTab(props) {
        var data = props.data;
        var api = props.api;
        var query = props.query;
        var showState = React.useState('open');
        var show = showState[0];
        var setShow = showState[1];
        var addingState = React.useState(false);
        var adding = addingState[0];
        var setAdding = addingState[1];
        var draftState = React.useState({});
        var draft = draftState[0];
        var setDraft = draftState[1];

        var all = (data.todos || []).filter(function (todo) {
          if (!query) return true;
          return [todo.title, todo.detail, todo.counterpart].join(' ').toLowerCase().indexOf(query) >= 0;
        });
        var visible = all.filter(function (todo) {
          if (show === 'all') return true;
          if (show === 'done') return todo.status === 'done';
          return todo.status === 'pending';
        });
        var mine = visible.filter(function (todo) {
          return todo.direction !== 'waiting_other';
        });
        var theirs = visible.filter(function (todo) {
          return todo.direction === 'waiting_other';
        });

        function startAdd() {
          setDraft({
            title: '',
            direction: 'awaiting_me',
            counterpart: '',
            dueAt: '',
            advanceMinutes: (data.config && data.config.advanceMinutes) || 30,
            priority: 'normal',
            detail: ''
          });
          setAdding(true);
        }

        function renderList(items, emptyHint) {
          if (!items.length) {
            return h('div', { className: 'btl-sublist-empty' }, emptyHint);
          }
          return h(
            'ul',
            { className: 'btl-list' },
            items.map(function (todo) {
              return h(TodoRow, {
                key: todo.id,
                todo: todo,
                busy: api.isBusy('mutate:todos'),
                onSave: function (record, done) {
                  api.mutate('todos', 'update', record, record.id).then(function (outcome) {
                    done(Boolean(outcome && outcome.ok));
                  });
                },
                onDelete: function (id) {
                  api.mutate('todos', 'delete', null, id);
                },
                onToggle: function (item) {
                  api.mutate('todos', 'update', { id: item.id, status: item.status === 'done' ? 'pending' : 'done' }, item.id);
                }
              });
            })
          );
        }

        return h(
          'div',
          { className: 'btl-tab-body' },
          h(
            'div',
            { className: 'btl-toolbar' },
            h(Segmented, {
              value: show,
              onChange: setShow,
              items: [
                { value: 'open', label: t('todos.filter.open'), count: (data.todos || []).filter(function (todo) {
                  return todo.status === 'pending';
                }).length },
                { value: 'all', label: t('todos.filter.all'), count: (data.todos || []).length },
                { value: 'done', label: t('todos.filter.done'), count: (data.todos || []).filter(function (todo) {
                  return todo.status === 'done';
                }).length }
              ]
            }),
            h('span', { className: 'btl-toolbar-gap' }),
            h(Btn, { tone: 'primary', icon: 'plus', size: 'sm', onClick: startAdd }, t('todos.add'))
          ),
          adding
            ? h(
                'div',
                { className: 'btl-card btl-card-form' },
                h(Form, {
                  title: t('todos.add'),
                  fields: todoFields(),
                  draft: draft,
                  busy: api.isBusy('mutate:todos'),
                  onChange: function (patch) {
                    setDraft(Object.assign({}, draft, patch));
                  },
                  onSubmit: function () {
                    api.mutate('todos', 'create', draft).then(function (outcome) {
                      if (outcome && outcome.ok) setAdding(false);
                    });
                  },
                  onCancel: function () {
                    setAdding(false);
                  }
                })
              )
            : null,
          h(
            'section',
            { className: 'btl-section' },
            h(
              'div',
              { className: 'btl-section-head' },
              h('h3', null, t('todos.mine')),
              h('span', { className: 'btl-count' }, t('misc.count', { n: mine.length }))
            ),
            renderList(mine, query ? t('app.searchEmpty') : h(
              'span',
              null,
              t('todos.empty'),
              ' · ',
              h('button', { type: 'button', className: 'btl-link', onClick: startAdd }, t('todos.add'))
            ))
          ),
          h(
            'section',
            { className: 'btl-section' },
            h(
              'div',
              { className: 'btl-section-head' },
              h('h3', null, t('todos.theirs')),
              h('span', { className: 'btl-count' }, t('misc.count', { n: theirs.length }))
            ),
            renderList(theirs, query ? t('app.searchEmpty') : t('todos.emptyHintTheirs'))
          )
        );
      }

      /* ------------------------------------------------------------------ *
       * 账本
       * ------------------------------------------------------------------ */

      function debtFields() {
        return [
          { key: 'counterpart', label: t('field.counterpartName'), required: true, placeholder: t('ph.debtCounterpart'), autoFocus: true },
          {
            key: 'direction',
            label: t('field.direction'),
            type: 'select',
            options: [
              { value: 'owedToMe', label: t('debt.owedToMe') },
              { value: 'iOwe', label: t('debt.iOwe') }
            ]
          },
          { key: 'amount', label: t('field.amount'), type: 'number', placeholder: '500' },
          {
            key: 'currency',
            label: t('field.currency'),
            type: 'select',
            options: optionsFrom(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'HKD'])
          },
          {
            key: 'status',
            label: t('field.status'),
            type: 'select',
            options: [
              { value: 'open', label: t('debt.status.open') },
              { value: 'settled', label: t('debt.status.settled') }
            ]
          },
          { key: 'dueAt', label: t('field.dueAt'), placeholder: t('ph.debtDueAt') },
          { key: 'advanceMinutes', label: t('field.advanceMinutes'), type: 'select', options: advanceOptions() },
          { key: 'note', label: t('field.notes'), type: 'textarea', wide: true }
        ];
      }

      function DebtRow(props) {
        var debt = props.debt;
        var editingState = React.useState(false);
        var editing = editingState[0];
        var setEditing = editingState[1];
        var draftState = React.useState({});
        var draft = draftState[0];
        var setDraft = draftState[1];
        var settled = debt.status === 'settled';
        var outlier = debt.direction === 'owedToMe';

        function begin() {
          setDraft({
            counterpart: debt.counterpart || '',
            direction: debt.direction || 'owedToMe',
            amount: debt.amount === undefined || debt.amount === null ? '' : debt.amount,
            currency: debt.currency || (props.defaultCurrency || 'CNY'),
            dueAt: debt.dueAt || '',
            advanceMinutes: debt.advanceMinutes === undefined || debt.advanceMinutes === null ? 4320 : debt.advanceMinutes,
            note: debt.note || '',
            status: debt.status || 'open'
          });
          setEditing(true);
        }

        if (editing) {
          return h(
            'li',
            { className: 'btl-item btl-item-editing' },
            h(Form, {
              title: debt.counterpart,
              fields: debtFields(),
              draft: draft,
              dirty: true,
              busy: props.busy,
              onChange: function (patch) {
                setDraft(Object.assign({}, draft, patch));
              },
              onSubmit: function () {
                props.onSave(Object.assign({ id: debt.id }, draft), function (ok) {
                  if (ok) setEditing(false);
                });
              },
              onCancel: function () {
                setEditing(false);
              },
              onDelete: function () {
                props.onDelete(debt.id);
              }
            })
          );
        }

        return h(
          'li',
          { className: 'btl-item btl-item-debt' + (settled ? ' btl-item-done' : '') },
          h(
            'span',
            { className: 'btl-item-mark', 'data-tone': outlier ? 'ok' : 'danger' },
            outlier ? t('debt.in') : t('debt.out')
          ),
          h(
            'span',
            { className: 'btl-item-main btl-item-clickable', onClick: begin, role: 'button', tabIndex: 0, onKeyDown: activateOnKey(begin) },
            h(
              'span',
              { className: 'btl-item-title' },
              debt.counterpart,
              settled ? h(Chip, { tone: 'muted' }, t('debts.settled')) : null
            ),
            h(
              'span',
              { className: 'btl-item-meta' },
              debt.dueAt ? h('span', null, fmtDate(debt.dueAt)) : h('span', null, t('time.none')),
              debt.dueAt && !settled ? h('span', { className: 'btl-sep' }, '·') : null,
              debt.dueAt && !settled ? h('span', null, fmtRelative(debt.dueAt)) : null,
              debt.note ? h('span', { className: 'btl-sep' }, '·') : null,
              debt.note ? h('span', { className: 'btl-item-note' }, debt.note) : null
            )
          ),
          h(
            'span',
            { className: 'btl-item-side' },
            h('span', { className: 'btl-amount' + (outlier ? ' btl-tone-ok' : ' btl-tone-danger') }, fmtMoney(debt.amount, debt.currency)),
            settled
              ? null
              : h(
                  'span',
                  { className: 'btl-only-wide' },
                  h(
                    Btn,
                    {
                      tone: 'ghost',
                      size: 'sm',
                      onClick: function () {
                        props.onSettle(debt);
                      }
                    },
                    t('debts.settle')
                  )
                ),
            /* 窄屏用图标按钮：.btl-only-wide 会被媒体查询藏掉，结清不能没有入口 */
            settled
              ? null
              : h(
                  'span',
                  { className: 'btl-only-narrow' },
                  h(IconBtn, {
                    icon: 'check',
                    title: t('debts.settle'),
                    onClick: function () {
                      props.onSettle(debt);
                    }
                  })
                ),
            h(IconBtn, { icon: 'edit', title: t('form.edit'), onClick: begin })
          )
        );
      }

      function DebtsTab(props) {
        var data = props.data;
        var api = props.api;
        var query = props.query;
        var showState = React.useState('open');
        var show = showState[0];
        var setShow = showState[1];
        var addingState = React.useState(false);
        var adding = addingState[0];
        var setAdding = addingState[1];
        var draftState = React.useState({});
        var draft = draftState[0];
        var setDraft = draftState[1];

        var all = (data.debts || []).filter(function (debt) {
          if (!query) return true;
          return [debt.counterpart, debt.note].join(' ').toLowerCase().indexOf(query) >= 0;
        });
        var visible = all.filter(function (debt) {
          if (show === 'all') return true;
          return debt.status !== 'settled';
        });
        var owed = visible.filter(function (debt) {
          return debt.direction === 'owedToMe';
        });
        var owe = visible.filter(function (debt) {
          return debt.direction === 'iOwe';
        });

        function startAdd(direction) {
          setDraft({
            counterpart: '',
            direction: direction || 'owedToMe',
            amount: '',
            currency: (data.config && data.config.currency) || 'CNY',
            status: 'open',
            dueAt: '',
            advanceMinutes: 4320,
            note: ''
          });
          setAdding(true);
        }

        function renderList(items, hint) {
          if (!items.length) return h('div', { className: 'btl-sublist-empty' }, hint);
          return h(
            'ul',
            { className: 'btl-list btl-list-grid' },
            items.map(function (debt) {
              return h(DebtRow, {
                key: debt.id,
                debt: debt,
                defaultCurrency: (data.config && data.config.currency) || 'CNY',
                busy: api.isBusy('mutate:debts'),
                onSave: function (record, done) {
                  api.mutate('debts', 'update', record, record.id).then(function (outcome) {
                    done(Boolean(outcome && outcome.ok));
                  });
                },
                onDelete: function (id) {
                  api.mutate('debts', 'delete', null, id);
                },
                onSettle: function (item) {
                  api.mutate('debts', 'update', { id: item.id, status: 'settled' }, item.id);
                }
              });
            })
          );
        }

        return h(
          'div',
          { className: 'btl-tab-body' },
          h(
            'div',
            { className: 'btl-toolbar' },
            h(Segmented, {
              value: show,
              onChange: setShow,
              items: [
                { value: 'open', label: t('debts.filter.open'), count: (data.debts || []).filter(function (debt) {
                  return debt.status !== 'settled';
                }).length },
                { value: 'all', label: t('debts.filter.all'), count: (data.debts || []).length }
              ]
            }),
            h('span', { className: 'btl-toolbar-gap' }),
            h(Btn, { tone: 'primary', icon: 'plus', size: 'sm', onClick: function () {
              startAdd('owedToMe');
            } }, t('debts.add'))
          ),
          adding
            ? h(
                'div',
                { className: 'btl-card btl-card-form' },
                h(Form, {
                  title: t('debts.add'),
                  fields: debtFields(),
                  draft: draft,
                  busy: api.isBusy('mutate:debts'),
                  onChange: function (patch) {
                    setDraft(Object.assign({}, draft, patch));
                  },
                  onSubmit: function () {
                    api.mutate('debts', 'create', draft).then(function (outcome) {
                      if (outcome && outcome.ok) setAdding(false);
                    });
                  },
                  onCancel: function () {
                    setAdding(false);
                  }
                })
              )
            : null,
          (data.debts || []).length || adding
            ? h(
                'div',
                null,
                h(
                  'section',
                  { className: 'btl-section' },
                  h(
                    'div',
                    { className: 'btl-section-head' },
                    h('h3', null, t('debts.owedToMe')),
                    h('span', { className: 'btl-count' }, t('misc.count', { n: owed.length }))
                  ),
                  renderList(owed, query ? t('app.searchEmpty') : h('span', null, t('debts.empty'), ' · ', h('button', { type: 'button', className: 'btl-link', onClick: function () {
                    startAdd('owedToMe');
                  } }, t('debts.add'))))
                ),
                h(
                  'section',
                  { className: 'btl-section' },
                  h(
                    'div',
                    { className: 'btl-section-head' },
                    h('h3', null, t('debts.iOwe')),
                    h('span', { className: 'btl-count' }, t('misc.count', { n: owe.length }))
                  ),
                  renderList(owe, h('span', null, t('debts.emptyHint'), ' · ', h('button', { type: 'button', className: 'btl-link', onClick: function () {
                    startAdd('iOwe');
                  } }, t('debts.add'))))
                )
              )
            : h(Empty, {
                icon: 'wallet',
                title: query ? t('app.searchEmpty') : t('debts.empty'),
                hint: query ? null : t('debts.emptyHint'),
                action: query
                  ? null
                  : h(Btn, { tone: 'primary', icon: 'plus', onClick: function () {
                      startAdd('owedToMe');
                    } }, t('debts.add'))
              })
        );
      }

      /* ------------------------------------------------------------------ *
       * 提醒
       * ------------------------------------------------------------------ */

      function AlertsTab(props) {
        var data = props.data;
        var api = props.api;
        var query = props.query;
        var alerts = (data.alerts || []).filter(function (alert) {
          if (query) {
            return [alert.title, alert.message].join(' ').toLowerCase().indexOf(query) >= 0;
          }
          return true;
        });
        var order = { critical: 0, warn: 1, info: 2 };
        var sorted = alerts.slice().sort(function (a, b) {
          var left = order[a.level] === undefined ? 3 : order[a.level];
          var right = order[b.level] === undefined ? 3 : order[b.level];
          if (left !== right) return left - right;
          return String(b.at).localeCompare(String(a.at));
        });

        function renderRow(alert) {
          var tone = toneOfLevel(alert.level);
          return h(
            'li',
            { className: 'btl-item btl-item-alert', key: alert.id },
            h('span', { className: 'btl-alert-dot btl-alert-dot-' + (tone || 'info') }),
            h(
              'span',
              { className: 'btl-item-main' },
              h(
                'span',
                { className: 'btl-item-title' },
                alert.title,
                h(Chip, { tone: tone || 'muted' }, t('alerts.level.' + (alert.level || 'info')))
              ),
              h(
                'span',
                { className: 'btl-item-meta' },
                alert.message,
                h('span', { className: 'btl-sep' }, '·'),
                h('span', null, fmtAgo(alert.at))
              )
            ),
            h(
              'span',
              { className: 'btl-item-side' },
              h(
                'span',
                { className: 'btl-only-wide' },
                h(
                  Btn,
                  {
                    tone: 'ghost',
                    size: 'sm',
                    onClick: function () {
                      api
                        .send('/alerts/ack', { id: alert.id }, { key: 'ack:' + alert.id, success: t('toast.acked') })
                        .catch(function () {});
                    }
                  },
                  t('alerts.ack')
                )
              ),
              /* 窄屏：文字按钮被藏掉时改用图标按钮，单条提醒仍可确认 */
              h(
                'span',
                { className: 'btl-only-narrow' },
                h(IconBtn, {
                  icon: 'check',
                  title: t('alerts.ack'),
                  onClick: function () {
                    api
                      .send('/alerts/ack', { id: alert.id }, { key: 'ack:' + alert.id, success: t('toast.acked') })
                      .catch(function () {});
                  }
                })
              )
            )
          );
        }

        return h(
          'div',
          { className: 'btl-tab-body' },
          h(
            'div',
            { className: 'btl-toolbar' },
            h('span', { className: 'btl-toolbar-title' }, t('alerts.title')),
            h('span', { className: 'btl-toolbar-gap' }),
            h(
              Btn,
              {
                tone: 'ghost',
                size: 'sm',
                icon: 'check',
                disabled: !sorted.length,
                onClick: function () {
                  api.send('/alerts/ack', { all: true }, { key: 'ack:all', success: t('toast.acked') }).catch(function () {});
                }
              },
              t('alerts.ackAll')
            )
          ),
          sorted.length
            ? h('ul', { className: 'btl-list' }, sorted.map(renderRow))
            : h(Empty, {
                icon: 'bell',
                title: query ? t('app.searchEmpty') : t('alerts.empty'),
                hint: query ? null : t('alerts.emptyHint')
              })
        );
      }

/* ------------------------------------------------------------------ *
       * 样式（全部走宿主主题变量，浅色/深色自动适配）
       * ------------------------------------------------------------------ */

      var STYLES = [
        '.btl-root{--btl-radius:12px;height:100%;overflow-y:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}',
        '.btl-root *{box-sizing:border-box}',
        '.btl-root :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}',
        '.btl-root button{font-family:inherit}',
        '.btl-inner{max-width:1080px;margin:0 auto;padding:0 22px 72px}',
        '.btl-ico{flex:none;display:block}',

        '.btl-topbar{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:10px;padding:16px 0 12px;background:color-mix(in srgb, var(--dsw-alias-bg-base) 86%, transparent);backdrop-filter:blur(10px)}',
        '.btl-brand{display:flex;flex-direction:column;gap:1px;min-width:0}',
        '.btl-brand h1{margin:0;font-size:15px;font-weight:650;letter-spacing:.2px;display:flex;align-items:center;gap:7px}',
        '.btl-brand p{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.btl-brand-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent)}',
        '.btl-topbar-gap{flex:1}',
        '.btl-stale{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:7px;font-size:11.5px;white-space:nowrap;color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent)}',

        '.btl-search{position:relative;display:flex;align-items:center;width:230px;flex:none}',
        '.btl-search .btl-ico{position:absolute;left:9px;color:var(--dsw-alias-label-secondary);pointer-events:none}',
        '.btl-search input{width:100%;height:32px;padding:0 26px 0 30px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;font-family:inherit;outline:none;transition:border-color .14s, box-shadow .14s}',
        '.btl-search input::placeholder{color:var(--dsw-alias-label-secondary)}',
        '.btl-search input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)}',
        '.btl-search-clear{position:absolute;right:5px;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:3px;display:grid;place-items:center;border-radius:5px}',
        '.btl-search-clear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',

        '.btl-hero{display:grid;grid-template-columns:repeat(auto-fit, minmax(190px, 1fr));gap:10px;margin:10px 0 2px}',
        '.btl-stat{appearance:none;text-align:left;display:flex;flex-direction:column;gap:3px;min-width:0;padding:12px 14px;border-radius:var(--btl-radius);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer;transition:transform .16s, border-color .16s, background .16s}',
        '.btl-stat:hover{transform:translateY(-1px);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
        '.btl-stat-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:11.5px}',
        '.btl-stat-value{font-size:23px;font-weight:640;letter-spacing:-.2px;font-variant-numeric:tabular-nums;line-height:1.25;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}',
        '.btl-stat-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
        '.btl-stat-danger{box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary)}',
        '.btl-stat-warn{box-shadow:inset 3px 0 0 var(--dsw-alias-state-warn-primary)}',
        '.btl-stat-ok{box-shadow:inset 3px 0 0 var(--dsw-alias-state-success-primary)}',

        '.btl-tabs{display:flex;gap:2px;margin:16px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto;scrollbar-width:none}',
        '.btl-tabs::-webkit-scrollbar{display:none}',
        '.btl-tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;font-family:inherit;padding:9px 11px;margin-bottom:-1px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:color .14s, border-color .14s}',
        '.btl-tab:hover{color:var(--dsw-alias-label-primary)}',
        '.btl-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}',
        '.btl-tab-count{min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;display:inline-flex;align-items:center;justify-content:center}',
        '.btl-tab-active .btl-tab-count{background:var(--dsw-alias-brand-primary);color:#fff}',

        '.btl-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}',
        '.btl-toolbar-gap{flex:1}',
        '.btl-toolbar .btl-select-inline{width:auto;min-width:112px;height:30px;flex:none;font-size:12.5px;padding:0 24px 0 9px}',
        '.btl-toolbar .btl-btn-sm{height:30px}',
        '.btl-toolbar-title{font-size:13px;font-weight:600}',

        '.btl-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
        '.btl-seg-item{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;padding:5px 10px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:.14s}',
        '.btl-seg-item:hover{color:var(--dsw-alias-label-primary)}',
        '.btl-seg-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}',
        '.btl-seg-count{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',

        '.btl-section{margin:20px 0 6px}',
        '.btl-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px}',
        '.btl-section-head h3{margin:0;font-size:12.5px;font-weight:600;letter-spacing:.3px;color:var(--dsw-alias-label-secondary)}',
        '.btl-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',

        '.btl-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
        // 记录型列表（资产、借贷）在宽屏下两列排，一篇空白比一行一条省一半纵向空间
        '.btl-list-grid{display:grid;grid-template-columns:1fr;gap:6px;align-items:stretch}',
        '.btl-list-grid > li{min-width:0}',
        // 正在就地编辑的那一条横跨整行，表单不会被挤成半屏，也不会把同排邻居撑高
        '.btl-list-grid > li.btl-item-editing{grid-column:1/-1}',
        '@media (min-width:1040px){.btl-list-grid{grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}}',
        '.btl-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);transition:border-color .14s, background .14s}',
        '.btl-item-click,.btl-item-clickable{cursor:pointer}',
        '.btl-item-hover:hover,.btl-item-todo:hover,.btl-item-debt:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
        '.btl-item-editing{display:block;padding:14px;background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
        '.btl-item-done .btl-item-title{text-decoration:line-through;color:var(--dsw-alias-label-secondary)}',
        '.btl-item-done{opacity:.72}',
        '.btl-item-mark{width:28px;height:28px;flex:none;display:grid;place-items:center;border-radius:8px;font-size:11.5px;font-weight:650;text-transform:uppercase;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
        '.btl-item-thumb{width:38px;height:38px;flex:none;display:grid;place-items:center;border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
        '.btl-item-thumb img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}',
        /* 照片条 */
        '.btl-form-photos{margin-bottom:2px}',
        '.btl-photoblock{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 12px}',
        '.btl-photo{position:relative;width:78px;height:78px;flex:none;border-radius:9px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);display:grid;place-items:center;font-size:11px;color:var(--dsw-alias-label-secondary)}',
        '.btl-photo img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}',
        '.btl-photo-x{position:absolute;top:3px;right:3px;width:18px;height:18px;padding:0;border:none;border-radius:50%;background:rgba(8,10,14,.62);color:#fff;font-size:12px;line-height:1;cursor:pointer;display:grid;place-items:center}',
        '.btl-photo-x:hover{background:var(--dsw-alias-state-error-primary)}',
        '.btl-photo-loading{opacity:.7}',
        '.btl-photo-add{width:78px;height:78px;flex:none;border-radius:9px;border:1px dashed var(--dsw-alias-border-l2);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
        '.btl-photo-add:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
        /* 大图查看 */
        '.btl-lightbox{position:fixed;inset:0;z-index:80;background:rgba(6,8,12,.82);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:28px;cursor:zoom-out}',
        '.btl-lightbox img{max-width:92vw;max-height:82vh;border-radius:10px;background:#fff;box-shadow:0 24px 64px rgba(0,0,0,.5)}',
        '.btl-lightbox-cap{font-size:12.5px;color:rgba(255,255,255,.78)}',
        '.btl-item-mark[data-tone="danger"]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)}',
        '.btl-item-mark[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent)}',
        '.btl-item-mark[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)}',
        '.btl-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
        '.btl-item-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;overflow-wrap:anywhere;font-size:13.5px;font-weight:500;color:var(--dsw-alias-label-primary)}',
        // 卡片标题：最多两行，超出用省略号，卡片高度因此可预测
        '.btl-item-title-clamp{align-items:flex-start;flex-wrap:nowrap}',
        '.btl-item-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;min-width:0;flex:1}',
        '.btl-item-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.btl-item-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px}',
        '.btl-item-amount{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:500}',
        '.btl-item-side{display:flex;align-items:center;gap:6px;flex:none}',
        '.btl-sep{opacity:.5}',
        '.btl-amount{font-size:14px;font-weight:640;font-variant-numeric:tabular-nums}',

        '.btl-chip{display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid transparent}',
        '.btl-chip-muted{background:transparent;border-color:var(--dsw-alias-border-l1)}',
        '.btl-chip-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)}',
        '.btl-chip-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 15%, transparent)}',
        '.btl-chip-danger{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)}',
        '.btl-badge{margin-left:2px;font-size:11px;padding:0 6px;height:17px;display:inline-flex;align-items:center;border-radius:5px}',
        '.btl-badge-danger{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent)}',

        '.btl-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;transition:border-color .14s, background .14s, opacity .14s, transform .1s}',
        '.btl-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
        '.btl-btn:active:not(:disabled){transform:translateY(1px)}',
        '.btl-btn:disabled{opacity:.5;cursor:default}',
        '.btl-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
        '.btl-btn-primary:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-brand-primary) 88%, #000);border-color:transparent;color:#fff}',
        '.btl-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}',
        '.btl-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:transparent}',
        '.btl-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);background:transparent}',
        '.btl-btn-danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);border-color:var(--dsw-alias-state-error-primary)}',
        '.btl-btn-sm{height:28px;padding:0 10px;font-size:12.5px}',
        '.btl-btn-block{width:100%}',
        '.btl-btn-label{display:inline-block}',
        '.btl-iconbtn{appearance:none;width:28px;height:28px;flex:none;display:grid;place-items:center;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:.14s}',
        '.btl-iconbtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
        '.btl-iconbtn:disabled{opacity:.45;cursor:default}',
        '.btl-iconbtn-danger{color:var(--dsw-alias-state-error-primary)}',
        '.btl-iconbtn-danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}',

        '.btl-input{width:100%;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;outline:none;transition:border-color .14s, box-shadow .14s}',
        '.btl-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.85}',
        '.btl-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent)}',
        '.btl-input-invalid{border-color:var(--dsw-alias-state-error-primary)}',
        '.btl-textarea{height:auto;min-height:58px;padding:7px 10px;line-height:1.5;resize:vertical}',
        '.btl-select{appearance:none;padding-right:26px;background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' fill=\'none\' stroke=\'%23888\' stroke-width=\'1.5\' stroke-linecap=\'round\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center}',

        '.btl-form-wrap{display:flex;flex-direction:column;gap:10px}',
        '.btl-form-head{display:flex;align-items:center;justify-content:space-between;gap:10px}',
        '.btl-form-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.btl-form-dirty{font-size:11.5px;color:var(--dsw-alias-state-warn-primary)}',
        '.btl-form{display:grid;grid-template-columns:repeat(auto-fit, minmax(170px, 1fr));gap:10px 12px}',
        '.btl-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
        '.btl-field-wide{grid-column:1 / -1}',
        '.btl-field-label{display:flex;align-items:baseline;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
        '.btl-req{font-style:normal;color:var(--dsw-alias-state-error-primary)}',
        '.btl-field-hint{font-size:11px;opacity:.8}',
        '.btl-form-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}',
        '.btl-form-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
        '.btl-switch-row{display:flex;align-items:center;height:32px}',
        '.btl-link{appearance:none;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-size:12.5px;font-family:inherit;cursor:pointer;padding:0;align-self:flex-start}',
        '.btl-link:hover{text-decoration:underline}',
        '.btl-card{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--btl-radius);background:var(--dsw-alias-bg-layer-1);padding:14px}',
        '.btl-card-form{margin-bottom:10px;background:var(--dsw-alias-bg-layer-2)}',

        '.btl-check{appearance:none;width:18px;height:18px;flex:none;display:grid;place-items:center;border-radius:6px;border:1.5px solid var(--dsw-alias-border-l2);background:transparent;color:#fff;cursor:pointer;transition:.14s}',
        '.btl-check:hover{border-color:var(--dsw-alias-brand-primary)}',
        '.btl-check-on{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',

        '.btl-plan-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill, minmax(296px, 372px));justify-content:start;gap:10px}',
        // 额度卡片按固定宽度排，只有一条时不会被拉成一整行
        '.btl-empty-narrow{max-width:460px;margin-inline:auto}',
        '.btl-plan{display:flex;flex-direction:column;gap:10px;padding:13px;border-radius:var(--btl-radius);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
        '.btl-plan-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}',
        '.btl-plan-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
        '.btl-plan-name{min-width:0;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.btl-plan-actions{display:flex;align-items:center;gap:1px;flex:none}',
        '.btl-plan-windows{display:flex;flex-direction:column;gap:10px}',
        '.btl-window-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px;margin-bottom:4px}',
        '.btl-window-label{color:var(--dsw-alias-label-secondary)}',
        '.btl-window-value{font-variant-numeric:tabular-nums;font-weight:500}',
        '.btl-window-foot{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px;flex-wrap:wrap}',
        '.btl-window-balance{padding:8px 10px;border-radius:calc(var(--btl-radius) - 2px);background:var(--dsw-alias-bg-layer-2)}',
        '.btl-window-balance .btl-window-head{margin-bottom:0;font-size:12.5px}',
        '.btl-balance-value{font-size:15px;font-weight:620}',
        '.btl-bar{height:5px;border-radius:999px;overflow:hidden;background:color-mix(in srgb, var(--dsw-alias-label-secondary) 20%, transparent)}',
        '.btl-bar-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}',
        '.btl-bar-ok .btl-bar-fill{background:var(--dsw-alias-state-success-primary)}',
        '.btl-bar-warn .btl-bar-fill{background:var(--dsw-alias-state-warn-primary)}',
        '.btl-bar-danger .btl-bar-fill{background:var(--dsw-alias-state-error-primary)}',
        '.btl-tone-ok{color:var(--dsw-alias-state-success-primary)}',
        '.btl-tone-warn{color:var(--dsw-alias-state-warn-primary)}',
        '.btl-tone-danger{color:var(--dsw-alias-state-error-primary)}',
        '.btl-plan-empty{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55;padding:2px 0}',
        '.btl-plan-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}',
        '.btl-cred{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}',
        '.btl-cred-hint{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
        '.btl-plan-source{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85}',

        '.btl-source{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.btl-source:last-child{border-bottom:0}',
        '.btl-source-main{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}',
        '.btl-source-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
        '.btl-source-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.btl-source-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.btl-source-code{margin:4px 0 0;padding:9px 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:1.55;max-height:220px;overflow:auto;white-space:pre;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.btl-source-actions{display:flex;align-items:center;gap:6px;flex:none}',

        '.btl-switch{appearance:none;position:relative;width:34px;height:19px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:.16s}',
        '.btl-switch-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
        '.btl-switch-knob{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .16s}',
        '.btl-switch-on .btl-switch-knob{left:17px}',

        '.btl-alert-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-label-secondary)}',
        '.btl-alert-dot-danger{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)}',
        '.btl-alert-dot-warn{background:var(--dsw-alias-state-warn-primary)}',
        '.btl-alert-dot-ok{background:var(--dsw-alias-state-success-primary)}',

        '.btl-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:30px 18px;border:1px dashed var(--dsw-alias-border-l1);border-radius:var(--btl-radius);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent)}',
        '.btl-empty-icon{width:36px;height:36px;display:grid;place-items:center;border-radius:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);margin-bottom:2px}',
        '.btl-empty-title{font-size:13px;font-weight:500}',
        '.btl-empty-hint{font-size:12px;color:var(--dsw-alias-label-secondary);max-width:430px;line-height:1.6;text-wrap:pretty}',
        '.btl-empty .btl-btn{margin-top:8px}',
        '.btl-sublist-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:12px 2px}',

        '.btl-skeleton-wrap{display:flex;flex-direction:column;gap:6px;padding:8px 0}',
        '.btl-skeleton{height:46px;border-radius:10px;background:linear-gradient(90deg, var(--dsw-alias-bg-layer-1) 25%, var(--dsw-alias-bg-layer-2) 37%, var(--dsw-alias-bg-layer-1) 63%);background-size:400% 100%;animation:btl-shimmer 1.4s ease infinite}',
        '@keyframes btl-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}',

        '.btl-toast{position:fixed;right:20px;bottom:20px;z-index:40;max-width:320px;padding:9px 13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.18);animation:btl-rise .18s ease}',
        '.btl-toast-ok{border-left:3px solid var(--dsw-alias-state-success-primary)}',
        '.btl-toast-error{border-left:3px solid var(--dsw-alias-state-error-primary)}',
        '@keyframes btl-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',

        '.btl-errorbox{display:flex;flex-direction:column;gap:10px;align-items:flex-start;padding:16px;border-radius:var(--btl-radius);border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)}',
        '.btl-errorbox h4{margin:0;font-size:13px}',
        '.btl-errorbox p{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}',

        '.btl-settings{display:flex;flex-direction:column;gap:0;max-width:620px}',
        '.btl-settings-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.btl-settings-row:last-child{border-bottom:0}',
        '.btl-settings-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.btl-settings-text strong{font-size:13px;font-weight:500}',
        '.btl-settings-text span{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
        '.btl-settings-ctl{flex:none;min-width:130px;display:flex;justify-content:flex-end}',
        '.btl-settings-ctl .btl-input{width:auto;min-width:130px}',
        '.btl-settings-ctl-inline{align-items:center;gap:6px}',
        '.btl-settings-ctl-col{flex-direction:column;align-items:flex-end;gap:4px}',
        '.btl-settings-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;align-self:flex-start;text-align:left}',
        '.btl-details{margin-top:14px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}',
        '.btl-details summary{font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;list-style:none}',
        '.btl-details summary::-webkit-details-marker{display:none}',
        '.btl-details summary:hover{color:var(--dsw-alias-label-primary)}',
        '.btl-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin-top:10px;font-size:11.5px}',
        '.btl-kv dt{color:var(--dsw-alias-label-secondary);white-space:nowrap}',
        '.btl-kv dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}',

        '.btl-panel{height:100%;overflow-y:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',

        /* 宽/窄屏互斥显示：关键动作在窄屏不靠「整类隐藏」消失 */
        '.btl-only-narrow{display:none}',

        '@media (max-width:760px){',
        '.btl-inner{padding:0 12px 56px}',
        '.btl-brand p{display:none}',
        '.btl-search{width:150px}',
        '.btl-stat-value{font-size:20px}',
        '.btl-item{padding:9px 10px;gap:9px}',
        '.btl-item-mark{width:24px;height:24px;border-radius:7px;font-size:11px}',
        '.btl-item-side{gap:4px}',
        '.btl-only-wide{display:none}',
        '.btl-only-narrow{display:inline-flex}',
        '.btl-hero{grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:8px}',
        '.btl-plan-list{grid-template-columns:1fr}',
        '}'
      ].join('\n');

      function installStyles() {
        if (typeof document === 'undefined') return function () {};
        var node = document.getElementById('btl-styles');
        if (!node) {
          node = document.createElement('style');
          node.id = 'btl-styles';
          document.head.appendChild(node);
        }
        /* 每次都重写：插件升级/热更新后不会残留旧规则 */
        node.textContent = STYLES;
        return function () {
          var target = document.getElementById('btl-styles');
          if (target) target.remove();
        };
      }

/* ------------------------------------------------------------------ *
       * 主面板
       * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
       * 收纳（家里的东西放在哪）
       * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
       * 收纳（家里的东西放在哪）
       * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
       * 收纳（家里的东西放在哪）
       * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
       * 收纳（家里的东西放在哪）
       * ------------------------------------------------------------------ */

/* ===== items block: generated from _build/client-items.js ===== */
/* ------------------------------------------------------------------ *
       * 收纳（家里的东西放在哪）
       * ------------------------------------------------------------------ */

      function itemFields() {
        return [
          { key: 'name', label: t('items.name'), required: true, placeholder: t('items.namePh'), autoFocus: true },
          { key: 'location', label: t('items.location'), required: true, placeholder: t('items.locationPh') },
          { key: 'detail', label: t('items.detail'), placeholder: t('items.detailPh') },
          { key: 'quantity', label: t('items.quantity'), type: 'number', placeholder: '1' },
          { key: 'unit', label: t('items.unit'), placeholder: t('items.unitPh') },
          { key: 'placedAt', label: t('items.placedAt'), placeholder: t('items.placedAtPh') },
          { key: 'note', label: t('items.note'), type: 'textarea', placeholder: t('items.notePh'), advanced: true },
          { key: 'tags', label: t('items.tags'), placeholder: t('items.tagsPh'), advanced: true }
        ];
      }

      function photoUrl(photo) {
        return photo && photo.url ? photo.url : '';
      }

      /** ISO（UTC）→ 输入框用的本地时间字符串；解析不了就原样给。 */
      function localInput(value) {
        var date = toDate(value);
        if (!date) return '';
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
          + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
      }

      /** 照片选择条：可看大图、可删、可加。 */
      function PhotoPicker(props) {
        var photos = props.photos || [];
        return h(
          'div',
          { className: 'btl-photoblock' },
          photos.map(function (photo) {
            return h(
              'span',
              { className: 'btl-photo', key: photo.id },
              h('img', {
                src: photoUrl(photo),
                alt: '',
                loading: 'lazy',
                onClick: function (event) {
                  event.stopPropagation();
                  if (props.onOpen) props.onOpen(photo);
                }
              }),
              props.onRemove
                ? h('button', {
                    type: 'button',
                    className: 'btl-photo-x',
                    title: t('items.removePhoto'),
                    onClick: function (event) {
                      event.stopPropagation();
                      props.onRemove(photo);
                    }
                  }, '×')
                : null
            );
          }),
          props.uploading
            ? h('span', { className: 'btl-photo btl-photo-loading' }, t('items.uploading'))
            : h(
                'label',
                { className: 'btl-photo-add', title: t('items.addPhoto') },
                h(Ico, { name: 'plus', size: 15 }),
                h('span', null, t('items.addPhoto')),
                h('input', {
                  type: 'file',
                  accept: 'image/png,image/jpeg,image/gif,image/webp',
                  multiple: true,
                  style: { display: 'none' },
                  onChange: function (event) {
                    var files = event.target.files;
                    if (props.onPick) props.onPick(files);
                    event.target.value = '';
                  }
                })
              )
        );
      }

            function ItemRow(props) {
              var item = props.item;
              var editingState = React.useState(false);
              var editing = editingState[0];
              var setEditing = editingState[1];
              var draftState = React.useState(null);
              var draft = draftState[0];
              var setDraft = draftState[1];
              // 编辑期间的图片列表：本地改动 + 保存时才落库，取消就回滚（半路删掉的图不会伤人）
              var photoState = React.useState(null);
              var localPhotos = photoState[0];
              var setLocalPhotos = photoState[1];

              function initialPhotos() {
                return item.photos || [];
              }

              function currentPhotos() {
                return localPhotos === null ? initialPhotos() : localPhotos;
              }

              function begin() {
                setDraft({
                  name: item.name,
                  location: item.location,
                  detail: item.detail || '',
                  quantity: item.quantity === null || item.quantity === undefined ? '' : String(item.quantity),
                  unit: item.unit || '',
                  // 输入框里显示本地时间：直接 slice ISO 会显示 UTC，保存时又被当成本地时间解析（每次 -8h）
                  placedAt: item.placedAt ? localInput(item.placedAt) : '',
                  note: item.note || '',
                  tags: (item.tags || []).join(' ')
                });
                setLocalPhotos(null);
                setEditing(true);
              }

              function closeEdit() {
                setEditing(false);
                setLocalPhotos(null);
              }

              if (editing) {
                var current = draft || {};
                var photos = currentPhotos();
                var keep = photos.map(function (photo) {
                  return photo.id;
                });
                var originals = initialPhotos().map(function (photo) {
                  return photo.id;
                });
                var removedOnSave = initialPhotos().filter(function (photo) {
                  return keep.indexOf(photo.id) < 0;
                });
                var addedUnused = photos.filter(function (photo) {
                  return originals.indexOf(photo.id) < 0;
                });
                var form = h(Form, {
                  title: item.name,
                  fields: itemFields(),
                  draft: current,
                  dirty: true,
                  busy: props.busy,
                  photoBlock: h(PhotoPicker, {
                    photos: photos,
                    uploading: props.uploading,
                    onOpen: props.onOpenPhoto,
                    onPick: function (files) {
                      props.onPickPhotos(files, function (uploaded) {
                        setLocalPhotos(currentPhotos().concat(uploaded));
                      });
                    },
                    onRemove: function (photo) {
                      setLocalPhotos(
                        currentPhotos().filter(function (one) {
                          return one.id !== photo.id;
                        })
                      );
                    }
                  }),
                  onChange: function (patch) {
                    setDraft(Object.assign({}, current, patch));
                  },
                  onSubmit: function () {
                    props.onSave(Object.assign({ id: item.id }, current, { photoIds: keep }), function (ok) {
                      if (!ok) return;
                      // 保存成功后再删被摘掉的图片文件；删不掉也不影响记录（后端会拒绝删还挂着的图）
                      removedOnSave.forEach(props.onDropPhoto);
                      closeEdit();
                    });
                  },
                  onCancel: function () {
                    // 取消：把这次新传但没保存的图片删掉，被删的原图不动
                    addedUnused.forEach(props.onDropPhoto);
                    closeEdit();
                  },
                  onDelete: function () {
                    props.onDelete(item.id);
                  }
                });
                return h('li', { className: 'btl-item btl-item-editing' }, form);
              }

              var meta = [
                item.placeLabel || t('items.noPlace'),
                item.quantityLabel || '',
                item.placedAtLabel ? t('items.placedAtShort', { at: item.placedAtLabel }) : '',
                item.photoCount ? t('items.photoCount', { n: item.photoCount }) : ''
              ].filter(Boolean);
              var first = initialPhotos()[0];

              return h(
                'li',
                { className: 'btl-item btl-item-hover' },
                h(
                  'span',
                  { className: 'btl-item-thumb' },
                  first
                    ? h('img', {
                        src: photoUrl(first),
                        alt: item.name,
                        loading: 'lazy',
                        onClick: function (event) {
                          event.stopPropagation();
                          props.onOpenPhoto(first);
                        },
                        onError: function (event) {
                          // 文件被手工删掉时不要显示一个破图标
                          event.currentTarget.style.visibility = 'hidden';
                        }
                      })
                    : h(Ico, { name: 'box', size: 16 })
                ),
                h(
                  'span',
                  {
                    className: 'btl-item-main btl-item-clickable',
                    onClick: begin,
                    role: 'button',
                    tabIndex: 0,
                    onKeyDown: activateOnKey(begin)
                  },
                  h('span', { className: 'btl-item-title btl-item-title-clamp' }, h('span', { className: 'btl-item-name' }, item.name)),
                  h('span', { className: 'btl-item-meta' }, meta.join(t('misc.sep')))
                ),
                h(
                  'span',
                  { className: 'btl-item-side' },
                  h(IconBtn, { icon: 'edit', title: t('misc.edit'), onClick: begin })
                )
              );
            }

function ItemsTab(props) {
        var data = props.data;
        var api = props.api;
        var query = props.query;
        var addingState = React.useState(false);
        var adding = addingState[0];
        var setAdding = addingState[1];
        var draftState = React.useState({});
        var draft = draftState[0];
        var setDraft = draftState[1];
        var uploadState = React.useState(false);
        var uploading = uploadState[0];
        var setUploading = uploadState[1];
        var lightState = React.useState(null);
        var light = lightState[0];
        var setLight = lightState[1];

        var items = (data.items || []).filter(function (item) {
          if (!query) return true;
          return [item.name, item.location, item.detail, item.note, (item.tags || []).join(' ')]
            .join(' ')
            .toLowerCase()
            .indexOf(query) >= 0;
        });

        function readAsDataUrl(blob) {
          return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () {
              resolve(String(reader.result || ''));
            };
            reader.onerror = function () {
              reject(new Error(t('items.readFail')));
            };
            reader.readAsDataURL(blob);
          });
        }

        /* 手机原图动辄四五 MB：先缩到长边 1600 再传，省空间也省上传时间。
           解码不了（HEIC 等）就原样上传，交给后端按字节嗅探兜底。 */
        function shrinkImage(file) {
          return new Promise(function (resolve) {
            if (typeof document === 'undefined' || !document.createElement || typeof Image === 'undefined') {
              resolve(file);
              return;
            }
            readAsDataUrl(file)
              .then(function (dataUrl) {
                var image = new Image();
                image.onload = function () {
                  try {
                    var maxSide = 1600;
                    var scale = Math.min(1, maxSide / Math.max(image.width || 1, image.height || 1));
                    if (scale >= 1 && file.size <= 1.2 * 1024 * 1024) {
                      resolve(file);
                      return;
                    }
                    var canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round((image.width || 1) * scale));
                    canvas.height = Math.max(1, Math.round((image.height || 1) * scale));
                    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', 0.85));
                  } catch (error) {
                    resolve(file);
                  }
                };
                image.onerror = function () {
                  resolve(file);
                };
                image.src = dataUrl;
              })
              .catch(function () {
                resolve(file);
              });
          });
        }

        /* 面板上传：缩图 → dataURL 交给 Host 落盘，拿回 {id,url} 再挂到记录上 */
        function uploadFiles(files) {
          var list = Array.prototype.slice.call(files || []).filter(Boolean).slice(0, 6);
          if (!list.length) return Promise.resolve([]);
          setUploading(true);
          var uploaded = [];
          var chain = Promise.resolve();
          list.forEach(function (file) {
            chain = chain.then(function () {
              return shrinkImage(file)
                .then(function (prepared) {
                  return typeof prepared === 'string' ? prepared : readAsDataUrl(prepared);
                })
                .then(function (dataUrl) {
                  return api.send('/photos', { dataUrl: dataUrl }, { key: 'photos', success: t('items.uploaded') });
                })
                .then(function (payload) {
                  var photo = payload && payload.photo;
                  if (photo && photo.id) uploaded.push(photo);
                });
            });
          });
          return chain
            .catch(function () {
              return null; // api.send 已经弹过错误
            })
            .then(function () {
              setUploading(false);
              return uploaded;
            });
        }

        /* 删照片时连文件一起删，别在数据目录里留孤儿；已经被别的物件引用时后端会拒绝，忽略即可。 */
        function dropPhoto(photo) {
          if (!photo || !photo.id) return Promise.resolve();
          return api.send('/photos/delete', { id: photo.id }, { key: 'photos' }).catch(function () {
            return null;
          });
        }

        function saveItem(record, done) {
          var payload = Object.assign({}, record);
          delete payload._photos;
          if (typeof payload.quantity === 'string') {
            payload.quantity = payload.quantity.trim() === '' ? null : Number(payload.quantity);
          }
          var op = payload.id ? 'update' : 'create';
          api.mutate('items', op, payload, payload.id).then(function (outcome) {
            if (done) done(Boolean(outcome && outcome.ok));
          });
        }


        var addDraft = Object.assign({}, draft);

        /* 新增表单里的照片还没挂到任何记录上，取消时要把这些文件删掉，否则会留在数据目录里。 */
        function clearAddPhotos() {
          var photos = addDraft._photos || [];
          photos.forEach(dropPhoto);
          setDraft({});
        }

        var addForm = adding
          ? h(Form, {
              title: t('items.addTitle'),
              fields: itemFields(),
              draft: addDraft,
              busy: api.isBusy('mutate:items'),
              photoBlock: h(PhotoPicker, {
                photos: addDraft._photos || [],
                uploading: uploading,
                onOpen: setLight,
                onPick: function (files) {
                  uploadFiles(files).then(function (uploaded) {
                    if (!uploaded || !uploaded.length) return;
                    var next = (addDraft._photos || []).concat(uploaded);
                    setDraft(
                      Object.assign({}, addDraft, {
                        _photos: next,
                        photoIds: next.map(function (photo) {
                          return photo.id;
                        })
                      })
                    );
                  });
                },
                onRemove: function (photo) {
                  var next = (addDraft._photos || []).filter(function (one) {
                    return one.id !== photo.id;
                  });
                  setDraft(
                    Object.assign({}, addDraft, {
                      _photos: next,
                      photoIds: next.map(function (one) {
                        return one.id;
                      })
                    })
                  );
                  dropPhoto(photo);
                }
              }),
              onChange: function (patch) {
                setDraft(Object.assign({}, addDraft, patch));
              },
              onSubmit: function () {
                saveItem(addDraft, function (ok) {
                  if (ok) {
                    setAdding(false);
                    setDraft({});
                  }
                });
              },
              onCancel: function () {
                setAdding(false);
                clearAddPhotos();
              }
            })
          : null;

        return h(
          'div',
          { className: 'btl-stack' },
          h(
            'div',
            { className: 'btl-toolbar' },
            h('span', { className: 'btl-toolbar-label' }, t('items.section')),
            h('span', { className: 'btl-toolbar-gap' }),
            h(Btn, {
              tone: 'primary',
              icon: 'plus',
              size: 'sm',
              onClick: function () {
                setDraft({});
                setAdding(true);
              }
            }, t('items.add'))
          ),
          addForm,
          items.length
            ? h(
                'ul',
                { className: 'btl-list btl-list-grid' },
                items.map(function (item) {
                  return h(ItemRow, {
                    key: item.id,
                    item: item,
                    busy: api.isBusy('mutate:items'),
                    uploading: uploading,
                    onOpenPhoto: setLight,
                    onPickPhotos: function (files, apply) {
                      uploadFiles(files).then(function (uploaded) {
                        if (uploaded && uploaded.length && typeof apply === 'function') {
                          // 行内编辑用的是「照片对象数组」：这里必须原样传对象，不能只传 id（会丢 url/mime）
                          apply(uploaded);
                        }
                      });
                    },
                    onSave: saveItem,
                    onDropPhoto: dropPhoto,
                    onDelete: function (id) {
                      api.mutate('items', 'delete', null, id);
                    }
                  });
                })
              )
            : adding
              ? null
              : h(
                  'div',
                  { className: 'btl-empty-narrow' },
                  h(Empty, {
                    icon: 'box',
                    title: query ? t('app.searchEmpty') : t('items.empty'),
                    hint: query ? t('items.emptyHint') : t('items.emptyHint'),
                    action: query ? null : h(Btn, {
                      tone: 'ghost',
                      icon: 'plus',
                      onClick: function () {
                        setDraft({});
                        setAdding(true);
                      }
                    }, t('items.add'))
                  })
                ),
          light
            ? h(
                'div',
                {
                  className: 'btl-lightbox',
                  role: 'dialog',
                  'aria-modal': 'true',
                  onClick: function () {
                    setLight(null);
                  }
                },
                h('img', { src: photoUrl(light), alt: t('items.viewPhoto') }),
                h('div', { className: 'btl-lightbox-cap' }, t('items.lightHint'))
              )
            : null
        );
      }/* ===== /items block ===== */
      function pickNextAsset(assets) {
        var list = (assets || []).filter(function (asset) {
          return asset.expiresAt && toDate(asset.expiresAt);
        });
        list.sort(function (a, b) {
          return toDate(a.expiresAt).getTime() - toDate(b.expiresAt).getTime();
        });
        var upcoming = list.filter(function (asset) {
          return toDate(asset.expiresAt).getTime() >= Date.now() - 86400000;
        });
        return upcoming[0] || list[0] || null;
      }

      function ButlerPanel() {
        var tr = useT();
        var api = useButler(tr);
        var tabState = React.useState('assets');
        var tab = tabState[0];
        var setTab = tabState[1];
        var queryState = React.useState('');
        var query = queryState[0];
        var setQuery = queryState[1];
        var data = api.data;
        var needle = String(query || '').trim().toLowerCase();

        if (!data) {
          return h(
            'div',
            { className: 'btl-root' },
            h(
              'div',
              { className: 'btl-inner' },
              api.error
                ? h(
                    'div',
                    { className: 'btl-errorbox', style: { marginTop: '24px' } },
                    h('h4', null, tr('error.load')),
                    h('p', null, api.error),
                    h(Btn, { tone: 'primary', icon: 'refresh', onClick: function () {
                      api.reload(false);
                    } }, tr('app.retry'))
                  )
                : h(Skeleton)
            )
          );
        }

        var todos = data.todos || [];
        var debts = data.debts || [];
        var alerts = data.alerts || [];
        var counts = {
          assets: (data.assets || []).length + (data.plans || []).length,
          todos: todos.filter(function (todo) {
            return todo.status === 'pending';
          }).length,
          debts: debts.filter(function (debt) {
            return debt.status !== 'settled';
          }).length,
          items: (data.items || []).length,
          alerts: alerts.length
        };

        var tabs = [
          { key: 'assets', label: tr('tab.assets'), icon: 'card' },
          { key: 'todos', label: tr('tab.todos'), icon: 'list' },
          { key: 'debts', label: tr('tab.debts'), icon: 'wallet' },
          { key: 'items', label: tr('tab.items'), icon: 'box' },
          { key: 'alerts', label: tr('tab.alerts'), icon: 'bell' }
        ];

        var body = null;
        if (tab === 'assets') body = h(AssetsTab, { data: data, api: api, query: needle });
        else if (tab === 'todos') body = h(TodosTab, { data: data, api: api, query: needle });
        else if (tab === 'debts') body = h(DebtsTab, { data: data, api: api, query: needle });
        else if (tab === 'items') body = h(ItemsTab, { data: data, api: api, query: needle });
        else body = h(AlertsTab, { data: data, api: api, query: needle });

        /* 轮询连续失败时，页头显式提示「已 N 分钟未更新」，避免一直显示旧数据 */
        var fallbackOk = toDate(data.nowIso);
        var lastOkMs = api.lastOkAt || (fallbackOk ? fallbackOk.getTime() : Date.now());
        var staleMinutes = Math.max(1, Math.round((Date.now() - lastOkMs) / 60000));
        var showStale = Boolean(api.failCount > 0 && api.lastError);

        return h(
          'div',
          { className: 'btl-root' },
          h(
            'div',
            { className: 'btl-inner' },
            h(
              'header',
              { className: 'btl-topbar' },
              h(
                'div',
                { className: 'btl-brand' },
                h('h1', null, h('span', { className: 'btl-brand-dot' }), tr('app.title')),
                h('p', null, tr('app.subtitle'))
              ),
              h('span', { className: 'btl-topbar-gap' }),
              showStale
                ? h('span', { className: 'btl-stale', title: api.lastError }, tr('app.stale', { n: staleMinutes }))
                : null,
              h(
                'div',
                { className: 'btl-search' },
                h(Ico, { name: 'search', size: 14 }),
                h('input', {
                  value: query,
                  placeholder: tr('app.search'),
                  'aria-label': tr('app.search'),
                  onChange: function (event) {
                    setQuery(event.target.value);
                  }
                }),
                query
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'btl-search-clear',
                        title: tr('app.clearSearch'),
                        'aria-label': tr('app.clearSearch'),
                        onClick: function () {
                          setQuery('');
                        }
                      },
                      h(Ico, { name: 'close', size: 12 })
                    )
                  : null
              ),
              h(IconBtn, {
                icon: 'refresh',
                title: tr('app.refresh') + ' · ' + tr('app.updated') + ' ' + fmtClock(data.nowIso),
                onClick: function () {
                  api.reload(false);
                }
              })
            ),
            h(Hero, {
              data: data,
              nextAsset: pickNextAsset(data.assets),
              onJump: function (target) {
                setTab(target);
              }
            }),
            h(
              'nav',
              { className: 'btl-tabs', role: 'tablist' },
              tabs.map(function (item) {
                return h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    role: 'tab',
                    id: 'btl-tab-' + item.key,
                    'aria-controls': 'btl-tabpanel-' + item.key,
                    'aria-selected': tab === item.key ? 'true' : 'false',
                    className: 'btl-tab' + (tab === item.key ? ' btl-tab-active' : ''),
                    onClick: function () {
                      setTab(item.key);
                    }
                  },
                  h(Ico, { name: item.icon, size: 14 }),
                  item.label,
                  counts[item.key] ? h('span', { className: 'btl-tab-count' }, String(counts[item.key])) : null
                );
              })
            ),
            h(
              'div',
              {
                className: 'btl-tabpanel',
                role: 'tabpanel',
                id: 'btl-tabpanel-' + tab,
                'aria-labelledby': 'btl-tab-' + tab,
                tabIndex: 0
              },
              body
            ),
            data.diagnostics && data.diagnostics.lastError
              ? h('div', { className: 'btl-sublist-empty', style: { marginTop: '18px' } }, data.diagnostics.lastError)
              : null
          ),
          h(Toast, { flash: api.flash })
        );
      }

      /* ------------------------------------------------------------------ *
       * 设置页
       * ------------------------------------------------------------------ */

      function SettingsSection() {
        var tr = useT();
        var api = useButler(tr);
        var data = api.data;

        function save(patch, message) {
          /* 不返回裸 promise：设置项都是点/失焦即提交，没人 await，失败只 toast 不回滚 */
          return api
            .send('/settings', { patch: patch }, { key: 'settings', success: message || tr('settings.saved') })
            .then(
              function (value) {
                return { ok: true, value: value };
              },
              function () {
                return { ok: false };
              }
            );
        }

        /* 采样条数是本地草稿：每击键就落库会把 500 先 POST 成 5，触发服务端裁剪 */
        var snapState = React.useState(null);
        var snapDraft = snapState[0];
        var setSnapDraft = snapState[1];
        var snapErrState = React.useState('');
        var snapErr = snapErrState[0];
        var setSnapErr = snapErrState[1];
        var tokenState = React.useState(readToken());
        var tokenDraft = tokenState[0];
        var setTokenDraft = tokenState[1];

        function commitSnapshots() {
          if (snapDraft === null) return;
          var raw = String(snapDraft).trim();
          var numeric = Number(raw);
          if (raw === '' || !Number.isFinite(numeric) || numeric < 0) {
            setSnapErr(tr('settings.snapshotsInvalid'));
            return;
          }
          setSnapErr('');
          save({ maxSnapshots: Math.floor(numeric) }, tr('settings.snapshotsSaved')).then(
            function () {
              setSnapDraft(null);
            },
            function () {
              setSnapDraft(null);
            }
          );
        }

        function saveToken() {
          if (!writeToken(tokenDraft)) {
            api.notify(tr('toast.failed'), 'error');
            return;
          }
          api.notify(tr('settings.apiTokenSaved'), 'ok');
        }

        var codeOpenState = React.useState('');
        var codeOpen = codeOpenState[0];
        var setCodeOpen = codeOpenState[1];
        var codeMapState = React.useState({});
        var codeMap = codeMapState[0];
        var setCodeMap = codeMapState[1];
        var srcBusyState = React.useState('');
        var srcBusy = srcBusyState[0];
        var setSrcBusy = srcBusyState[1];

        function toggleCode(source) {
          if (codeOpen === source.id) {
            setCodeOpen('');
            return;
          }
          setCodeOpen(source.id);
          if (codeMap[source.id]) return;
          request('/sources?code=1')
            .then(function (payload) {
              var map = {};
              (payload.sources || []).forEach(function (item) {
                map[item.id] = item.code || '';
              });
              setCodeMap(map);
            })
            .catch(function (cause) {
              api.notify(String(cause.message || cause), 'error');
            });
        }

        function testSource(source) {
          setSrcBusy(source.id);
          api
            .send('/sources/test', { sourceId: source.id }, { key: 'sources:' + source.id })
            .then(function (result) {
              var windows = (result && result.windows) || [];
              api.notify(tr('sources.testOk', { n: windows.length }), 'ok');
            })
            .catch(function (cause) {
              var message = String((cause && cause.message) || cause || '');
              if (message.indexOf('凭证') >= 0) api.notify(tr('sources.credentialFirst'), 'error');
            })
            .then(function () {
              setSrcBusy('');
            });
        }

        function renderSourceRow(source) {
          var isCustom = source.custom === true || String(source.id || '').indexOf('custom:') === 0;
          var hosts = (source.hosts || []).join(', ');
          var open = codeOpen === source.id;
          return h(
            'div',
            { className: 'btl-source', key: source.id },
            h(
              'div',
              { className: 'btl-source-main' },
              h(
                'div',
                { className: 'btl-source-title' },
                h('span', { className: 'btl-source-name' }, source.label || source.id),
                h(Chip, { tone: isCustom ? 'ok' : 'muted' }, isCustom ? tr('sources.custom') : tr('sources.builtin')),
                isCustom && source.needsCredential ? h(Chip, { tone: 'warn' }, tr('sources.needsCredential')) : null
              ),
              hosts ? h('div', { className: 'btl-source-meta' }, tr('sources.hosts') + ' ' + hosts) : null,
              open && codeMap[source.id] ? h('pre', { className: 'btl-source-code' }, codeMap[source.id]) : null
            ),
            h(
              'div',
              { className: 'btl-source-actions' },
              isCustom
                ? h(
                    Btn,
                    {
                      tone: 'ghost',
                      size: 'sm',
                      icon: 'refresh',
                      disabled: srcBusy === source.id,
                      onClick: function () {
                        testSource(source);
                      }
                    },
                    srcBusy === source.id ? tr('sources.testing') : tr('sources.test')
                  )
                : null,
              isCustom
                ? h(
                    Btn,
                    {
                      tone: 'ghost',
                      size: 'sm',
                      icon: 'list',
                      onClick: function () {
                        toggleCode(source);
                      }
                    },
                    open ? tr('sources.codeHide') : tr('sources.code')
                  )
                : null,
              isCustom
                ? h(ConfirmButton, {
                    size: 'sm',
                    onConfirm: function () {
                      api
                        .send('/sources/delete', { id: source.id }, { key: 'sources.delete', success: tr('toast.deleted') })
                        .catch(function () {});
                    }
                  })
                : null
            )
          );
        }

        if (!data) {
          return h('div', { className: 'btl-root' }, h('div', { className: 'btl-inner' }, api.error ? h('div', { className: 'btl-errorbox' }, h('p', null, api.error)) : h(Skeleton)));
        }

        var config = data.config || {};
        var diagnostics = data.diagnostics || {};
        var pollOptions = [
          { value: 0, label: tr('settings.pollOff') },
          { value: 15, label: tr('settings.every', { n: tr('time.seconds', { n: 15 }) }) },
          { value: 30, label: tr('settings.every', { n: tr('time.seconds', { n: 30 }) }) },
          { value: 60, label: tr('settings.every', { n: tr('time.minutes', { n: 1 }) }) },
          { value: 300, label: tr('settings.every', { n: tr('time.minutes', { n: 5 }) }) }
        ];
        var advanceOptionsList = [0, 10, 30, 60, 1440].map(function (minutes) {
          return { value: minutes, label: tr('advance.' + minutes) };
        });

        return h(
          'div',
          { className: 'btl-root' },
          h(
            'div',
            { className: 'btl-inner', style: { paddingTop: '8px' } },
            h(
              'div',
              { className: 'btl-settings' },
              h(
                'div',
                { className: 'btl-settings-row' },
                h(
                  'div',
                  { className: 'btl-settings-text' },
                  h('strong', null, tr('settings.poll')),
                  h('span', null, tr('settings.pollHint'))
                ),
                h(
                  'div',
                  { className: 'btl-settings-ctl' },
                  h(Select, {
                    value: Number(config.pollSeconds) || 0,
                    options: pollOptions,
                    onChange: function (value) {
                      save({ pollSeconds: Number(value) });
                    }
                  })
                )
              ),
              h(
                'div',
                { className: 'btl-settings-row' },
                h(
                  'div',
                  { className: 'btl-settings-text' },
                  h('strong', null, tr('settings.advance')),
                  h('span', null, tr('settings.advanceHint'))
                ),
                h(
                  'div',
                  { className: 'btl-settings-ctl' },
                  h(Select, {
                    value: Number(config.advanceMinutes) || 0,
                    options: advanceOptionsList,
                    onChange: function (value) {
                      save({ advanceMinutes: Number(value) });
                    }
                  })
                )
              ),
              h(
                'div',
                { className: 'btl-settings-row' },
                h('div', { className: 'btl-settings-text' }, h('strong', null, tr('settings.currency'))),
                h(
                  'div',
                  { className: 'btl-settings-ctl' },
                  h(Select, {
                    value: config.currency || 'CNY',
                    options: optionsFrom(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'HKD']),
                    onChange: function (value) {
                      save({ currency: value });
                    }
                  })
                )
              ),
              h(
                'div',
                { className: 'btl-settings-row' },
                h(
                  'div',
                  { className: 'btl-settings-text' },
                  h('strong', null, tr('settings.reminder')),
                  h('span', null, tr('settings.reminder.hint'))
                ),
                h(
                  'div',
                  { className: 'btl-settings-ctl' },
                  h(Chip, { tone: 'muted' }, tr('settings.reminder.' + ((config && config.reminderTarget) || 'new_once'))),
                  diagnostics.scheduleAvailable
                    ? null
                    : h(Chip, { tone: 'danger' }, tr('settings.schedule.no'))
                )
              ),
              h(
                'div',
                { className: 'btl-settings-row' },
                h(
                  'div',
                  { className: 'btl-settings-text' },
                  h('strong', null, tr('settings.apiToken')),
                  h('span', null, tr('settings.apiTokenHint'))
                ),
                h(
                  'div',
                  { className: 'btl-settings-ctl btl-settings-ctl-inline' },
                  h(TextInput, {
                    value: tokenDraft,
                    placeholder: tr('settings.apiToken'),
                    onChange: setTokenDraft,
                    onKeyDown: function (event) {
                      if (event.key === 'Enter') saveToken();
                    }
                  }),
                  h(Btn, { onClick: saveToken, title: tr('settings.apiTokenSave') }, tr('settings.apiTokenSave'))
                )
              )
            ),
            h(
              'div',
              { className: 'btl-settings', style: { marginTop: '10px' } },
              h(
                'div',
                { className: 'btl-settings-row' },
                h(
                  'div',
                  { className: 'btl-settings-text' },
                  h('strong', null, tr('settings.sources')),
                  h('span', null, tr('settings.sourcesHint'))
                )
              ),
              (data.sources || []).map(renderSourceRow)
            ),
            h(
              'details',
              { className: 'btl-details' },
              h('summary', null, tr('settings.advanced')),
              h(
                'div',
                { className: 'btl-settings', style: { marginTop: '10px' } },
                h(
                  'div',
                  { className: 'btl-settings-row' },
                  h(
                    'div',
                    { className: 'btl-settings-text' },
                    h('strong', null, tr('settings.snapshots')),
                    h('span', null, tr('settings.snapshotsHint'))
                  ),
                  h(
                    'div',
                    { className: 'btl-settings-ctl btl-settings-ctl-col' },
                    h(TextInput, {
                      value: snapDraft === null ? (config.maxSnapshots === undefined ? 240 : config.maxSnapshots) : snapDraft,
                      inputMode: 'numeric',
                      invalid: Boolean(snapErr),
                      onChange: setSnapDraft,
                      onBlur: commitSnapshots,
                      onKeyDown: function (event) {
                        if (event.key === 'Enter') commitSnapshots();
                      }
                    }),
                    snapErr ? h('span', { className: 'btl-settings-note', role: 'alert' }, snapErr) : null
                  )
                ),
                h(
                  'dl',
                  { className: 'btl-kv' },
                  h('dt', null, tr('settings.dataFile')),
                  h('dd', null, diagnostics.storagePath || '—'),
                  h('dt', null, tr('settings.credentialBackend')),
                  h('dd', null, diagnostics.credentialBackend || '—'),
                  h('dt', null, tr('settings.schedule')),
                  h('dd', null, diagnostics.scheduleAvailable ? tr('settings.schedule.ok') : tr('settings.schedule.no')),
                  h('dt', null, tr('plans.lastChecked')),
                  h('dd', null, diagnostics.lastQuotaTick ? fmtAgo(diagnostics.lastQuotaTick) : '—'),
                  diagnostics.lastError ? h('dt', null, 'lastError') : null,
                  diagnostics.lastError ? h('dd', null, String(diagnostics.lastError)) : null,
                  diagnostics.loadError ? h('dt', null, 'loadError') : null,
                  diagnostics.loadError ? h('dd', null, String(diagnostics.loadError)) : null
                )
              )
            ),
            h(Toast, { flash: api.flash })
          )
        );
      }

      function ButlerIcon() {
        return h(
          'svg',
          {
            width: 18,
            height: 18,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true'
          },
          h('path', { d: 'M8 13.2a4.8 4.8 0 0 0 4.5-3h-9A4.8 4.8 0 0 0 8 13.2z' }),
          h('path', { d: 'M6.4 3.6a1.6 1.6 0 1 1 3.2 0c1.7.5 2.9 2 2.9 3.9v2.7h-9V7.5c0-1.9 1.2-3.4 2.9-3.9z' })
        );
      }

      /* ------------------------------------------------------------------ *
       * 装配
       * ------------------------------------------------------------------ */

      function apply(ctx) {
        applyLocale(resolveLocale(ctx));

        ctx.effect(installStyles, 'butler: styles');

        var localeOff = null;
        try {
          var localeSvc = ctx.get('locale');
          if (localeSvc && typeof localeSvc.subscribe === 'function') {
            ctx.effect(function () {
              var off = localeSvc.subscribe(function () {
                if (!applyLocale(resolveLocale(ctx))) return;
                listeners.slice().forEach(function (listener) {
                  try {
                    listener();
                  } catch (error) {
                    void error;
                  }
                });
              });
              localeOff = off;
              return function () {
                if (typeof off === 'function') off();
                localeOff = null;
              };
            }, 'butler: locale');
          }
        } catch (error) {
          void localeOff;
        }

        ctx.effect(function () {
          var offMain = ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: 'butler' }, ButlerPanel);
          });
          var offSidebar = ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: 'butler',
                order: 4,
                label: function () {
                  return t('app.title');
                }
              },
              ButlerIcon
            );
          });
          var offSettings = ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'butler',
                order: 60,
                label: function () {
                  return t('app.title');
                }
              },
              SettingsSection
            );
          });
          return function () {
            [offMain, offSidebar, offSettings].forEach(function (off) {
              if (typeof off === 'function') off();
            });
          };
        }, 'butler: slots');
      }

      return {
        inject: ['slots'],
        apply: apply
      };
    }
  });
})();