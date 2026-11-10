import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createReminders } from '../src/reminders.js';
import { Store } from '../src/store.js';

function makeEnv({ acceptShapes = ['at'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'butler-rem-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const config = { advanceMinutes: 30, reminderTarget: 'new_once', reminderSession: '', reminderTitlePrefix: '管家提醒' };
  const calls = [];
  let seq = 0;

  const schedule = {
    async create(request) {
      calls.push({ op: 'create', request });
      const timing = request.timing || {};
      const key = timing.kind === 'after'
        ? (timing.after_seconds !== undefined ? 'afterSnake' : 'afterCamel')
        : (timing.at !== undefined ? (typeof timing.at === 'number' ? 'atMs' : 'at') : 'scheduledAt');
      if (!acceptShapes.includes(key)) throw new Error(`invalid timing shape: ${key}`);
      seq += 1;
      return { id: `task-${seq}` };
    },
    async edit(request) {
      calls.push({ op: 'edit', request });
      if (request.id === 'gone') throw new Error('schedule_not_found');
      return { id: request.id, deleted: true };
    },
  };

  const reminders = createReminders({
    store,
    config,
    getSchedule: () => schedule,
    onChange: () => {},
  });
  return { store, config, reminders, calls, schedule };
}

const future = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();

test('提醒：为待办建立「提前 + 到点」两条任务', async () => {
  const { store, reminders, calls } = makeEnv();
  const todo = store.put('todos', { title: '交周报', dueAt: future(5) });
  const result = await reminders.syncItem('todos', todo);
  assert.equal(result.status, 'created');

  const creates = calls.filter((c) => c.op === 'create');
  assert.equal(creates.length, 2);
  assert.match(creates[0].request.title, /提前提醒/);
  assert.match(creates[1].request.title, /到点提醒/);
  assert.ok(creates[1].request.title.length <= 120);
  assert.match(creates[1].request.prompt, /ask_user_question/);

  const saved = store.find('todos', todo.id);
  assert.ok(saved.reminder.dueTaskId);
  assert.ok(saved.reminder.advanceTaskId);
  assert.equal(saved.reminder.advanceMinutes, 30);
});

test('提醒：指纹不变时保持幂等，不重复建任务', async () => {
  const { store, reminders, calls } = makeEnv();
  const todo = store.put('todos', { title: '交周报', dueAt: future(5) });
  await reminders.syncItem('todos', todo);
  const before = calls.filter((c) => c.op === 'create').length;

  const again = await reminders.syncItem('todos', store.find('todos', todo.id));
  assert.equal(again.status, 'unchanged');
  assert.equal(calls.filter((c) => c.op === 'create').length, before);
});

test('提醒：时间改了会先删旧任务再建新的', async () => {
  const { store, reminders, calls } = makeEnv();
  const todo = store.put('todos', { title: '交周报', dueAt: future(5) });
  await reminders.syncItem('todos', todo);

  const moved = store.patch('todos', todo.id, { dueAt: future(9) });
  const result = await reminders.syncItem('todos', moved);
  assert.equal(result.status, 'created');
  const edits = calls.filter((c) => c.op === 'edit');
  assert.equal(edits.length, 2, '两条旧任务都要撤掉');
});

test('提醒：过去的时间不再建任务', async () => {
  const { store, reminders, calls } = makeEnv();
  const todo = store.put('todos', { title: '早该做了', dueAt: new Date(Date.now() - 3600 * 1000).toISOString() });
  const result = await reminders.syncItem('todos', todo);
  assert.equal(result.status, 'past');
  assert.equal(calls.filter((c) => c.op === 'create').length, 0);
});

test('提醒：完成/结清的记录不再提醒并清理任务', async () => {
  const { store, reminders } = makeEnv();
  const todo = store.put('todos', { title: '交周报', dueAt: future(5) });
  await reminders.syncItem('todos', todo);
  const done = store.patch('todos', todo.id, { status: 'done' });
  const result = await reminders.syncItem('todos', done);
  assert.equal(result.status, 'skipped');
  const saved = store.find('todos', todo.id);
  assert.equal(saved.reminder.dueTaskId, null);
});

test('提醒：不支持的 timing 形状会自动换形状重试', async () => {
  const { store, reminders, calls } = makeEnv({ acceptShapes: ['scheduledAt'] });
  const todo = store.put('todos', { title: '交周报', dueAt: future(5) });
  const result = await reminders.syncItem('todos', todo);
  assert.equal(result.status, 'created');
  assert.equal(reminders.timingShape(), 'scheduledAt');
  const creates = calls.filter((c) => c.op === 'create');
  assert.ok(creates.length > 2, '第一个形状会失败一次再换');
  assert.equal(creates.at(-1).request.timing.scheduledAt !== undefined, true);
});

test('提醒：删除任务时 not_found 被当作成功', async () => {
  const { reminders } = makeEnv();
  const ok = await reminders.removeAllFor({ reminder: { dueTaskId: 'gone', advanceTaskId: 'task-x' } });
  assert.equal(ok, undefined);
});

test('提醒：目标会话模式', async () => {
  const { store, reminders, calls, config } = makeEnv();
  config.reminderTarget = 'session';
  config.reminderSession = 'sess-1';
  const todo = store.put('todos', { title: '交周报', dueAt: future(5) });
  await reminders.syncItem('todos', todo);
  const creates = calls.filter((c) => c.op === 'create');
  assert.deepEqual(creates[0].request.target, { kind: 'session', sessionId: 'sess-1' });

  const { reminders: r2, calls: c2, config: cfg2, store: s2 } = makeEnv();
  cfg2.reminderTarget = 'new_once';
  const t2 = s2.put('todos', { title: 'x', dueAt: future(5) });
  await r2.syncItem('todos', t2);
  assert.equal(c2.filter((c) => c.op === 'create')[0].request.target, undefined, 'new_once 应省略 target');
});

test('提醒：没有 schedule 服务时优雅降级', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-rem-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const reminders = createReminders({
    store,
    config: { advanceMinutes: 30, reminderTarget: 'new_once' },
    getSchedule: () => null,
  });
  assert.equal(reminders.available(), false);
  const todo = store.put('todos', { title: 'x', dueAt: future(3) });
  assert.equal((await reminders.syncItem('todos', todo)).status, 'unavailable');
  assert.equal((await reminders.syncAll({})).status, 'unavailable');
});

test('提醒：指定的会话失效时退回 new_once，而不是整条提醒建不起来', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-rem-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const config = { advanceMinutes: 30, reminderTarget: 'session', reminderSession: 'sess-gone' };
  const requests = [];
  const schedule = {
    async create(request) {
      // 注意：createTask 会在失败后删除 request.target 重试，所以要拍快照再记录
      requests.push(JSON.parse(JSON.stringify({ ...request, target: request.target || null })));
      if (request.target) throw new Error('session sess-gone not found');
      return { id: `task-${requests.length}` };
    },
    async edit() {
      return { deleted: true };
    },
  };
  const reminders = createReminders({ store, config, getSchedule: () => schedule });
  const todo = store.put('todos', { title: '交周报', dueAt: future(5) });
  const result = await reminders.syncItem('todos', todo);

  assert.equal(result.status, 'created');
  assert.equal(requests.length, 4, '两条任务各失败一次（带会话）再成功一次（省掉 target）');
  assert.deepEqual(
    requests.map((r) => Boolean(r.target)),
    [true, false, true, false],
  );
  assert.match(reminders.lastError()?.message || '', /退回 new_once/);
});

test('提醒：非入参形状类错误不反复换形状重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-rem-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const config = { advanceMinutes: 30, reminderTarget: 'new_once' };
  const attempts = [];
  const schedule = {
    async create(request) {
      attempts.push(request);
      throw new Error('boom: 磁盘满了');
    },
    async edit() {
      return { deleted: true };
    },
  };
  const reminders = createReminders({ store, config, getSchedule: () => schedule });
  const todo = store.put('todos', { title: '交周报', dueAt: future(5) });
  const result = await reminders.syncItem('todos', todo);

  assert.equal(result.status, 'error');
  assert.equal(attempts.length, 1, '一次就够，不该试满五种形状');
  assert.match(String(reminders.lastError()?.message || ''), /磁盘/);
});
test('提醒：advanceMinutes=0 只建到点那一条（同一时刻不该叮两次）', async () => {
  const { store, reminders, calls } = makeEnv();
  const todo = store.put('todos', { title: '只到点提醒', dueAt: future(6), advanceMinutes: 0 });
  const result = await reminders.syncItem('todos', todo);
  assert.equal(result.status, 'created');

  const creates = calls.filter((c) => c.op === 'create');
  assert.equal(creates.length, 1);
  assert.match(creates[0].request.title, /到点提醒/);

  const saved = store.find('todos', todo.id);
  assert.ok(saved.reminder.dueTaskId);
  assert.equal(saved.reminder.advanceTaskId, null);

  // 再同步一次必须保持 unchanged，而且不能因为「缺提前任务」每轮重建
  calls.length = 0;
  const again = await reminders.syncItem('todos', store.find('todos', todo.id));
  assert.equal(again.status, 'unchanged');
  assert.equal(calls.length, 0);
});

test('提醒：正文版本号参与幂等签名，改文案会让老任务重建', async () => {
  const { store, reminders, calls } = makeEnv();
  const todo = store.put('todos', { title: '文案升级', dueAt: future(5) });
  await reminders.syncItem('todos', todo);
  // 模拟早期版本留下的旧签名
  const saved = store.find('todos', todo.id);
  store.patch('todos', todo.id, { reminder: { ...saved.reminder, sig: '2026-01-01T00:00:00.000Z|30|pending' } });
  calls.length = 0;
  const result = await reminders.syncItem('todos', store.find('todos', todo.id));
  assert.equal(result.status, 'created');
  assert.ok(calls.some((c) => c.op === 'edit'));
  assert.match(store.find('todos', todo.id).reminder.sig, /^v2\|/);
});
