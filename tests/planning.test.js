import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot } from '../src/core/derive.js';
import { budgetStatus } from '../src/core/budget.js';
import { proposeAllocation } from '../src/core/allocation.js';
import { forecast } from '../src/core/forecast.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { base, ctx, expectError, TODAY } from './helpers.js';

const exp = (s, a, cents, date, cat = 'cat_food') => C.addTransaction(s, ctx(), { accountId: a, cents: -cents, kind: 'expense', categoryId: cat, date });

test('budget: il residuo si calcola dalle spese della settimana (lun 15 giu 2026)', async () => {
  let { s, a1 } = await base();
  ({ state: s } = await C.updateBudget(s, ctx(), { weeklyCents: 15000, startDate: '2026-06-15' }));
  ({ state: s } = await exp(s, a1, 4000, '2026-06-15'));
  const b = budgetStatus(s, TODAY);
  assert.equal(b.spentCents, 4000); assert.equal(b.remainingCents, 11000); assert.equal(b.carryCents, 0);
});
test('budget: l\'avanzo si riporta; il disavanzo si riporta solo se configurato', async () => {
  let { s, a1 } = await base();
  ({ state: s } = await C.updateBudget(s, ctx(), { weeklyCents: 10000, startDate: '2026-06-01' }));
  ({ state: s } = await exp(s, a1, 3000, '2026-06-02')); // sett. 1: avanzo 7000
  ({ state: s } = await exp(s, a1, 14000, '2026-06-09')); // sett. 2: 10000+7000-14000 = disavanzo -? => 3000 residuo
  ({ state: s } = await exp(s, a1, 20000, '2026-06-10')); // sett. 2 totale 34000 → residuo -17000
  let b = budgetStatus(s, TODAY); // sett. 3 (15 giu): carry = -17000
  assert.equal(b.carryCents, -17000); assert.equal(b.remainingCents, 10000 - 17000);
  ({ state: s } = await C.updateBudget(s, ctx(), { carryDeficit: false }));
  b = budgetStatus(s, TODAY); assert.equal(b.carryCents, 0); assert.equal(b.remainingCents, 10000);
  ({ state: s } = await C.updateBudget(s, ctx(), { carryOver: false }));
  assert.equal(budgetStatus(s, TODAY).carryCents, 0);
});
test('budget: spese pagate da un fondo o in categorie escluse non pesano sul budget', async () => {
  let { s, a1 } = await base();
  ({ state: s } = await C.updateBudget(s, ctx(), { weeklyCents: 10000, startDate: '2026-06-15' }));
  let r = await C.addFund(s, ctx(), { name: 'F', kind: 'reserve', accountId: a1 }); s = r.state;
  ({ state: s } = await C.assignToFund(s, ctx(), r.result, 20000));
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a1, cents: -5000, kind: 'expense', fundId: r.result, categoryId: 'cat_shop', date: '2026-06-15' }));
  ({ state: s } = await exp(s, a1, 62000, '2026-06-15', 'cat_home')); // affitto: fuori budget
  ({ state: s } = await C.addTransfer(s, ctx(), { fromAccountId: a1, toAccountId: (await base()).a2 === a1 ? a1 : s.accounts[1].id, cents: 1000, date: '2026-06-15' }));
  assert.equal(budgetStatus(s, TODAY).spentCents, 0);
});
test('incasso professionale: atteso non tocca il saldo; ricevuto crea il movimento con importo EFFETTIVO', async () => {
  let { s, a1 } = await base();
  let r = await C.addReceivable(s, ctx(), { client: 'Cliente', expectedCents: 100000, expectedDate: '2026-06-20', accountId: a1 }); s = r.state;
  assert.equal(snapshot(s).total, 150000); assert.equal(s.transactions.length, 0);
  const rec = await C.receiveReceivable(s, ctx(), { id: r.result, cents: 95000, date: '2026-06-14' }); s = rec.state;
  assert.equal(snapshot(s).balances[a1], 195000);
  assert.equal(s.receivables[0].status, 'partial');                    // 950 su 1.000: PARZIALE, restano 50
  assert.equal(s.receivables[0].receivedCents, 95000);
  assert.ok(s.audit.some((e) => e.action === 'receive' && /restano/.test(e.note)));
  ({ state: s } = await C.closeReceivable(s, ctx(), r.result, 'saldo definitivo'));  // importo definitivo inferiore
  assert.equal(s.receivables[0].status, 'received');
  assert.ok(s.audit.some((e) => e.action === 'close' && /95/.test(e.note)));
  await expectError(C.receiveReceivable(s, ctx(), { id: r.result, cents: 100 }), 'non_atteso'); // niente doppio incasso su una fattura chiusa
  // annullando il movimento l'incasso torna "atteso": nessun denaro fantasma
  ({ state: s } = await C.voidTransaction(s, ctx(), rec.result, 'Registrato per errore'));
  assert.equal(s.receivables[0].status, 'expected'); assert.equal(snapshot(s).total, 150000);
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('allocazione: tasse prima, poi urgenze, poi priorità; somma = importo; mai oltre il libero né il fabbisogno', async () => {
  let { s, a1 } = await base();
  const mk = async (name, kind, goal) => { const r = await C.addFund(s, ctx(), { name, kind, accountId: a1, goal }); s = r.state; return r.result; };
  const tax = await mk('Tasse', 'tax');
  const low = await mk('Bassa', 'goal', { targetCents: 50000, priority: 3, deadline: null });
  const high = await mk('Alta', 'goal', { targetCents: 30000, priority: 1, deadline: '2026-12-31' });
  const urgent = await mk('Urgente', 'goal', { targetCents: 20000, priority: 3, deadline: '2026-06-30' });
  ({ state: s } = await C.setTaxRules(s, ctx(), [{ name: 'Imposte', bp: 2500, fundId: tax }]));
  const p = proposeAllocation(s, { accountId: a1, cents: 100000, today: TODAY });
  assert.deepEqual(p.items.map((i) => [i.name, i.cents, i.reason]), [['Tasse', 25000, 'tax'], ['Urgente', 20000, 'urgent'], ['Alta', 30000, 'priority'], ['Bassa', 25000, 'priority']]);
  assert.equal(p.allocatedCents + p.remainderCents, 100000);
  assert.deepEqual(proposeAllocation(s, { accountId: a1, cents: 100000, today: TODAY }), p); // deterministico
  ({ state: s } = await C.applyAllocationPlan(s, ctx(), p.items));
  assert.equal(snapshot(s).freeByAccount[a1], 0);
  assert.equal(proposeAllocation(s, { accountId: a1, cents: 5000, today: TODAY }).allocatedCents, 0); // niente libero
});
test('allocazione: mai oltre il libero effettivo del conto', async () => {
  let { s, a1 } = await base();
  const r = await C.addFund(s, ctx(), { name: 'G', kind: 'goal', accountId: a1, goal: { targetCents: 900000, priority: 1, deadline: null } }); s = r.state;
  const p = proposeAllocation(s, { accountId: a1, cents: 10_000_000, today: TODAY });
  assert.equal(p.allocatedCents, 100000); assert.equal(p.cappedByFree, true);
});
test('piano di allocazione applicato in modo atomico: se una voce fallisce non cambia nulla', async () => {
  let { s, a1 } = await base();
  let r = await C.addFund(s, ctx(), { name: 'A', kind: 'reserve', accountId: a1 }); s = r.state;
  const j = JSON.stringify(s);
  await expectError(C.applyAllocationPlan(s, ctx(), [{ fundId: r.result, cents: 60000 }, { fundId: r.result, cents: 60000 }]), 'libero_insufficiente');
  assert.equal(JSON.stringify(s), j);
});
test('previsione: gli incassi non ricevuti NON sono mai disponibili (serie prudente) ma compaiono nello scenario informativo', async () => {
  let { s, a1 } = await base(); // totale 1500,00
  ({ state: s } = await C.addReceivable(s, ctx(), { client: 'C', expectedCents: 400000, expectedDate: '2026-06-20', accountId: a1 }));
  const f = forecast(s, TODAY, 30);
  assert.equal(f.points.at(-1).total, 150000); assert.equal(f.points.at(-1).free, 150000);
  assert.equal(f.points.at(-1).totalWithExpected, 550000);
  assert.ok(f.events.some((e) => e.kind === 'receivable' && e.prudent === false));
});
test('previsione: incasso in ritardo non conta e viene segnalato; scoperto previsto segnalato', async () => {
  let { s, a1 } = await base();
  ({ state: s } = await C.addReceivable(s, ctx(), { client: 'Ritardatario', expectedCents: 80000, expectedDate: '2026-06-01', accountId: a1 }));
  ({ state: s } = await C.addPlanned(s, ctx(), { name: 'Spesa grossa', cents: 200000, dueDate: '2026-06-25', accountId: a1, fundMode: 'none' }));
  const f = forecast(s, TODAY, 60);
  assert.ok(f.issues.some((i) => i.kind === 'receivable_overdue'));
  const neg = f.issues.find((i) => i.kind === 'free_negative');
  assert.ok(neg); assert.equal(neg.date, '2026-06-25'); assert.equal(neg.cents, 150000 - 200000);
  assert.equal(f.minFree, -50000);
});
test('previsione: la parte di acquisto coperta da un fondo non pesa sulla liquidità libera', async () => {
  let { s, a1 } = await base();
  let r = await C.addPlanned(s, ctx(), { name: 'PC', cents: 120000, dueDate: '2026-06-25', accountId: a1, fundMode: 'new' }); s = r.state;
  const fund = s.funds[0];
  ({ state: s } = await C.assignToFund(s, ctx(), fund.id, 70000));
  const f = forecast(s, TODAY, 30);
  const ev = f.events.find((e) => e.kind === 'planned');
  assert.equal(ev.total, -120000); assert.equal(ev.free, -50000);
  assert.equal(f.points.at(-1).total, 30000); assert.equal(f.points.at(-1).free, 30000); // 150000 − 70000 vincolati − 50000 non coperti
});
test('acquisto programmato: completarlo spende dal fondo, rilascia il residuo e chiude il fondo', async () => {
  let { s, a1 } = await base();
  let r = await C.addPlanned(s, ctx(), { name: 'Bici', cents: 50000, dueDate: '2026-06-20', accountId: a1 }); s = r.state;
  ({ state: s } = await C.assignToFund(s, ctx(), s.funds[0].id, 60000)); // sovra-assegnato di proposito
  ({ state: s } = await C.completePlanned(s, ctx(), { id: r.result, cents: 48000 }));
  const sn = snapshot(s);
  assert.equal(sn.balances[a1], 100000 - 48000);
  assert.equal(s.funds[0].archived, true); assert.equal(sn.funds[s.funds[0].id].available, 0);
  assert.equal(sn.freeByAccount[a1], 52000); // il residuo è tornato libero
  assert.equal(s.planned[0].status, 'done');
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('acquisto ricorrente: dopo il pagamento la scadenza avanza senza deriva', async () => {
  let { s, a1 } = await base();
  let r = await C.addPlanned(s, ctx(), { name: 'Assicurazione', cents: 30000, dueDate: '2026-01-31', accountId: a1, fundMode: 'none', recurrence: 'monthly' }); s = r.state;
  ({ state: s } = await C.completePlanned(s, ctx(), { id: r.result, date: '2026-06-10' }));
  assert.equal(s.planned[0].dueDate, '2026-02-28'); assert.equal(s.planned[0].status, 'planned');
});
test('regola fiscale: l\'accantonamento è un\'allocazione virtuale, distinguibile da un trasferimento bancario', async () => {
  let { s, a1 } = await base();
  let r = await C.addFund(s, ctx(), { name: 'Tasse', kind: 'tax', accountId: a1 }); s = r.state;
  ({ state: s } = await C.setTaxRules(s, ctx(), [{ name: 'Imposte', bp: 3000, fundId: r.result }]));
  const rc = await C.addReceivable(s, ctx(), { client: 'X', expectedCents: 100000, expectedDate: TODAY, accountId: a1 }); s = rc.state;
  ({ state: s } = await C.receiveReceivable(s, ctx(), { id: rc.result, cents: 100000 }));
  const plan = proposeAllocation(s, { accountId: a1, cents: 100000, today: TODAY });
  assert.equal(plan.items[0].cents, 30000);
  ({ state: s } = await C.applyAllocationPlan(s, ctx(), plan.items));
  assert.equal(s.transfers.length, 0); // nessun trasferimento bancario
  assert.equal(s.allocations.length, 1); assert.equal(s.allocations[0].kind, 'assign');
  const sn = snapshot(s);
  assert.equal(sn.free, 250000 - 30000); // denaro personale spendibile esclude l'accantonamento
  assert.equal(sn.reservedByKind.tax, 30000);
});
