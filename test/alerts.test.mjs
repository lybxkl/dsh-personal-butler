import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAlerts } from '../src/alerts.js';
import { Store } from '../src/store.js';

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'butler-alert-'));
  const store = new Store({ filePath: join(dir, 'butler.json') }).load();
  const config = { advanceMinutes: 30, currency: 'CNY' };
  const alerts = createAlerts({ store, config });
  return { store, alerts };
}

const collapse = (list) => list.map((a) => ({ key: a.dedupeKey, level: a.level, ack: a.acknowledged }));

test('提醒：7 天内到期给 warn，过期给 critical', () => {
  const { store, alerts } = makeEnv();
  const asset = store.put('assets', { name: 'iCloud+', amount: 6, currency: 'CNY', cycle: 'monthly', expiresAt: iso(5) });
  alerts.recompute();
  let list = store.list('alerts');
  assert.equal(list.length, 1);
  assert.equal(list[0].level, 'warn');
  assert.match(list[0].message, /天/);

  store.patch('assets', asset.id, { expiresAt: iso(-1) });
  alerts.recompute();
  list = store.list('alerts');
  assert.equal(list.length, 1, '同一条记录不该裂成两条');
  assert.equal(list[0].level, 'critical');
  assert.match(list[0].title, /已过期/);
});

test('提醒：已确认的 warn 在升级成 critical 时会重新出现', () => {
  const { store, alerts } = makeEnv();
  const asset = store.put('assets', { name: 'Claude Pro', amount: 20, currency: 'USD', cycle: 'monthly', expiresAt: iso(6) });
  alerts.recompute();
  const first = store.list('alerts')[0];
  assert.equal(first.level, 'warn');
  alerts.ack(first.id);
  assert.equal(store.find('alerts', first.id).acknowledged, true);

  // 还没升级：重新推导也不该把已确认的提醒翻出来
  alerts.recompute();
  assert.equal(store.find('alerts', first.id).acknowledged, true);

  // 熬到过期：必须重新冒出来，否则「确认一次之后再收不到」
  store.patch('assets', asset.id, { expiresAt: iso(-2) });
  alerts.recompute();
  const after = store.list('alerts');
  assert.equal(after.length, 1);
  assert.equal(after[0].level, 'critical');
  assert.equal(after[0].acknowledged, false);
  assert.equal(after[0].acknowledgedAt, null);
});

test('提醒：周期文案随记录更新（不是永远停在第一次的 /yearly）', () => {
  const { store, alerts } = makeEnv();
  const asset = store.put('assets', { name: 'Cursor Pro', amount: 240, currency: 'CNY', cycle: 'monthly', expiresAt: iso(3) });
  alerts.recompute();
  assert.match(store.list('alerts')[0].message, /每月/);
  store.patch('assets', asset.id, { cycle: 'yearly' });
  alerts.recompute();
  assert.match(store.list('alerts')[0].message, /每年/);
});

test('提醒：记录被删掉后对应提醒一并消失', () => {
  const { store, alerts } = makeEnv();
  const a = store.put('assets', { name: 'A', amount: 10, currency: 'CNY', cycle: 'monthly', expiresAt: iso(2) });
  const b = store.put('debts', { direction: 'owedToMe', counterpart: '李雷', amount: 500, currency: 'CNY', dueAt: iso(1) });
  alerts.recompute();
  assert.equal(store.list('alerts').length, 2);

  store.remove('assets', a.id);
  alerts.recompute();
  assert.deepEqual(collapse(store.list('alerts')).map((x) => x.key.startsWith('asset:')), [false]);

  store.remove('debts', b.id);
  alerts.recompute();
  assert.equal(store.list('alerts').length, 0);
});

test('提醒：待办到点前后分档（提前窗口 warn、逾期 critical）', () => {
  const { store, alerts } = makeEnv();
  const todo = store.put('todos', { title: '交周报', dueAt: iso(-0.02) }); // 约 29 分钟前
  alerts.recompute();
  let list = store.list('alerts');
  assert.equal(list.length, 1);
  assert.equal(list[0].level, 'critical');
  assert.match(list[0].title, /已到期/);

  // 改到 20 分钟后：回到 warn 档
  store.patch('todos', todo.id, { dueAt: iso(0.014) });
  alerts.recompute();
  list = store.list('alerts');
  assert.equal(list.length, 1);
  assert.equal(list[0].level, 'warn');
});

test('提醒：确认全部只影响当前未确认的条目', () => {
  const { store, alerts } = makeEnv();
  store.put('assets', { name: 'A', amount: 10, currency: 'CNY', cycle: 'monthly', expiresAt: iso(1) });
  store.put('debts', { direction: 'iOwe', counterpart: '王芳', amount: 1200, currency: 'CNY', dueAt: iso(2) });
  alerts.recompute();
  assert.equal(alerts.pendingCount(), 2);
  alerts.ackAll();
  assert.equal(alerts.pendingCount(), 0);
  assert.equal(store.list('alerts').length, 2, '记录还在，只是被确认了');

  // 再确认一次是幂等的，不该报错也不该改时间戳
  const stamp = store.list('alerts')[0].acknowledgedAt;
  alerts.ackAll();
  assert.equal(store.list('alerts')[0].acknowledgedAt, stamp);
});

test('提醒：窗口外的记录不生成提醒', () => {
  const { store, alerts } = makeEnv();
  store.put('assets', { name: '远处', amount: 10, currency: 'CNY', cycle: 'yearly', expiresAt: iso(40) });
  store.put('todos', { title: '以后再说', dueAt: iso(3) });
  store.put('debts', { direction: 'owedToMe', counterpart: '远期', amount: 100, currency: 'CNY', dueAt: iso(30) });
  alerts.recompute();
  assert.equal(store.list('alerts').length, 0);
});