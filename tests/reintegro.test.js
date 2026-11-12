// Pagare direttamente da un fondo (es. fondo tasse) = anticipo: l'obiettivo del fondo di Reintegro sale dello stesso importo.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot } from '../src/core/derive.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { validateState } from '../src/core/validate.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, expectError } from './helpers.js';

async function setup() {
  let s = createEmptyState(ctx());
  let r = await C.addAccount(s, ctx(), { name: 'Trade', openingCents: 100000, openingDate: '2026-01-01' }); s = r.state; const tr = r.result;
  r = await C.addFund(s, ctx(), { name: 'Tasse', kind: 'tax', accountId: tr }); s = r.state; const tax = r.result;
  r = await C.addFund(s, ctx(), { name: 'Reintegro', kind: 'goal', accountId: tr, goal: { targetCents: 66000, priority: 1 } }); s = r.state; const ref = r.result;
  s = (await C.assignToFund(s, ctx(), tax, 80000)).state;
  s = (await C.updateFund(s, ctx(), tax, { refillFundId: ref })).state;
  return { s, tr, tax, ref };
}
const target = (s, id) => s.funds.find((f) => f.id === id).goal.targetCents;
const pay = async (s, tr, tax, cents) => C.addTransaction(s, ctx(), { accountId: tr, cents: -cents, kind: 'expense', categoryId: 'cat_other', fundId: tax });

test('spesa pagata dal fondo tasse: il fondo scende e il reintegro sale dello stesso importo', async () => {
  const { s, tr, tax, ref } = await setup();
  const r = await pay(s, tr, tax, 25000);
  assert.equal(snapshot(r.state).funds[tax].available, 55000);
  assert.equal(target(r.state, ref), 66000 + 25000);
  assert.equal((await runIntegrityChecks(r.state)).ok, true);
  assert.deepEqual(validateState(r.state), []);
});

test('spesa NON pagata da fondo, o fondo senza collegamento: nessun effetto', async () => {
  const { s, tr, tax, ref } = await setup();
  const a = await C.addTransaction(s, ctx(), { accountId: tr, cents: -5000, kind: 'expense', categoryId: 'cat_other' });
  assert.equal(target(a.state, ref), 66000);
  const un = (await C.updateFund(s, ctx(), tax, { refillFundId: null })).state;
  assert.equal(target((await pay(un, tr, tax, 5000)).state, ref), 66000);
});

test('annullare la spesa riporta indietro il reintegro', async () => {
  const { s, tr, tax, ref } = await setup();
  const r = await pay(s, tr, tax, 25000);
  const v = await C.voidTransaction(r.state, ctx(), r.result, 'errore');
  assert.equal(target(v.state, ref), 66000);
});

test('modificare importo o fondo della spesa ricalcola il reintegro', async () => {
  const { s, tr, tax, ref } = await setup();
  const r = await pay(s, tr, tax, 25000);
  const m = await C.updateTransaction(r.state, ctx(), r.result, { cents: -10000 });
  assert.equal(target(m.state, ref), 76000);
  const n = await C.updateTransaction(m.state, ctx(), r.result, { fundId: null });
  assert.equal(target(n.state, ref), 66000);
});

test('collegamento non valido: il reintegro deve essere un obiettivo attivo, diverso dal fondo', async () => {
  const { s, tax } = await setup();
  await expectError(C.updateFund(s, ctx(), tax, { refillFundId: tax }), 'reintegro_non_valido');
  const r = await C.addFund(s, ctx(), { name: 'Cassa', kind: 'reserve', accountId: s.accounts[0].id });
  await expectError(C.updateFund(r.state, ctx(), tax, { refillFundId: r.result }), 'reintegro_non_valido');
});

test('le correzioni al reintegro finiscono nel registro modifiche e la catena resta integra', async () => {
  const { s, tr, tax } = await setup();
  const r = await pay(s, tr, tax, 25000);
  assert.ok(r.state.audit.some((e) => e.entity === 'fund' && /Reintegro/.test(e.note)));
  assert.equal((await runIntegrityChecks(r.state)).ok, true);
});
