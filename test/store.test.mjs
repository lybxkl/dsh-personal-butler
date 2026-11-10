import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Store, normalizeAsset, normalizeDebt, normalizePlan, normalizeTodo } from '../src/store.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'butler-store-'));
  return { dir, store: new Store({ filePath: join(dir, 'butler.json') }).load() };
}

test('Store：新增/更新/删除与落盘', () => {
  const { store } = tempStore();
  const created = store.put('assets', { name: 'Claude Pro', amount: 20, currency: 'USD', cycle: 'monthly' });
  assert.ok(created.id);
  assert.ok(existsSync(store.filePath));

  const updated = store.patch('assets', created.id, { amount: 25 });
  assert.equal(updated.amount, 25);
  assert.equal(store.list('assets').length, 1);

  assert.equal(store.find('assets', 'nope'), null);
  assert.equal(store.patch('assets', 'nope', { amount: 1 }), null);

  assert.ok(store.remove('assets', created.id), '删除应返回被删记录');
  assert.equal(store.find('assets', created.id), null);
  assert.equal(store.list('assets').length, 0);
});

test('Store：写文件是原子替换，落盘内容可被重新读回', () => {
  const { store } = tempStore();
  store.put('todos', { title: '交材料', dueAt: '2026-11-11T01:00:00.000Z' });
  const raw = JSON.parse(readFileSync(store.filePath, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.todos.length, 1);

  const reopened = new Store({ filePath: store.filePath }).load();
  assert.equal(reopened.list('todos').length, 1);
  assert.equal(reopened.list('todos')[0].title, '交材料');
});

test('Store：损坏文件自动备份并重建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-store-'));
  const filePath = join(dir, 'butler.json');
  writeFileSync(filePath, '{ 这不是 JSON', 'utf8');
  const store = new Store({ filePath }).load();
  assert.match(String(store.loadError), /损坏/);
  assert.equal(store.list('assets').length, 0);
  store.put('assets', { name: 'x' });
  assert.ok(existsSync(filePath));
});

test('Store：meta 与快照裁剪', () => {
  const { store } = tempStore();
  store.setMeta('settings', { pollSeconds: 90 });
  assert.equal(store.getMeta('settings').pollSeconds, 90);
  assert.deepEqual(store.getMeta('missing', { a: 1 }), { a: 1 });

  for (let i = 0; i < 10; i += 1) {
    store.put('snapshots', { planId: 'p1', at: new Date(Date.now() + i * 1000).toISOString(), windows: [] });
  }
  store.pruneSnapshots(3);
  assert.equal(store.list('snapshots').length, 3);

  const snap = store.snapshot();
  snap.assets.push({ id: 'x' });
  assert.equal(store.list('assets').length, 0, 'snapshot 必须是深拷贝');
});

test('normalize：资产字段收敛', () => {
  const asset = normalizeAsset({
    name: '  腾讯视频  ',
    amount: '25',
    cycle: '每年',
    kind: 'VIP',
    tags: ['a', 'a', 'b'],
    extra: 'ignored',
  });
  assert.equal(asset.name, '腾讯视频');
  assert.equal(asset.amount, 25);
  assert.equal(asset.cycle, 'yearly');
  assert.equal(asset.kind, 'vip');
  assert.deepEqual(asset.tags, ['a', 'b']);
  assert.equal(asset.extra, undefined, '未知字段不该进记录');
});

test('normalize：待办/借贷/计划的默认值与边界', () => {
  const todo = normalizeTodo({ title: '回消息' });
  assert.equal(todo.status, 'pending');
  assert.equal(todo.direction, 'awaiting_me');
  assert.equal(todo.priority, 'normal');

  const debt = normalizeDebt({ counterpart: '张三', amount: -5, direction: 'iOwe' });
  assert.equal(debt.amount, 0, '负数金额归零');
  assert.equal(debt.status, 'open');

  const plan = normalizePlan({ name: 'Claude', sourceId: 'claude-usage' });
  assert.equal(plan.status, 'unknown');
  assert.equal(plan.thresholds.warn, 0.8);

  const clamped = normalizePlan({ name: 'x', thresholds: { warn: 3, critical: -1 } });
  assert.equal(clamped.thresholds.warn, 1);
  assert.equal(clamped.thresholds.critical, 1, 'critical 不能低于 warn');

  const swapped = normalizePlan({ name: 'y', thresholds: { warn: 0.9, critical: 0.5 } });
  assert.equal(swapped.thresholds.warn, 0.9);
  assert.equal(swapped.thresholds.critical, 0.9);
});

test('normalize：额度窗口百分比钳制在 0~1', () => {
  const plan = normalizePlan({
    name: 'p',
    windows: [{ key: 'w', label: '周', percent: 1.5 }, { key: 'v', label: '5h', percent: -2 }],
  });
  assert.equal(plan.windows[0].percent, 1);
  assert.equal(plan.windows[1].percent, 0);
});