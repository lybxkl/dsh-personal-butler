import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAlerts } from '../src/alerts.js';
import { createKinds } from '../src/kinds.js';
import { createService } from '../src/service.js';
import { Store, normalizePending } from '../src/store.js';

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'butler-pending-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const config = { currency: 'CNY', pollSeconds: 0, advanceMinutes: 30, maxSnapshots: 10, reminderTarget: 'new_once' };
  const kinds = createKinds(store);
  kinds.ensureSeeded();
  const credentials = { backend: () => 'memory', getError: () => null, get: () => undefined, has: () => false, set: () => true };
  const reminders = {
    available: () => true,
    isSyncing: () => false,
    lastError: () => ({ at: null, message: null }),
    async syncItem() { return { status: 'created' }; },
    async removeAllFor() {},
    async syncAll() { return { status: 'ok', created: 0, unchanged: 0, skipped: 0, past: 0, error: 0 }; },
  };
  const quota = {
    state: () => ({ busy: false, lastTick: null, lastError: null, skipped: 0 }),
    isBusy: () => false,
    sources: () => [],
    resolveSource: (id) => ({ id: id || 'generic', credentialHint: '', needsCredential: false }),
    async tick() { return { status: 'ok', results: [] }; },
  };
  const alerts = createAlerts({ store, config });
  const service = createService({ store, config, kinds, credentials, quota, reminders, alerts });
  return { store, service };
}

test('待确认：编号文本能直接发出去，且不依赖卡片', async () => {
  const { service } = makeService();
  const created = await service.createPending({
    title: '确认订阅',
    question: 'Claude Pro 每个月 $20，记成这样对吗？',
    options: ['对，就这样记', '金额不对', '日期不对'],
  });
  assert.equal(created.ok, true);
  const { pending, text } = created.data;
  assert.match(text, /1\. 对，就这样记/);
  assert.match(text, /3\. 日期不对/);
  assert.match(text, /回数字/);
  assert.equal(pending.options.length, 3);
  // 没有要落库的内容时，哪个选项都不该自动写入
  assert.equal(pending.options[0].applies, false);
  assert.equal(pending.options[1].applies, false);
});

test('待确认：回编号就落库，且只能落一次', async () => {
  const { service, store } = makeService();
  const created = await service.createPending({
    title: '确认订阅',
    question: '记成这样对吗？',
    options: ['对，就这样记', '先不记'],
    collection: 'assets',
    op: 'create',
    record: { name: 'Claude Pro', amount: 20, currency: 'USD', cycle: 'monthly' },
  });
  const id = created.data.pending.id;

  const first = await service.resolvePending({ id, choice: '1' });
  assert.equal(first.ok, true);
  assert.ok(first.data.applied);
  assert.equal(first.data.applied.name, 'Claude Pro');
  assert.equal(store.list('assets').length, 1);

  const again = await service.resolvePending({ id, choice: '1' });
  assert.equal(again.ok, false);
  assert.match(again.error, /处理过了/);
  assert.equal(store.list('assets').length, 1);
});

test('待确认：回复选项原文也能对上；不落库的选项只是记录选择', async () => {
  const { service, store } = makeService();
  const created = await service.createPending({
    question: '明天 9 点提醒你？',
    options: ['明天 9:00', '今晚 20:00', '不提醒'],
    collection: 'todos',
    op: 'create',
    record: { title: '交材料', dueAt: '明天 9:00' },
  });
  const id = created.data.pending.id;

  const picked = await service.resolvePending({ id, choice: '2. 今晚 20:00' });
  assert.equal(picked.ok, true);
  assert.equal(picked.data.applied, null);
  assert.equal(store.list('todos').length, 0);
  assert.equal(store.find('pending', id).status, 'answered');
});

test('待确认：乱回答会列出可选编号，不吞掉问题', async () => {
  const { service, store } = makeService();
  const created = await service.createPending({ question: '选一个？', options: ['甲', '乙'] });
  const id = created.data.pending.id;
  const bad = await service.resolvePending({ id, choice: '随便' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /1=甲/);
  assert.equal(store.find('pending', id).status, 'open');
});

test('待确认：落库失败时保持 open，改完还能再回', async () => {
  const { service, store } = makeService();
  const created = await service.createPending({
    question: '记成这样对吗？',
    options: ['对，就这样记', '先不记'],
    collection: 'assets',
    op: 'create',
    record: { amount: 20 }, // 没有名称，必然失败
  });
  const id = created.data.pending.id;
  const failed = await service.resolvePending({ id, choice: '1' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /落库失败/);
  assert.equal(store.find('pending', id).status, 'open');
});

test('待确认：过期的不能再回答，列表里自动变 expired', async () => {
  const { service, store } = makeService();
  const created = await service.createPending({ question: '还选吗？', options: ['甲', '乙'], ttlMinutes: 5 });
  const id = created.data.pending.id;
  store.patch('pending', id, { expiresAt: new Date(Date.now() - 60_000).toISOString() });

  const late = await service.resolvePending({ id, choice: '1' });
  assert.equal(late.ok, false);
  assert.match(late.error, /过期/);

  const list = service.listPending({ status: 'open' });
  assert.equal(list.data.count, 0);
  assert.equal(store.find('pending', id).status, 'expired');
});

test('待确认：取消后就再也回不了；state 里只暴露 open 的', async () => {
  const { service, store } = makeService();
  const first = await service.createPending({ question: '甲？', options: ['甲', '乙'] });
  const second = await service.createPending({ question: '乙？', options: ['是', '否'] });
  const cancelled = service.cancelPending({ id: first.data.pending.id });
  assert.equal(cancelled.ok, true);
  assert.equal(store.find('pending', first.data.pending.id).status, 'cancelled');

  const resolved = await service.resolvePending({ id: first.data.pending.id, choice: '1' });
  assert.equal(resolved.ok, false);

  const state = service.state();
  assert.equal(state.summary.pendingCount, 1);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].id, second.data.pending.id);
});

test('待确认：参数校验（选项数、JSON 与落库目标）', async () => {
  const { service } = makeService();
  assert.match((await service.createPending({ question: '只有一个？', options: ['甲'] })).error, /两个选项/);
  assert.match((await service.createPending({ question: '太多？', options: Array.from({ length: 9 }, (_, i) => `选项${i}`) })).error, /最多 8 个/);
  assert.match((await service.createPending({ question: '落库？', options: ['甲', '乙'], collection: 'nope' })).error, /collection/);
  assert.match((await service.createPending({ question: '落库？', options: ['甲', '乙'], collection: 'assets', op: 'create' })).error, /record/);
  const missing = await service.resolvePending({ id: 'pend_missing', choice: '1' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /不存在/);
});

test('normalizePending：老数据/脏字段也能归一化', () => {
  const view = normalizePending({
    id: 'pend_1',
    question: '  ',
    options: ['甲', { label: '乙', applies: true }, { nope: 1 }],
    status: 'weird',
    ttlMinutes: 99999,
    expiresAt: 'not-a-date',
  });
  assert.equal(view.status, 'open');
  assert.equal(view.options.length, 2);
  assert.equal(view.options[1].applies, true);
  assert.equal(view.question, '');
  // ttl 钳到 24 小时
  const span = Date.parse(view.expiresAt) - Date.parse(view.createdAt);
  assert.equal(Math.round(span / 3600000), 24);
});