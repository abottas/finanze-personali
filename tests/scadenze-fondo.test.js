// Scadenze finanziate in anticipo da un conto a scelta; PAC: i soldi vanno messi PRIMA (bonifico), l'addebito del 2 è automatico solo se il bonifico è confermato.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot, pendingTransfers } from '../src/core/derive.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { validateState } from '../src/core/validate.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, TODAY } from './helpers.js';

const DUE = '2026-07-02';
async function setup({ bbva = 100000, tr = 0 } = {}) {
  let s = createEmptyState(ctx());
  const mk = async (name, openingCents, type = 'checking') => { const r = await C.addAccount(s, ctx(), { name, openingCents, openingDate: '2026-01-01', type }); s = r.state; return r.result; };
  const bb = await mk('BBVA', bbva), trd = await mk('TR Tasse', tr), pac = await mk('TR PAC', 0, 'investment'), isy = await mk('Isy', 50000);
  const add = async (over) => { const r = await C.addPlanned(s, ctx(), { name: 'PAC', kind: 'investment', cents: 10000, dueDate: DUE, accountId: trd, toAccountId: pac, autoExecute: true, recurrence: 'monthly', fundMode: 'none', categoryId: 'cat_invest', ...over }); s = r.state; return r.result; };
  s = (await C.setPlannedFunding(s, ctx(), { enabled: true, horizonDays: 30, sourceAccountId: bb })).state;
  return { s: () => s, set: (x) => { s = x; }, bb, trd, pac, isy, add };
}
const fundOf = (s, pid) => s.funds.find((f) => f.plannedId === pid);
const at = (s, f, a) => snapshot(s).funds[f.id].byAccount[a] ?? 0;

test('le scadenze entro l\'orizzonte vengono riservate dal conto scelto; compare il bonifico da fare', async () => {
  const t = await setup(); const p = await t.add({});
  const r = await C.runPlannedFunding(t.s(), ctx()); t.set(r.state);
  assert.equal(r.result.funded, 10000); assert.equal(r.result.created, 1); assert.deepEqual(r.result.shortfalls, []);
  const f = fundOf(t.s(), p);
  assert.equal(at(t.s(), f, t.bb), 10000);
  assert.equal(snapshot(t.s()).freeByAccount[t.bb], 90000);
  assert.deepEqual(pendingTransfers(t.s(), snapshot(t.s())).map((x) => [x.fromAccountId, x.toAccountId, x.cents]), [[t.bb, t.trd, 10000]]);
  assert.deepEqual(validateState(t.s()), []);
});

test('PAC: senza bonifico confermato NON si esegue; con il bonifico confermato il 2 va in automatico e la riserva si consuma', async () => {
  const t = await setup(); const p = await t.add({});
  t.set((await C.runPlannedFunding(t.s(), ctx())).state);
  const f = fundOf(t.s(), p);
  const d = ctx({ today: DUE });
  let r = await C.runAutoPlanned(t.s(), d); assert.equal(r.result, 0);                    // bonifico non confermato: resta da confermare
  t.set((await C.confirmFundTransfer(t.s(), d, { fundId: f.id, fromAccountId: t.bb, toAccountId: t.trd, cents: 10000, date: DUE })).state);
  assert.equal(snapshot(t.s()).balances[t.trd], 10000); assert.equal(at(t.s(), f, t.trd), 10000);   // arrivato e RISERVATO al PAC (non libero)
  assert.equal(snapshot(t.s()).freeByAccount[t.trd], 0);
  r = await C.runAutoPlanned(t.s(), d); t.set(r.state); assert.equal(r.result, 1);
  const sn = snapshot(t.s());
  assert.equal(sn.balances[t.trd], 0); assert.equal(sn.balances[t.pac], 10000);
  assert.equal(at(t.s(), f, t.trd), 0);                                                   // riserva consumata: niente vincolo oltre il saldo
  assert.equal(t.s().planned.find((x) => x.id === p).dueDate, '2026-08-02');
  assert.equal((await runIntegrityChecks(t.s(), { today: DUE })).ok, true); assert.deepEqual(validateState(t.s()), []);
});

test('libero insufficiente sul conto scelto: finanzia ciò che c\'è, dichiara quanto manca, mai in negativo', async () => {
  const t = await setup({ bbva: 4000 }); const p = await t.add({});
  const r = await C.runPlannedFunding(t.s(), ctx()); t.set(r.state);
  assert.equal(r.result.funded, 4000);
  assert.deepEqual(r.result.shortfalls.map((x) => [x.name, x.cents, x.reason]), [['PAC', 6000, 'libero_insufficiente']]);
  assert.equal(snapshot(t.s()).freeByAccount[t.bb], 0);
});

test('conto di accantonamento per singola voce, voci fuori orizzonte e fondi scelti a mano non si toccano', async () => {
  const t = await setup();
  const a = await t.add({ name: 'Assicurazione', kind: 'renewal', toAccountId: null, autoExecute: false, accountId: t.isy, fundingAccountId: t.isy, recurrence: 'yearly', cents: 8000, categoryId: 'cat_subs' });
  const far = await t.add({ name: 'Lontana', dueDate: '2026-12-01' });
  const r = await C.runPlannedFunding(t.s(), ctx()); t.set(r.state);
  assert.equal(at(t.s(), fundOf(t.s(), a), t.isy), 8000);                                   // dal conto indicato sulla voce
  assert.equal(pendingTransfers(t.s(), snapshot(t.s())).length, 0);                         // già sul conto di pagamento: niente bonifico
  assert.equal(fundOf(t.s(), far), undefined);                                              // fuori dall'orizzonte
  const again = await C.runPlannedFunding(t.s(), ctx()); assert.equal(again.result.skipped, 'gia_fatto');
});

test('voce ricorrente: dopo il pagamento la successiva viene finanziata al giro dopo', async () => {
  const t = await setup(); const p = await t.add({ toAccountId: null, autoExecute: false, kind: 'subscription', categoryId: 'cat_subs', accountId: t.isy, fundingAccountId: t.isy });
  t.set((await C.runPlannedFunding(t.s(), ctx())).state);
  t.set((await C.completePlanned(t.s(), ctx({ today: DUE }), { id: p, date: DUE })).state);
  const nextDay = ctx({ today: '2026-07-05' });
  const r = await C.runPlannedFunding(t.s(), nextDay, { force: true }); t.set(r.state);
  assert.equal(r.result.funded, 10000);
  assert.equal(fundOf(t.s(), p).archived, false);
  assert.deepEqual(validateState(t.s()), []);
});

test('cambiare il conto di pagamento: il fondo della voce lo segue e il bonifico da fare sparisce se coincide con l\'accantonamento', async () => {
  const t = await setup();
  const p = await t.add({ name: 'Abbigliamento', kind: 'purchase', toAccountId: null, autoExecute: false, recurrence: 'none', categoryId: 'cat_shop', accountId: t.trd, fundingAccountId: t.bb, cents: 15000 });
  t.set((await C.runPlannedFunding(t.s(), ctx())).state);
  assert.equal(pendingTransfers(t.s(), snapshot(t.s())).length, 1);                  // BBVA → conto di pagamento
  t.set((await C.updatePlanned(t.s(), ctx(), p, { accountId: t.bb })).state);
  assert.equal(fundOf(t.s(), p).accountId, t.bb);
  assert.equal(pendingTransfers(t.s(), snapshot(t.s())).length, 0);                  // paga da BBVA: nessun bonifico
  assert.deepEqual(validateState(t.s()), []);
});
