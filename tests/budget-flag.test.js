// Flag "Conta nel budget settimanale" su ogni spesa: automatico (conto spese + categoria nel budget) o esplicito da qualsiasi conto.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot } from '../src/core/derive.js';
import { budgetStatus, countsInWeeklyBudget } from '../src/core/budget.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { validateState } from '../src/core/validate.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, expectError, TODAY } from './helpers.js';

const W1 = TODAY;
async function setup() {
  let s = createEmptyState(ctx());
  const mk = async (name, openingCents) => { const r = await C.addAccount(s, ctx(), { name, openingCents, openingDate: '2026-01-01' }); s = r.state; return r.result; };
  const rev = await mk('Revolut', 50000), buddy = await mk('Buddy', 100000);
  s = (await C.updateBudget(s, ctx(), { weeklyCents: 22000, startDate: W1 })).state;
  const f = await C.setupBudgetFund(s, ctx(), { accountId: rev }); s = f.state;
  s = (await C.runBudgetFunding(s, ctx(), { force: true })).state;
  return { s, rev, buddy, f: f.result };
}
const exp = async (s, accountId, cents, extra = {}) => C.addTransaction(s, ctx(), { accountId, cents: -cents, kind: 'expense', categoryId: 'cat_fun', date: W1, ...extra });
const resv = (s, f, a) => snapshot(s).funds[f].byAccount[a] ?? 0;

test('automatico: con il budget finanziato conta solo la spesa sul conto spese; un altro conto no', async () => {
  let { s, rev, buddy, f } = await setup();
  const a = await exp(s, buddy, 6000); s = a.state;
  assert.equal(budgetStatus(s, W1).spentCents, 0);                                   // i 60 € di Buddy NON contano
  assert.equal(resv(s, f, rev), 22000);
  const b = await exp(s, rev, 3000); s = b.state;
  assert.equal(budgetStatus(s, W1).spentCents, 3000); assert.equal(resv(s, f, rev), 19000);
  assert.equal(countsInWeeklyBudget(s, s.transactions.find((t) => t.id === a.result)), false);
  assert.equal(countsInWeeklyBudget(s, s.transactions.find((t) => t.id === b.result)), true);
});

test('flag esplicito da un altro conto: conta nel budget e libera la riserva sul conto spese (denaro libero lì)', async () => {
  let { s, rev, buddy, f } = await setup();
  const freeBefore = snapshot(s).freeByAccount[rev];
  const a = await exp(s, buddy, 6000, { weeklyBudget: true }); s = a.state;
  assert.equal(budgetStatus(s, W1).spentCents, 6000);
  assert.equal(resv(s, f, rev), 22000 - 6000);                                       // il fondo scende di 60 €
  assert.equal(snapshot(s).freeByAccount[rev], freeBefore + 6000);                   // quei 60 € su Revolut ora sono liberi
  assert.equal(s.transactions.find((t) => t.id === a.result).fundId, null);          // non è "da fondo": esce da un altro conto
  assert.deepEqual(validateState(s), []); assert.equal((await runIntegrityChecks(s)).ok, true);
});

test('annullare o togliere il flag ripristina la riserva; riattivarlo la libera di nuovo', async () => {
  let { s, rev, buddy, f } = await setup();
  const a = await exp(s, buddy, 6000, { weeklyBudget: true }); s = a.state;
  s = (await C.updateTransaction(s, ctx(), a.result, { weeklyBudget: false })).state;
  assert.equal(resv(s, f, rev), 22000); assert.equal(budgetStatus(s, W1).spentCents, 0);
  s = (await C.updateTransaction(s, ctx(), a.result, { weeklyBudget: true })).state;
  assert.equal(resv(s, f, rev), 16000);
  s = (await C.voidTransaction(s, ctx(), a.result, 'errore')).state;
  assert.equal(resv(s, f, rev), 22000); assert.equal(budgetStatus(s, W1).spentCents, 0);
  assert.deepEqual(validateState(s), []);
});

test('flag esplicito "no" sul conto spese: non conta e non consuma il fondo', async () => {
  let { s, rev, f } = await setup();
  const a = await exp(s, rev, 3000, { weeklyBudget: false }); s = a.state;
  assert.equal(budgetStatus(s, W1).spentCents, 0); assert.equal(resv(s, f, rev), 22000);
  assert.equal(s.transactions.find((t) => t.id === a.result).fundId, null);
});

test('modificare la spesa (importo, conto) con flag riallinea la riserva senza doppi conteggi', async () => {
  let { s, rev, buddy, f } = await setup();
  const a = await exp(s, buddy, 6000, { weeklyBudget: true }); s = a.state;
  s = (await C.updateTransaction(s, ctx(), a.result, { cents: -10000 })).state;
  assert.equal(resv(s, f, rev), 12000);
  s = (await C.updateTransaction(s, ctx(), a.result, { accountId: rev })).state;       // ora esce dal conto spese: si collega al fondo
  assert.equal(s.transactions.find((t) => t.id === a.result).fundId, f); assert.equal(resv(s, f, rev), 12000);
  assert.deepEqual(validateState(s), []);
});

test('senza finanziamento il budget è un tetto per tutti i conti (comportamento invariato); flag non valido rifiutato', async () => {
  let s = createEmptyState(ctx());
  const r = await C.addAccount(s, ctx(), { name: 'Uno', openingCents: 50000, openingDate: '2026-01-01' }); s = r.state;
  const r2 = await C.addAccount(s, ctx(), { name: 'Due', openingCents: 50000, openingDate: '2026-01-01' }); s = r2.state;
  s = (await C.updateBudget(s, ctx(), { weeklyCents: 22000, startDate: W1 })).state;
  s = (await exp(s, r.result, 1000)).state; s = (await exp(s, r2.result, 2000)).state;
  assert.equal(budgetStatus(s, W1).spentCents, 3000);
  await expectError(C.updateTransaction(s, ctx(), s.transactions[0].id, { weeklyBudget: 'si' }), 'flag');
});
