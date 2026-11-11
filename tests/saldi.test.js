// Aggiornamento dei saldi in qualsiasi momento: tracciabile, atomico, senza riscrivere la storia.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot } from '../src/core/derive.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { validateState } from '../src/core/validate.js';
import { monthlySeries } from '../src/core/analytics.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, expectError, TODAY } from './helpers.js';

async function two() {
  let s = createEmptyState(ctx());
  let r = await C.addAccount(s, ctx(), { name: 'A', openingCents: 10000, openingDate: '2026-01-01' }); s = r.state; const a = r.result;
  r = await C.addAccount(s, ctx(), { name: 'B', openingCents: 20000, openingDate: '2026-01-01' }); s = r.state;
  return { s, a, b: r.result };
}
test('conto SENZA movimenti: correggere un saldo sbagliato cambia il saldo iniziale, senza rettifiche', async () => {
  let { s, a } = await two();
  ({ state: s } = await C.updateBalances(s, ctx(), [{ accountId: a, balanceCents: 15000 }]));   // avevo scritto male: era 150, non 100
  assert.equal(snapshot(s).balances[a], 15000);
  assert.equal(s.transactions.length, 0);                                                      // nessuna rettifica da un errore di battitura
  assert.equal(s.accounts.find((x) => x.id === a).openingCents, 15000);
  assert.ok(s.audit.some((e) => e.action === 'set_balance' && /corretto/.test(e.note) && e.before.openingCents === 10000));
});
test('conto CON movimenti: aggiornare il saldo registra una rettifica tracciata, la storia non si riscrive', async () => {
  let { s, a } = await two();
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a, cents: -2500, kind: 'expense', categoryId: 'cat_food', date: '2026-06-10' }));
  const before = JSON.stringify(s.transactions);
  // non entro per due giorni: la banca dice 70,00 invece dei 75,00 calcolati
  ({ state: s } = await C.updateBalances(s, ctx(), [{ accountId: a, balanceCents: 7000 }]));
  assert.equal(snapshot(s).balances[a], 7000);
  assert.equal(s.accounts.find((x) => x.id === a).openingCents, 10000);                        // apertura intatta
  const adj = s.transactions.at(-1);
  assert.equal(adj.kind, 'adjustment'); assert.equal(adj.cents, -500); assert.equal(adj.categoryId, 'cat_adj'); assert.equal(adj.date, TODAY);
  assert.equal(JSON.stringify(s.transactions.slice(0, -1)), before);                           // i movimenti precedenti non cambiano
  assert.equal(s.reconciliations.at(-1).resolvedTxId, adj.id);
  assert.equal(monthlySeries(s, TODAY, 1)[0].expense, 2500);                                   // la rettifica non è una spesa
  assert.equal((await runIntegrityChecks(s)).ok, true); assert.deepEqual(validateState(s), []);
});
test('più conti in una volta (anche dopo giorni senza aprire l\'app); i conti invariati non generano nulla', async () => {
  let { s, a, b } = await two();
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a, cents: 1000, kind: 'income', categoryId: 'cat_in_other', date: '2026-06-01' }));
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: b, cents: -1000, kind: 'expense', categoryId: 'cat_food', date: '2026-06-01' }));
  const n = s.transactions.length;
  const out = await C.updateBalances(s, ctx(), [{ accountId: a, balanceCents: 11000 }, { accountId: b, balanceCents: 12345 }]); // a invariato (110,00), b diverso
  assert.equal(out.state.transactions.length, n + 1);
  assert.deepEqual(out.result.map((x) => x.how), ['adjustment']);
  assert.equal(snapshot(out.state).balances[b], 12345);
});
test('saldo "da aggiornare" → impostato; con movimenti già registrati il saldo di oggi coincide con quello dichiarato', async () => {
  let { s } = await two();
  let r = await C.addAccount(s, ctx(), { name: 'C', openingCents: 0, openingDate: '2026-01-01', balanceUnknown: true }); s = r.state; const c = r.result;
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: c, cents: -3000, kind: 'expense', categoryId: 'cat_food', date: TODAY }));
  ({ state: s } = await C.updateBalances(s, ctx(), [{ accountId: c, balanceCents: 50000 }]));
  assert.equal(snapshot(s).balances[c], 50000); assert.equal(s.accounts.find((x) => x.id === c).balanceUnknown, false);
  assert.equal(s.transactions.filter((t) => t.kind === 'adjustment').length, 0);              // nessuna rettifica: era un saldo sconosciuto
});
test('atomico: se un conto non è valido non cambia nessuno degli altri', async () => {
  const { s, a } = await two(); const j = JSON.stringify(s);
  await expectError(C.updateBalances(s, ctx(), [{ accountId: a, balanceCents: 99999 }, { accountId: 'inesistente', balanceCents: 1 }]), 'non_trovato');
  assert.equal(JSON.stringify(s), j);
  await expectError(C.updateBalances(s, ctx(), []), 'vuoto');
  await expectError(C.updateBalances(s, ctx(), [{ accountId: a, balanceCents: 1.5 }]), 'importo_non_valido');
});
test('i fondi restano coerenti: se il nuovo saldo scende sotto le riserve l\'app lo segnala (vincolato oltre il saldo)', async () => {
  let { s, a } = await two();
  let r = await C.addFund(s, ctx(), { name: 'F', kind: 'reserve', accountId: a }); s = r.state;
  ({ state: s } = await C.assignToFund(s, ctx(), r.result, 8000));
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a, cents: -100, kind: 'expense', categoryId: 'cat_food', date: '2026-06-02' }));
  ({ state: s } = await C.updateBalances(s, ctx(), [{ accountId: a, balanceCents: 3000 }]));
  assert.ok(snapshot(s).freeByAccount[a] < 0);
  assert.equal((await runIntegrityChecks(s)).items.find((i) => i.id === 'vincoli_entro_saldo').severity, 'warn');
});
