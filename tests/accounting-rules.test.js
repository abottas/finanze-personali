import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot, balanceOf } from '../src/core/derive.js';
import { validateState } from '../src/core/validate.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { base, ctx, expectError, TODAY } from './helpers.js';

test('i trasferimenti non sono entrate né spese: spostano saldo ma non cambiano il totale', async () => {
  let { s, a1, a2 } = await base();
  const before = snapshot(s).total;
  ({ state: s } = await C.addTransfer(s, ctx(), { fromAccountId: a1, toAccountId: a2, cents: 30000, date: '2026-06-01' }));
  const snap = snapshot(s);
  assert.equal(snap.total, before);
  assert.equal(snap.balances[a1], 70000);
  assert.equal(snap.balances[a2], 80000);
  assert.equal(s.transactions.length, 0); // nessun movimento income/expense generato
  // i trasferimenti non contano nel budget né come entrate/uscite
  const income = s.transactions.filter((t) => t.kind === 'income');
  assert.equal(income.length, 0);
});
test('trasferimento: stesso conto, importo ≤ 0, data futura rifiutati', async () => {
  const { s, a1, a2 } = await base();
  await expectError(C.addTransfer(s, ctx(), { fromAccountId: a1, toAccountId: a1, cents: 100 }), 'stesso_conto');
  await expectError(C.addTransfer(s, ctx(), { fromAccountId: a1, toAccountId: a2, cents: 0 }), 'importo');
  await expectError(C.addTransfer(s, ctx(), { fromAccountId: a1, toAccountId: a2, cents: -5 }), 'importo');
  await expectError(C.addTransfer(s, ctx(), { fromAccountId: a1, toAccountId: a2, cents: 100, date: '2026-07-01' }), 'data_non_valida');
});
test('i saldi derivano solo dai movimenti effettivi (saldo iniziale + movimenti)', async () => {
  let { s, a1 } = await base();
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a1, cents: -2550, kind: 'expense', categoryId: 'cat_food', date: '2026-06-10' }));
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a1, cents: 40000, kind: 'income', categoryId: 'cat_pro', date: '2026-06-11' }));
  assert.equal(snapshot(s).balances[a1], 100000 - 2550 + 40000);
  assert.equal(balanceOf(s, a1, '2026-06-10'), 100000 - 2550); // saldo alla data
  assert.equal(s.accounts[0].openingCents, 100000); // il saldo iniziale non viene mai mutato
});
test('movimenti: segno coerente col tipo, niente date future né antecedenti all\'apertura, niente float', async () => {
  const { s, a1 } = await base();
  await expectError(C.addTransaction(s, ctx(), { accountId: a1, cents: 500, kind: 'expense' }), 'segno');
  await expectError(C.addTransaction(s, ctx(), { accountId: a1, cents: -500, kind: 'income' }), 'segno');
  await expectError(C.addTransaction(s, ctx(), { accountId: a1, cents: -500, kind: 'expense', date: '2026-06-16' }), 'data_futura');
  await expectError(C.addTransaction(s, ctx(), { accountId: a1, cents: -500, kind: 'expense', date: '2025-12-31' }), 'data_prima_apertura');
  await expectError(C.addTransaction(s, ctx(), { accountId: a1, cents: -5.5, kind: 'expense' }), 'importo_non_valido');
  await expectError(C.addTransaction(s, ctx(), { accountId: a1, cents: 0, kind: 'income' }), 'importo_zero');
});
test('un importo non può essere assegnato a due fondi: il libero è per differenza', async () => {
  let { s, a1 } = await base(); // libero = 1000,00
  let r = await C.addFund(s, ctx(), { name: 'A', kind: 'reserve', accountId: a1 }); s = r.state; const fA = r.result;
  r = await C.addFund(s, ctx(), { name: 'B', kind: 'reserve', accountId: a1 }); s = r.state; const fB = r.result;
  ({ state: s } = await C.assignToFund(s, ctx(), fA, 60000));
  assert.equal(snapshot(s).freeByAccount[a1], 40000);
  await expectError(C.assignToFund(s, ctx(), fB, 60000), 'libero_insufficiente'); // gli stessi 600 € non sono più liberi
  ({ state: s } = await C.assignToFund(s, ctx(), fB, 40000));
  assert.equal(snapshot(s).freeByAccount[a1], 0);
  await expectError(C.assignToFund(s, ctx(), fA, 1), 'libero_insufficiente');
  assert.equal(snapshot(s).reserved + snapshot(s).free, snapshot(s).total);
});
test('le allocazioni sono virtuali: non cambiano il saldo bancario né creano trasferimenti', async () => {
  let { s, a1 } = await base();
  const bal = snapshot(s).balances[a1];
  let r = await C.addFund(s, ctx(), { name: 'Tasse', kind: 'tax', accountId: a1 }); s = r.state;
  ({ state: s } = await C.assignToFund(s, ctx(), r.result, 25000));
  assert.equal(snapshot(s).balances[a1], bal);
  assert.equal(s.transfers.length, 0);
  assert.equal(s.transactions.length, 0);
  assert.equal(s.allocations.length, 1);
});
test('spesa da fondo: scala il fondo e il saldo, ma non il libero; mai oltre il disponibile', async () => {
  let { s, a1 } = await base();
  let r = await C.addFund(s, ctx(), { name: 'Auto', kind: 'reserve', accountId: a1 }); s = r.state; const f = r.result;
  ({ state: s } = await C.assignToFund(s, ctx(), f, 30000));
  const freeBefore = snapshot(s).freeByAccount[a1];
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a1, cents: -12000, kind: 'expense', fundId: f, categoryId: 'cat_other' }));
  const sn = snapshot(s);
  assert.equal(sn.funds[f].assigned, 30000); assert.equal(sn.funds[f].spent, 12000); assert.equal(sn.funds[f].available, 18000);
  assert.equal(sn.freeByAccount[a1], freeBefore); // il libero non cambia
  await expectError(C.addTransaction(s, ctx(), { accountId: a1, cents: -18001, kind: 'expense', fundId: f }), 'fondo_insufficiente');
});
test('sposta tra fondi: somma zero, solo stesso conto', async () => {
  let { s, a1, a2 } = await base();
  const mk = async (name, acc) => { const r = await C.addFund(s, ctx(), { name, kind: 'reserve', accountId: acc }); s = r.state; return r.result; };
  const f1 = await mk('F1', a1), f2 = await mk('F2', a1), f3 = await mk('F3', a2);
  ({ state: s } = await C.assignToFund(s, ctx(), f1, 20000));
  const before = snapshot(s);
  ({ state: s } = await C.moveBetweenFunds(s, ctx(), f1, f2, 5000));
  const after = snapshot(s);
  assert.equal(after.reserved, before.reserved); assert.equal(after.free, before.free);
  assert.equal(after.funds[f1].available, 15000); assert.equal(after.funds[f2].available, 5000);
  // verso un fondo il cui conto di riferimento è un altro: la riserva resta sul conto di f1 (virtuale) e il bonifico è da confermare
  ({ state: s } = await C.moveBetweenFunds(s, ctx(), f1, f3, 100));
  assert.equal(snapshot(s).funds[f3].byAccount[a1], 100); assert.equal(s.transfers.length, 0);
  await expectError(C.moveBetweenFunds(s, ctx(), f1, f2, 14901), 'disponibile_insufficiente');
});
test('spostare un fondo su un altro conto genera un VERO trasferimento bancario distinguibile', async () => {
  let { s, a1, a2 } = await base();
  let r = await C.addFund(s, ctx(), { name: 'Tasse', kind: 'tax', accountId: a1 }); s = r.state;
  ({ state: s } = await C.assignToFund(s, ctx(), r.result, 20000));
  ({ state: s } = await C.relocateFund(s, ctx(), r.result, a2));
  const sn = snapshot(s);
  assert.equal(s.transfers.length, 1);
  assert.equal(sn.balances[a1], 80000); assert.equal(sn.balances[a2], 70000);
  assert.equal(sn.freeByAccount[a1], 80000); assert.equal(sn.freeByAccount[a2], 50000); // il libero non cambia
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('le correzioni sono tracciabili: annullamento con motivo, mai cancellazione', async () => {
  let { s, a1 } = await base();
  let r = await C.addTransaction(s, ctx(), { accountId: a1, cents: -1000, kind: 'expense', categoryId: 'cat_food' }); s = r.state; const id = r.result;
  await expectError(C.voidTransaction(s, ctx(), id, ''), 'motivo_mancante');
  ({ state: s } = await C.voidTransaction(s, ctx(), id, 'Importo errato'));
  assert.equal(s.transactions.length, 1); // resta nello storico
  assert.equal(s.transactions[0].status, 'void'); assert.equal(s.transactions[0].voidReason, 'Importo errato');
  assert.equal(snapshot(s).balances[a1], 100000); // non incide più sul saldo
  assert.ok(s.audit.some((e) => e.action === 'void' && e.note === 'Importo errato' && e.before.status === 'posted' && e.after.status === 'void'));
  await expectError(C.updateTransaction(s, ctx(), id, { cents: -2000 }), 'annullato');
});
test('le modifiche registrano valore prima/dopo nello storico', async () => {
  let { s, a1 } = await base();
  let r = await C.addTransaction(s, ctx(), { accountId: a1, cents: -1000, kind: 'expense', categoryId: 'cat_food' }); s = r.state;
  ({ state: s } = await C.updateTransaction(s, ctx(), r.result, { cents: -1500, note: 'corretto' }));
  const e = s.audit.at(-1);
  assert.equal(e.action, 'update'); assert.equal(e.before.cents, -1000); assert.equal(e.after.cents, -1500);
});
test('un comando fallito non modifica lo stato originale (atomicità)', async () => {
  const { s, a1 } = await base();
  const snapJson = JSON.stringify(s);
  await expectError(C.addTransaction(s, ctx(), { accountId: a1, cents: -100, kind: 'expense', categoryId: 'inesistente' }));
  assert.equal(JSON.stringify(s), snapJson);
});
test('archiviare un conto richiede saldo zero e nessun fondo attivo', async () => {
  let { s, a1 } = await base();
  await expectError(C.archiveAccount(s, ctx(), a1), 'saldo_non_zero');
});
test('quadratura con la banca: differenza segnalata e risolta solo con rettifica tracciata', async () => {
  let { s, a1 } = await base();
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a1, cents: -2000, kind: 'expense', categoryId: 'cat_food', date: '2026-06-10' }));
  let r = await C.addReconciliation(s, ctx(), { accountId: a1, date: '2026-06-12', bankCents: 97000 }); s = r.state;
  let chk = await runIntegrityChecks(s);
  assert.equal(chk.items.find((i) => i.id.startsWith('quadratura_')).severity, 'warn'); // 980 vs 970
  ({ state: s } = await C.resolveReconciliation(s, ctx(), r.result));
  chk = await runIntegrityChecks(s);
  assert.equal(chk.items.find((i) => i.id.startsWith('quadratura_')).severity, 'ok');
  const adj = s.transactions.find((t) => t.kind === 'adjustment');
  assert.equal(adj.cents, -1000); assert.equal(adj.categoryId, 'cat_adj');
});
test('chiudere un fondo rilascia il residuo al libero; non si chiude un fondo usato da una regola fiscale', async () => {
  let { s, a1 } = await base();
  let r = await C.addFund(s, ctx(), { name: 'Tasse', kind: 'tax', accountId: a1 }); s = r.state; const f = r.result;
  ({ state: s } = await C.assignToFund(s, ctx(), f, 10000));
  ({ state: s } = await C.setTaxRules(s, ctx(), [{ name: 'IRPEF', bp: 2000, fundId: f }]));
  await expectError(C.closeFund(s, ctx(), f), 'fondo_in_regola');
  ({ state: s } = await C.setTaxRules(s, ctx(), []));
  ({ state: s } = await C.closeFund(s, ctx(), f));
  assert.equal(snapshot(s).freeByAccount[a1], 100000);
  assert.equal(validateState(s).length, 0);
});
test('regressione: lo storico non cambia retroattivamente quando l\'entità viene modificata dopo', async () => {
  let { s, a1, a2 } = await base();
  let r = await C.addFund(s, ctx(), { name: 'X', kind: 'reserve', accountId: a1 }); s = r.state;
  const createdEntry = JSON.stringify(s.audit.at(-1));
  ({ state: s } = await C.relocateFund(s, ctx(), r.result, a2));
  assert.equal(JSON.stringify(s.audit.find((e) => e.seq === s.audit.at(-2).seq - 0 && e.action === 'create' && e.entity === 'fund')), createdEntry);
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
