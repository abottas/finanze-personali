import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEuro, formatEuro, mulBp, isCents, toInputValue } from '../src/core/money.js';
import { isDate, addDays, addMonths, weekStart, diffDays, weekday } from '../src/core/dates.js';

test('parseEuro: formati italiani e decimali', () => {
  const ok = { '12,50': 1250, '1.234,56': 123456, '1234': 123400, '12.5': 1250, '12.50': 1250, '1.234': 123400, '€ 5': 500, '-3,00': -300, '0,07': 7, '0,7': 70, '100,': 10000 };
  for (const [i, o] of Object.entries(ok)) assert.equal(parseEuro(i), o, i);
});
test('parseEuro: rifiuta input ambigui o con più di 2 decimali (nessun arrotondamento silenzioso)', () => {
  for (const i of ['', 'abc', '1,234,5', '12,345', '1.2.3', '12,5,0', '1e3', '99999999999999', ' ', '--5', '1,2,3']) assert.equal(parseEuro(i), null, i);
});
test('parseEuro ↔ formatEuro round trip su molti valori', () => {
  for (let c = -250000; c <= 250000; c += 137) assert.equal(parseEuro(toInputValue(c)), c);
  assert.equal(formatEuro(123456), '1.234,56 €');
  assert.equal(formatEuro(-5), '−0,05 €');
  assert.equal(formatEuro(0, { symbol: false }), '0,00');
});
test('0,1 + 0,2 non genera errori di arrotondamento (aritmetica intera)', () => {
  assert.equal(parseEuro('0,10') + parseEuro('0,20'), parseEuro('0,30'));
});
test('mulBp: arrotondamento half-away-from-zero deterministico, in BigInt', () => {
  assert.equal(mulBp(10000, 2500), 2500);
  assert.equal(mulBp(1, 5000), 1); // 0,5 → 1
  assert.equal(mulBp(-1, 5000), -1);
  assert.equal(mulBp(3, 3333), 1);
  assert.equal(mulBp(1e12, 10000), 1e12);
  assert.throws(() => mulBp(100, 10001));
  assert.throws(() => mulBp(1.5, 100));
});
test('isCents rifiuta float, NaN e valori enormi', () => {
  for (const v of [1.5, NaN, Infinity, 2e12, '5', null]) assert.equal(isCents(v), false);
  assert.equal(isCents(0), true);
});
test('date: validazione calendario e aritmetica', () => {
  assert.ok(isDate('2024-02-29')); assert.ok(!isDate('2025-02-29')); assert.ok(!isDate('2025-13-01')); assert.ok(!isDate('1999-01-01')); assert.ok(!isDate('2025-1-1'));
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(diffDays('2026-03-01', '2026-02-01'), 28);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-02-28', 1, 31), '2026-03-31'); // ancora di giorno: nessuna deriva
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
  assert.equal(weekStart('2026-06-15', 1), '2026-06-15'); // lunedì
  assert.equal(weekStart('2026-06-21', 1), '2026-06-15'); // domenica
  assert.equal(weekday('2026-06-15'), 1);
});
