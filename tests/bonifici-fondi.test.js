// Annullare un bonifico di un fondo riporta anche la riserva; un bonifico non può superare il saldo del conto.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot, pendingTransfers } from '../src/core/derive.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { validateState } from '../src/core/validate.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, expectError } from './helpers.js';

async function setup({ a = 100000, b = 2850 } = {}) {
  let s = createEmptyState(ctx());
  const mk = async (name, openingCents) => { const r = await C.addAccount(s, ctx(), { name, openingCents, openingDate: '2026-01-01' }); s = r.state; return r.result; };
  const A = await mk('Banca A', a), B = await mk('Banca B', b);
  const f = (await C.addFund(s, ctx(), { name: 'Obiettivo', kind: 'goal', accountId: B, goal: { targetCents: 66000, priority: 1 } })); s = f.state;
  s = (await C.assignToFund(s, ctx(), f.result, 66000, '', A)).state;          // riserva sul conto A, destinazione B
  return { s, A, B, f: f.result };
}
const at = (s, f, a) => snapshot(s).funds[f].byAccount[a] ?? 0;

test('annullare il bonifico di un fondo riporta la riserva sul conto di origine (niente vincolo orfano)', async () => {
  let { s, A, B, f } = await setup({ b: 0 });
  const t = await C.confirmFundTransfer(s, ctx(), { fundId: f, fromAccountId: A, toAccountId: B, cents: 66000 }); s = t.state;
  assert.equal(at(s, f, B), 66000); assert.equal(snapshot(s).balances[B], 66000);
  s = (await C.voidTransfer(s, ctx(), t.result, 'ci ho ripensato')).state;
  assert.equal(snapshot(s).balances[B], 0); assert.equal(snapshot(s).balances[A], 100000);
  assert.equal(at(s, f, B), 0); assert.equal(at(s, f, A), 66000);                  // la riserva è tornata dove sono i soldi
  assert.equal(snapshot(s).freeByAccount[B], 0);                                     // nessun "vincolato oltre il saldo"
  assert.deepEqual(pendingTransfers(s, snapshot(s)).map((p) => [p.fromAccountId, p.cents]), [[A, 66000]]);   // il bonifico torna "da fare"
  assert.deepEqual(validateState(s), []); assert.equal((await runIntegrityChecks(s)).ok, true);
});

// Situazione ereditata: una riserva di 660 € sul conto B che in realtà ha solo 28,50 € (bonifico poi annullato in banca).
async function stale() {
  let { s, A, B, f } = await setup({ b: 0 });
  s = (await C.confirmFundTransfer(s, ctx(), { fundId: f, fromAccountId: A, toAccountId: B, cents: 66000 })).state;
  s = (await C.updateBalances(s, ctx(), [{ accountId: B, balanceCents: 2850 }])).state;                          // saldo reale di B: 28,50 €
  return { s, A, B, f };
}
test('un bonifico di fondo non può superare il saldo del conto di origine (errore tipico: bonifico mai fatto)', async () => {
  const { s, A, B, f } = await stale();
  assert.ok(snapshot(s).freeByAccount[B] < 0);                                        // è la situazione "vincolato oltre il saldo"
  await expectError(C.confirmFundTransfer(s, ctx(), { fundId: f, fromAccountId: B, toAccountId: A, cents: 66000 }), 'saldo_insufficiente');
});
test('sposta fondo: rifiutato se la parte da spostare supera il saldo reale del conto, ammesso se è coperta', async () => {
  const { s, A, B, f } = await stale();
  await expectError(C.relocateFund(s, ctx(), f, A), 'saldo_insufficiente');
  const rel = await C.releaseFromFund(s, ctx(), f, 66000 - 2000, '', B);               // tengo riservati solo 20 € su B
  const ok = await C.relocateFund(rel.state, ctx(), f, A);
  assert.equal(snapshot(ok.state).balances[B], 850);                                   // 28,50 − 20 = 8,50 €
  assert.equal(at(ok.state, f, A), 2000);
});
