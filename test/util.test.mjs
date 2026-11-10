import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CYCLE_LABEL,
  currencySymbol,
  fmtDate,
  fmtLocal,
  humanDelta,
  isValidIso,
  jsonSafe,
  minutesBetween,
  money,
  monthlyEquivalent,
  nextRenewal,
  parseWhen,
  yearlyEquivalent,
} from '../src/util.js';

const REF = new Date('2026-11-10T02:00:00.000Z'); // 北京时间 2026-11-10 10:00

test('parseWhen：ISO 与常见日期格式', () => {
  // 只给日期时默认 09:00（提醒友好），给到分钟则按分钟
  const dateOnly = parseWhen('2026-12-10', REF);
  assert.equal(dateOnly.getFullYear(), 2026);
  assert.equal(dateOnly.getMonth(), 11);
  assert.equal(dateOnly.getDate(), 10);
  assert.equal(dateOnly.getHours(), 9);
  assert.equal(parseWhen('2026-12-10 18:30', REF).getHours(), 18);
  assert.equal(parseWhen('2026-12-10T10:00:00+08:00', REF)?.toISOString(), '2026-12-10T02:00:00.000Z');
  assert.ok(parseWhen('2026/12/10', REF));
});

test('parseWhen：相对时间 + 时间戳', () => {
  const plus2h = parseWhen('+2h', REF);
  assert.equal(plus2h.getTime() - REF.getTime(), 2 * 3600 * 1000);
  const plus30m = parseWhen('+30m', REF);
  assert.equal(plus30m.getTime() - REF.getTime(), 30 * 60 * 1000);
  const plus3d = parseWhen('+3d', REF);
  assert.equal(plus3d.getTime() - REF.getTime(), 3 * 24 * 3600 * 1000);

  const seconds = Math.floor(REF.getTime() / 1000);
  assert.equal(parseWhen(String(seconds), REF).getTime(), seconds * 1000, '秒级时间戳字符串');
  assert.equal(parseWhen(seconds, REF).getTime(), seconds * 1000);
  assert.equal(parseWhen(REF.getTime(), REF).getTime(), REF.getTime());
  assert.equal(parseWhen(String(REF.getTime()), REF).getTime(), REF.getTime(), '毫秒级时间戳字符串');
});

test('parseWhen：中文口语', () => {
  const tomorrow = parseWhen('明天 9:00', REF);
  assert.equal(tomorrow.getDate(), 11);
  assert.equal(tomorrow.getHours(), 9);
  const dayAfter = parseWhen('后天 20:30', REF);
  assert.equal(dayAfter.getDate(), 12);
  assert.equal(dayAfter.getMinutes(), 30);
  const today = parseWhen('今天 23:10', REF);
  assert.equal(today.getDate(), 10);
  assert.equal(today.getHours(), 23);
});

test('parseWhen：非法输入返回 null', () => {
  for (const bad of ['', '   ', '不是时间', '2026-13-40', '2026-02-30', '2026-12-10 25:00', null, undefined]) {
    assert.equal(parseWhen(bad, REF), null, `应拒绝 ${String(bad)}`);
  }
});

test('金额与周期换算', () => {
  assert.equal(monthlyEquivalent(120, 'yearly'), 10);
  assert.equal(monthlyEquivalent(99, 'quarterly'), 33);
  assert.equal(monthlyEquivalent(30, 'monthly'), 30);
  assert.equal(monthlyEquivalent(10, 'weekly'), (10 * 52) / 12);
  assert.equal(yearlyEquivalent(30, 'monthly'), 360);
  assert.equal(yearlyEquivalent(120, 'yearly'), 120);
  assert.equal(monthlyEquivalent(500, 'once'), 0);
  assert.ok(CYCLE_LABEL.monthly.includes('月'));
});

test('金额格式化', () => {
  assert.equal(currencySymbol('CNY'), '¥');
  assert.equal(currencySymbol('USD'), '$');
  assert.equal(currencySymbol('EUR'), '€');
  assert.equal(money(20, 'USD'), '$20');
  assert.equal(money(12.5, 'CNY'), '¥12.50');
});

test('nextRenewal 按周期推进到未来', () => {
  const next = nextRenewal('2026-11-01T00:00:00.000Z', 'monthly', new Date('2026-11-10T00:00:00.000Z'));
  assert.ok(new Date(next).getTime() > new Date('2026-11-10T00:00:00.000Z').getTime());
});

test('时间展示与差值', () => {
  const in2h = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  assert.match(humanDelta(in2h), /小时/);
  assert.match(humanDelta(new Date(Date.now() - 3 * 86400 * 1000).toISOString()), /天/);
  assert.equal(minutesBetween('2026-11-10T00:00:00.000Z', '2026-11-10T01:00:00.000Z'), 60);
  assert.ok(isValidIso(fmtLocal(new Date())));
  assert.match(fmtDate('2026-12-10T00:00:00.000Z'), /12-10/);
});
test('parseWhen：数字只认 10/13 位时间戳，别把 20261111 当秒级戳', () => {
  // 10 位秒级
  assert.equal(parseWhen(1763000000, REF)?.toISOString(), '2025-11-13T02:13:20.000Z');
  // 13 位毫秒级
  assert.equal(parseWhen(1763000000000, REF)?.toISOString(), '2025-11-13T02:13:20.000Z');
  // 像日期但不是时间戳的数字，必须判为无法解析（早期版本会静默落到 1970）
  assert.equal(parseWhen(20261111, REF), null);
  assert.equal(parseWhen(20261210, REF), null);
  assert.equal(parseWhen(0, REF), null);
  assert.equal(parseWhen(123, REF), null);
  // 超出合理年份的秒级戳也要拒
  assert.equal(parseWhen(999999999, REF), null);
});

test('nextRenewal：一次性没有下次，推不出来就返回 null 而不是过去的时间', () => {
  assert.equal(nextRenewal('2026-01-01T00:00:00Z', 'once', REF), null);
  assert.equal(nextRenewal('1900-01-01T00:00:00Z', 'monthly', REF), null);
  assert.equal(nextRenewal('', 'monthly', REF), null);
  // 月末按日历推进并钳制（1/31 + 1 月 → 2 月末，而不是 3/2）
  const fromEndOfMonth = nextRenewal('2020-01-31T00:00:00Z', 'monthly', REF);
  assert.equal(fromEndOfMonth, '2026-11-28T00:00:00.000Z');
  assert.equal(nextRenewal('2026-10-01T00:00:00Z', 'monthly', REF), '2026-12-01T00:00:00.000Z');
  assert.equal(nextRenewal('2026-10-01T00:00:00Z', 'yearly', REF), '2027-10-01T00:00:00.000Z');
});

test('jsonSafe：NaN/Infinity/Date/undefined 都要变成合法 JSON', () => {
  const safe = jsonSafe({ a: undefined, b: Number.NaN, c: Infinity, d: [1, undefined, NaN], e: new Date('2026-11-10T00:00:00Z') });
  assert.deepEqual(safe, { b: null, c: null, d: [1, null, null], e: '2026-11-10T00:00:00.000Z' });
  // 结果必须能被 JSON 往返（宿主就是这么校验的）
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), safe);
  assert.equal(jsonSafe(new Date('bad')), null);
  assert.equal(jsonSafe(10n), '10');
});
