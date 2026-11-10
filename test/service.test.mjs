import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAlerts } from '../src/alerts.js';
import { createKinds } from '../src/kinds.js';
import { createService } from '../src/service.js';
import { Store } from '../src/store.js';

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'butler-svc-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const config = { currency: 'CNY', pollSeconds: 30, advanceMinutes: 30, maxSnapshots: 10, reminderTarget: 'new_once' };
  const kinds = createKinds(store);
  kinds.ensureSeeded();

  const credentials = {
    backend: () => 'memory',
    getError: () => null,
    get: () => undefined,
    has: () => false,
    set: () => true,
  };

  const syncCalls = [];
  const reminders = {
    available: () => true,
    isSyncing: () => false,
    lastError: () => ({ at: null, message: null }),
    async syncItem(collection, record) {
      syncCalls.push({ collection, id: record.id });
      return { status: 'created' };
    },
    async removeAllFor() {},
    async syncAll() {
      return { status: 'ok', created: 1, unchanged: 0, skipped: 0, past: 0, error: 0 };
    },
  };

  const quotaCalls = [];
  const quota = {
    state: () => ({ busy: false, lastTick: null, lastError: null, skipped: 0 }),
    isBusy: () => false,
    sources: () => [{ id: 'claude-usage', label: 'Claude', needsCredential: true, credentialHint: 'OAuth token' }],
    resolveSource: (id) => ({ id: id || 'generic', credentialHint: '提示', needsCredential: true }),
    async tick(options = {}) {
      quotaCalls.push(options);
      return { status: 'ok', results: [{ planId: 'p', status: 'ok', windows: [] }] };
    },
  };

  const alerts = createAlerts({ store, config });
  const hooks = { data: [], polls: [], onDataChanged: (r) => hooks.data.push(r), onPollIntervalChanged: (s) => hooks.polls.push(s) };
  const service = createService({ store, config, kinds, credentials, quota, reminders, alerts, hooks });
  return { dir, store, config, kinds, credentials, service, alerts, quota, quotaCalls, syncCalls, hooks };
}

test('资产：缺名称/坏时间/负金额都被明确拒绝', async () => {
  const { service } = makeService();
  assert.equal((await service.upsertAsset({ amount: 10 })).ok, false);
  const badTime = await service.upsertAsset({ name: 'X', expiresAt: '不是时间' });
  assert.equal(badTime.ok, false);
  assert.match(badTime.error, /无法解析/);
  const negative = await service.upsertAsset({ name: 'X', amount: -3 });
  assert.equal(negative.ok, false);
});

test('资产：写入后同步提醒、更新面板状态', async () => {
  const { service, syncCalls, hooks } = makeService();
  const result = await service.upsertAsset({
    name: 'Claude Pro',
    amount: 20,
    currency: 'USD',
    cycle: 'monthly',
    expiresAt: '2026-12-10 18:00',
    source: 'screenshot',
  });
  assert.equal(result.ok, true);
  assert.equal(syncCalls.length, 1);
  assert.ok(hooks.data.includes('assets'));

  const state = service.state();
  assert.equal(state.assets.length, 1);
  assert.equal(state.assets[0].cycleLabel, '每月');
  assert.equal(state.assets[0].sourceLabel, '截图');
  assert.equal(state.assets[0].amountLabel, '$20');
  assert.equal(state.summary.subscriptionTotals.USD.monthlyLabel, '$20');
});

test('资产：未知种类自动注册（L3 容错）', async () => {
  const { service, kinds } = makeService();
  const result = await service.upsertAsset({ name: '域名续费', kind: 'domain', amount: 88, cycle: '每年' });
  assert.equal(result.ok, true);
  assert.equal(result.data.kindAutoRegistered, true);
  assert.equal(kinds.has('domain'), true);
  assert.equal(result.data.record.cycle, 'yearly', '中文周期要能识别');
});

test('提醒时间：KPI 日期解析后原样可读', async () => {
  const { service } = makeService();
  const result = await service.upsertTodo({ title: '交周报', dueAt: '明天 9:00' });
  assert.equal(result.ok, true);
  const due = new Date(result.data.record.dueAt);
  assert.equal(due.getHours(), 9);
  const bad = await service.upsertTodo({ title: 'x', dueAt: '下辈子' });
  assert.equal(bad.ok, false);
});

test('待办与借贷：状态流转与默认值', async () => {
  const { service } = makeService();
  const todo = await service.upsertTodo({ title: '回消息', direction: 'waiting_other', counterpart: '张三' });
  assert.equal(todo.data.record.status, 'pending');
  assert.equal(todo.data.record.direction, 'waiting_other');

  const debt = await service.upsertDebt({ counterpart: '李四', amount: 500, direction: 'owedToMe', dueAt: '2026-12-01' });
  assert.equal(debt.ok, true);
  assert.equal(debt.data.record.status, 'open');
  assert.equal(debt.data.record.settledAt, null);
  const other = await service.upsertDebt({ counterpart: '王五', amount: 300, direction: 'owedToMe' });
  assert.equal(other.ok, true);

  const zero = await service.upsertDebt({ counterpart: '李四', amount: 0 });
  assert.equal(zero.ok, false);

  const settled = await service.upsertDebt({ id: debt.data.record.id, counterpart: '李四', amount: 500, status: 'settled' });
  assert.equal(settled.ok, true);
  assert.ok(settled.data.record.settledAt, '结清要写 settledAt');

  const totals = service.state().summary.debtTotals;
  assert.equal(totals.CNY.owedToMe, 300, '已结清的不进合计');
});

test('查询与通用 mutate', async () => {
  const { service } = makeService();
  await service.upsertTodo({ title: 'a' });
  await service.upsertTodo({ title: 'b', status: 'done' });

  const pending = service.query('todos', { status: 'pending' });
  assert.equal(pending.data.total, 1);

  const created = await service.mutate({ collection: 'todos', op: 'create', record: { title: 'c' } });
  assert.equal(created.ok, true);

  const updated = await service.mutate({ collection: 'todos', op: 'update', id: created.data.record.id, record: { title: 'c2' } });
  assert.equal(updated.data.record.title, 'c2');

  const deleted = await service.mutate({ collection: 'todos', op: 'delete', id: created.data.record.id });
  assert.equal(deleted.ok, true);

  assert.equal(service.query('nope', {}).ok, false);
  assert.equal((await service.mutate({ collection: 'nope', op: 'create', record: {} })).ok, false);
  assert.equal((await service.mutate({ collection: 'todos', op: 'weird' })).ok, false);
});

test('删除资产会级联删除它的额度计划', async () => {
  const { service, store } = makeService();
  const asset = await service.upsertAsset({ name: 'Claude Pro', amount: 20, cycle: 'monthly' });
  const plan = await service.upsertPlan({ name: 'Claude 额度', sourceId: 'claude-usage', assetId: asset.data.record.id });
  assert.equal(plan.ok, true);
  assert.equal(store.list('plans').length, 1);

  await service.removeAsset(asset.data.record.id);
  assert.equal(store.list('plans').length, 0);
});

test('额度计划：默认阈值、缺凭证状态与刷新', async () => {
  const { service, quotaCalls } = makeService();
  const plan = await service.upsertPlan({ name: 'DeepSeek', sourceId: 'claude-usage' });
  assert.equal(plan.ok, true);
  assert.equal(plan.data.record.status, 'no-credential');
  assert.match(plan.data.credentialHint, /提示/);

  const refresh = await service.refreshQuota(plan.data.record.id);
  assert.equal(refresh.ok, true);
  assert.equal(quotaCalls.length, 1);
  assert.equal(quotaCalls[0].planId, plan.data.record.id);
});

test('额度计划：busy 时给出明确的跳过原因，而不是假装成功', async () => {
  const { service, quota } = makeService();
  quota.tick = async () => ({ status: 'busy' });
  const result = await service.refreshQuota();
  assert.equal(result.ok, false);
  assert.match(result.error, /串行|跳过/);
});

test('设置：面板改过的值优先，并就地更新共享 config', async () => {
  const { service, config, hooks, store } = makeService();
  const result = service.updateSettings({ pollSeconds: 90, currency: 'usd' });
  assert.equal(result.ok, true);
  assert.equal(config.pollSeconds, 90, '同一个 config 引用要就地更新');
  assert.equal(config.currency, 'USD');
  assert.deepEqual(hooks.polls, [90]);
  assert.equal(store.getMeta('settings').pollSeconds, 90, '覆盖值要落盘');

  const bad = service.updateSettings({ pollSeconds: 99999 });
  assert.equal(bad.ok, true);
  assert.equal(config.pollSeconds, 86400, '要被钳到上限');

  assert.equal(service.updateSettings({}).ok, false);
});

test('提醒与警报：确认操作幂等', async () => {
  const { service, store } = makeService();
  // 造一条已到期的资产，让 alerts 派生出一条 critical 提醒
  await service.upsertAsset({ name: '到期订阅', expiresAt: new Date(Date.now() - 86400000).toISOString() });
  const alerts = service.state().alerts;
  assert.ok(alerts.length >= 1);

  const ack = service.ackAlert(alerts[0].id);
  assert.equal(ack.ok, true);
  assert.equal(service.ackAlert('nope').ok, false);

  const all = service.ackAllAlerts();
  assert.equal(all.ok, true);
  assert.equal(service.state().alerts.filter((a) => !a.acknowledged).length, 0);
  assert.ok(store.list('alerts').length >= 1);
});

test('概览：给模型的摘要覆盖四类记录', async () => {
  const { service } = makeService();
  await service.upsertAsset({ name: 'Claude Pro', amount: 20, currency: 'USD', cycle: 'monthly', expiresAt: '2026-12-10' });
  await service.upsertPlan({ name: 'Claude 额度', sourceId: 'claude-usage' });
  await service.upsertTodo({ title: '交周报', dueAt: '2026-11-11 09:00' });
  await service.upsertDebt({ counterpart: '张三', amount: 500, direction: 'iOwe' });

  const summary = service.summary();
  assert.match(summary.text, /资产（1 项）/);
  assert.match(summary.text, /额度（1 个计划）/);
  assert.match(summary.text, /待办（1 项待处理）/);
  assert.match(summary.text, /借贷（1 笔未结清）/);
  assert.deepEqual(summary.counts, { assets: 1, plans: 1, todos: 1, debts: 1, alerts: summary.counts.alerts });

  const empty = makeService().service.summary();
  assert.match(empty.text, /还没有记录任何订阅/);
});

test('种类注册：非法 id 被拒绝，合法 id 可覆盖', async () => {
  const { service } = makeService();
  assert.equal(service.registerKind({ id: 'A B', label: 'x' }).ok, false);
  assert.equal(service.registerKind({ id: 'server', label: '服务器', hint: '有 IP 的截图' }).ok, true);
  const again = service.registerKind({ id: 'server', label: '云服务器' });
  assert.equal(again.ok, true);
  assert.equal(again.data.kind.label, '云服务器');
});

test('诊断信息齐全（面板要用来排错）', () => {
  const { service } = makeService();
  const d = service.state().diagnostics;
  for (const key of ['lastQuotaTick', 'quotaBusy', 'storagePath', 'credentialBackend', 'scheduleAvailable', 'reminderSyncing', 'loadError']) {
    assert.ok(key in d, `诊断缺 ${key}`);
  }
  assert.equal(typeof d.storagePath, 'string');
});
test('计划视图：余额型窗口标成 balance，不再算「已用百分比」', async () => {
  const { service } = makeService();
  const created = await service.upsertPlan({ name: 'DeepSeek 余额', sourceId: 'manual' });
  const id = created.data.record.id;
  await service.setPlanWindows(id, [
    { key: 'balance', label: '账户余额（CNY）', limit: null, used: null, remaining: 190.32, unit: 'cny', percent: null },
    { key: 'month', label: '本月额度', limit: 100, used: 88, remaining: 12, unit: 'percent', percent: 0.88 },
  ]);

  const plan = service.state().plans.find((p) => p.id === id);
  const balance = plan.windows.find((w) => w.key === 'balance');
  const month = plan.windows.find((w) => w.key === 'month');
  assert.equal(balance.kind, 'balance');
  assert.equal(balance.level, 'ok');
  assert.equal(balance.percent, null);
  assert.equal(month.kind, 'ratio');
  assert.equal(month.level, 'warn');

  // 余额见底 → critical，但不是靠 percent 判出来的
  await service.setPlanWindows(id, [{ key: 'balance', label: '账户余额（CNY）', remaining: 0, unit: 'cny', limit: null, used: null, percent: null }]);
  const empty = service.state().plans.find((p) => p.id === id).windows[0];
  assert.equal(empty.kind, 'balance');
  assert.equal(empty.level, 'critical');
});
