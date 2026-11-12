// Verifica delle regole stabilite dall'utente (punti 1–4 e 6 della revisione), una per una.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot, pendingTransfers } from '../src/core/derive.js';
import { proposeAllocation } from '../src/core/allocation.js';
import { estimateTaxes, estimateAnnual } from '../src/core/tax.js';
import { monthlySeries, investedTotal } from '../src/core/analytics.js';
import { budgetStatus } from '../src/core/budget.js';
import { forecast } from '../src/core/forecast.js';
import { buildIcs } from '../src/core/ics.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { validateState } from '../src/core/validate.js';
import { migrateState } from '../src/core/state.js';
import { createEmptyState } from '../src/core/state.js';
import { addDays } from '../src/core/dates.js';
import { ctx, expectError, TODAY } from './helpers.js';

// Scenario dell'utente: accrediti su Isybank, tasse su Trade Republic, spese su Revolut.
async function scenario() {
  let s = createEmptyState(ctx());
  const mk = async (name, bank, cents) => { const r = await C.addAccount(s, ctx(), { name, bank, openingCents: cents, openingDate: '2026-01-01' }); s = r.state; return r.result; };
  const isy = await mk('Isybank', 'isybank', 80000), tr = await mk('Trade Republic', 'trade_republic', 120000), rev = await mk('Revolut', 'revolut', 25000);
  const r = await C.setupFreelanceProfile(s, ctx(), { taxAccountId: tr, weeklyBudgetCents: 22000 }); s = r.state;
  return { s, isy, tr, rev, taxFund: r.result };
}

// ─────────────── 1. Regole personalizzate di accantonamento ───────────────
const RULES = [['Cliente 1', 120000, 30000, 90000], ['Cliente 2', 70000, 16000, 54000], ['Cliente 3', 30000, 7000, 23000], ['Cliente 4', 90000, 22000, 68000]];
test('1. regole personalizzate per cliente: la riserva è fissa e il resto è disponibilità personale', async () => {
  let { s, isy, taxFund } = await scenario();
  for (const [client, cents, reserve] of RULES) ({ state: s } = await C.addInvoiceTemplate(s, ctx(), { client, cents, accountId: isy, reserveCents: reserve }));
  const exp = s.receivables.filter((r) => r.status === 'expected' && r.invoiceDate.startsWith('2026-06'));
  assert.equal(exp.length, 4);
  for (const [client, cents, reserve, personal] of RULES) {
    const r = exp.find((x) => x.client === client);
    assert.equal(r.reserveCents, reserve);                                   // la regola viaggia con l'incasso atteso
    const before = snapshot(s);
    ({ state: s } = await C.receiveReceivable(s, ctx(), { id: r.id, cents, date: TODAY }));
    const plan = proposeAllocation(s, { accountId: isy, cents, today: TODAY, professional: true, receivable: s.receivables.find((x) => x.id === r.id) });
    assert.equal(plan.items.length, 1, 'solo la riserva fiscale: il resto non va in altri fondi');
    assert.equal(plan.items[0].cents, reserve);
    assert.equal(plan.remainderCents, personal);                              // disponibilità personale
    assert.ok(plan.taxInfo.total > 0 && plan.taxInfo.custom === reserve);   // stima teorica distinta dalla regola
    ({ state: s } = await C.applyAllocationPlan(s, ctx(), plan.items));
    const after = snapshot(s);
    assert.equal(after.balances[isy], before.balances[isy] + cents);          // incasso registrato sul conto effettivo (Isybank)
    assert.equal(after.freeByAccount[isy], before.freeByAccount[isy] + personal); // il libero cresce della sola quota personale
  }
  const sn = snapshot(s);
  assert.equal(sn.funds[taxFund].available, 30000 + 16000 + 7000 + 22000);
  assert.equal(s.transfers.length, 0);
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('1. senza regola personalizzata si usa la stima teorica; i 300 € non vanno a nessun altro fondo anche se esiste un obiettivo scoperto', async () => {
  let { s, isy, tr } = await scenario();
  ({ state: s } = await C.addFund(s, ctx(), { name: 'Viaggio', kind: 'goal', accountId: tr, goal: { targetCents: 130000, priority: 1, deadline: addDays(TODAY, 20) } }));
  const rc = await C.addReceivable(s, ctx(), { client: 'X', expectedCents: 40000, expectedDate: TODAY, accountId: isy }); s = rc.state;
  ({ state: s } = await C.receiveReceivable(s, ctx(), { id: rc.result, cents: 40000 }));
  const plan = proposeAllocation(s, { accountId: isy, cents: 40000, today: TODAY, professional: true, receivable: s.receivables[0] });
  assert.equal(plan.items.length, 1); assert.equal(plan.items[0].reason, 'tax');
  assert.equal(plan.items[0].cents, 9000);   // 400 € → stima teorica (con deduzione contributi) ≈ 92,7 € → arrotondata a 90 €
  assert.ok(plan.remainderCents > 0);
});
test('1. la riserva non supera mai quanto incassato; un incasso molto inferiore al previsto è PARZIALE (quota proporzionale)', async () => {
  let { s, isy } = await scenario();
  const rc = await C.addReceivable(s, ctx(), { client: 'X', expectedCents: 120000, expectedDate: TODAY, accountId: isy, reserveCents: 30000 }); s = rc.state;
  ({ state: s } = await C.receiveReceivable(s, ctx(), { id: rc.result, cents: 20000 }));
  assert.equal(s.receivables[0].status, 'partial');
  const plan = proposeAllocation(s, { accountId: isy, cents: 20000, today: TODAY, professional: true, receivable: s.receivables[0] });
  assert.equal(plan.items[0].cents, 5000);                                    // 300 × 200/1.200
  assert.ok(plan.items[0].cents <= 20000);
  await expectError(C.addInvoiceTemplate(s, ctx(), { client: 'Y', cents: 10000, accountId: isy, reserveCents: 20000 }), 'stato_non_valido'); // riserva > fattura
});

// ─────────────── 2. Conti e trasferimenti ───────────────
test('2. una proposta di allocazione non registra mai trasferimenti; il bonifico esiste solo se confermato', async () => {
  let { s, isy, tr, taxFund } = await scenario();
  const rc = await C.addReceivable(s, ctx(), { client: 'X', expectedCents: 120000, expectedDate: TODAY, accountId: isy, reserveCents: 30000 }); s = rc.state;
  ({ state: s } = await C.receiveReceivable(s, ctx(), { id: rc.result, cents: 120000 }));
  const plan = proposeAllocation(s, { accountId: isy, cents: 120000, today: TODAY, professional: true, receivable: s.receivables[0] });
  ({ state: s } = await C.applyAllocationPlan(s, ctx(), plan.items));
  assert.equal(s.transfers.length, 0);
  const sn = snapshot(s);
  assert.deepEqual(pendingTransfers(s, sn), [{ fundId: taxFund, fromAccountId: isy, toAccountId: tr, cents: 30000 }]);
  assert.equal(sn.balances[tr], 120000);                                       // Trade Republic invariato finché non confermo
  // conferma parziale (es. faccio un primo bonifico di 200 €): il resto resta da confermare
  ({ state: s } = await C.confirmFundTransfer(s, ctx(), { fundId: taxFund, fromAccountId: isy, toAccountId: tr, cents: 20000, date: TODAY }));
  assert.equal(s.transfers.length, 1); assert.equal(snapshot(s).balances[tr], 140000);
  assert.deepEqual(pendingTransfers(s, snapshot(s)).map((p) => p.cents), [10000]);
  ({ state: s } = await C.confirmFundTransfer(s, ctx(), { fundId: taxFund, fromAccountId: isy, toAccountId: tr, cents: 10000 }));
  assert.deepEqual(pendingTransfers(s, snapshot(s)), []);
  assert.equal(snapshot(s).funds[taxFund].byAccount[tr], 30000);
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('2. conferma del bonifico: solo fino alla riserva esistente, data non futura, conti diversi', async () => {
  let { s, isy, tr, taxFund } = await scenario();
  ({ state: s } = await C.assignToFund(s, ctx(), taxFund, 10000, '', isy));
  await expectError(C.confirmFundTransfer(s, ctx(), { fundId: taxFund, fromAccountId: isy, toAccountId: tr, cents: 10001 }), 'riserva_insufficiente');
  await expectError(C.confirmFundTransfer(s, ctx(), { fundId: taxFund, fromAccountId: isy, toAccountId: tr, cents: 100, date: '2026-12-01' }), 'data_non_valida');
  await expectError(C.confirmFundTransfer(s, ctx(), { fundId: taxFund, fromAccountId: isy, toAccountId: isy, cents: 100 }), 'stesso_conto');
  await expectError(C.confirmFundTransfer(s, ctx(), { fundId: taxFund, fromAccountId: isy, toAccountId: tr, cents: 0 }), 'importo');
});
test('2. riserva su un conto: si può spendere dal fondo solo da un conto che la contiene', async () => {
  let { s, isy, tr, rev, taxFund } = await scenario();
  ({ state: s } = await C.assignToFund(s, ctx(), taxFund, 30000, '', isy));
  await expectError(C.addTransaction(s, ctx(), { accountId: tr, cents: -10000, kind: 'expense', fundId: taxFund, categoryId: 'cat_tax' }), 'fondo_insufficiente');
  await expectError(C.addTransaction(s, ctx(), { accountId: rev, cents: -10000, kind: 'expense', fundId: taxFund, categoryId: 'cat_tax' }), 'fondo_insufficiente');
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: isy, cents: -10000, kind: 'expense', fundId: taxFund, categoryId: 'cat_tax' }));
  assert.equal(snapshot(s).funds[taxFund].byAccount[isy], 20000);
  assert.equal(snapshot(s).freeByAccount[isy], 80000 - 10000 - 20000);
});
test('2. chiusura fondo e annullamento acquisto rilasciano la riserva conto per conto', async () => {
  let { s, isy, tr } = await scenario();
  let r = await C.addFund(s, ctx(), { name: 'G', kind: 'reserve', accountId: tr }); s = r.state;
  ({ state: s } = await C.assignToFund(s, ctx(), r.result, 10000, '', isy));
  ({ state: s } = await C.assignToFund(s, ctx(), r.result, 20000, '', tr));
  const free = snapshot(s).total - 30000;
  ({ state: s } = await C.closeFund(s, ctx(), r.result));
  assert.equal(snapshot(s).free, snapshot(s).total); assert.equal(snapshot(s).free, free + 30000);
  assert.equal(validateState(s).length, 0);
});

// ─────────────── 3. PAC = investimento, non spesa ───────────────
test('3. PAC: riduce la liquidità, non compare tra le spese né nel budget, è tracciato come investito', async () => {
  let { s, rev } = await scenario();
  ({ state: s } = await C.updateBudget(s, ctx(), { startDate: TODAY }));
  let r = await C.addPlanned(s, ctx(), { name: 'PAC', kind: 'investment', cents: 10000, dueDate: TODAY, accountId: rev, fundMode: 'none', recurrence: 'monthly', categoryId: 'cat_invest' }); s = r.state;
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: rev, cents: -4000, kind: 'expense', categoryId: 'cat_food', date: TODAY }));
  const bal = snapshot(s).balances[rev];
  ({ state: s } = await C.completePlanned(s, ctx(), { id: r.result }));
  const t = s.transactions.at(-1);
  assert.equal(t.kind, 'investment'); assert.equal(t.categoryId, 'cat_invest'); assert.equal(t.fundId, null);
  assert.equal(snapshot(s).balances[rev], bal - 10000);                           // incide sulla liquidità
  const m = monthlySeries(s, TODAY, 1)[0];
  assert.equal(m.expense, 4000); assert.equal(m.invested, 10000);                 // le spese NON sono falsate
  assert.equal(investedTotal(s), 10000);
  assert.equal(budgetStatus(s, TODAY).spentCents, 4000);                          // il PAC non consuma il budget settimanale
  assert.equal(s.planned[0].dueDate, '2026-07-15');                               // prossimo versamento
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('3. PAC: le uscite future entrano nella previsione di liquidità e un PAC non può attingere a un fondo', async () => {
  let { s, rev } = await scenario();
  ({ state: s } = await C.addPlanned(s, ctx(), { name: 'PAC', kind: 'investment', cents: 10000, dueDate: addDays(TODAY, 5), accountId: rev, fundMode: 'none', recurrence: 'monthly', categoryId: 'cat_invest' }));
  const f = forecast(s, TODAY, 90);
  assert.equal(f.events.filter((e) => e.kind === 'planned').length, 3);
  await expectError(C.addTransaction(s, ctx(), { accountId: rev, cents: -100, kind: 'investment', fundId: s.funds[0].id, categoryId: 'cat_invest' }), 'fondo_solo_uscite');
});
test('3. migrazione: i vecchi movimenti "Investimenti (PAC)" registrati come spese diventano investimenti', async () => {
  let { s, rev } = await scenario();
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: rev, cents: -10000, kind: 'expense', categoryId: 'cat_invest', date: TODAY }));
  const old = structuredClone(s); old.categories.find((c) => c.id === 'cat_invest').kind = 'expense';
  migrateState(old);
  assert.equal(old.transactions.at(-1).kind, 'investment'); assert.deepEqual(validateState(old), []);
});

// ─────────────── 4. Verifica fiscale: stima per fattura ≠ debito annuale ───────────────
const P = { coefficientBp: 7800, inpsBp: 2607, taxBp: 500, roundStepCents: 1000 };
async function year(incomes, inpsPaid = 0, taxPaid = 0) {
  let { s, isy, taxFund } = await scenario();
  for (const [i, c] of incomes.entries()) ({ state: s } = await C.addTransaction(s, ctx(), { accountId: isy, cents: c, kind: 'income', categoryId: 'cat_pro', date: `2026-0${i + 1}-10` }));
  if (inpsPaid) ({ state: s } = await C.addTransaction(s, ctx(), { accountId: isy, cents: -inpsPaid, kind: 'expense', categoryId: 'cat_inps', date: '2026-06-01' }));
  if (taxPaid) ({ state: s } = await C.addTransaction(s, ctx(), { accountId: isy, cents: -taxPaid, kind: 'expense', categoryId: 'cat_tax', date: '2026-06-02' }));
  return { s, taxFund, isy };
}
test('4. debito annuale: calcolato sul cumulato dell\'anno (per cassa), non sommando stime per fattura con deduzioni', async () => {
  const { s } = await year([120000, 70000, 30000, 90000]);                      // 3.100 € incassati
  const a = estimateAnnual(s, 2026);
  assert.equal(a.ricavi, 310000); assert.equal(a.base, 241800);                  // 3.100 × 78%
  assert.equal(a.inpsDue, 63037);                                                // 2.418 × 26,07% = 630,37
  assert.equal(a.impostaDue, 8938);                                              // (2.418 − 630,37) × 5%: contributi maturati sullo stesso reddito (metodo predefinito)
  assert.equal(a.totalDue, 63037 + 8938);
  const sumPerInvoice = [120000, 70000, 30000, 90000].map((c) => estimateTaxes(c, P).total).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sumPerInvoice - a.totalDue) <= 4);                          // somma per fattura e cumulato annuale coincidono (a meno di arrotondamenti)
});
test('4. metodo "versati": i contributi riducono l\'imponibile SOLO se effettivamente versati nell\'anno', async () => {
  const strict = (s) => { s.settings.taxProfile.inpsDeduction = 'paid'; return s; };
  const none = estimateAnnual(strict((await year([120000, 70000, 30000, 90000])).s), 2026);
  const paid = estimateAnnual(strict((await year([120000, 70000, 30000, 90000], 30000)).s), 2026);
  assert.equal(paid.inpsPaid, 30000);
  assert.equal(paid.impostaDue, Math.round((241800 - 30000) * 0.05));            // (imponibile − contributi versati) × 5%
  assert.ok(paid.impostaDue < none.impostaDue);
  assert.equal(paid.inpsDue, none.inpsDue);                                      // i contributi maturati NON si deducono da sé stessi
  assert.equal(paid.impostaIfAllInpsPaid, Math.round((241800 - 63037) * 0.05));  // scenario: tutti versati nell'anno
  assert.ok(paid.impostaIfAllInpsPaid < paid.impostaDue);
  assert.equal(paid.stillDue, paid.totalDue - 30000);
});
test('4. i versamenti effettuati riducono il dovuto residuo; altre entrate e altri anni non contano', async () => {
  let { s, isy } = await year([120000], 10000, 5000);
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: isy, cents: 500000, kind: 'income', categoryId: 'cat_in_other', date: '2026-02-01' }));
  const a = estimateAnnual(s, 2026);
  assert.equal(a.ricavi, 120000); assert.equal(a.paid, 15000);
  assert.equal(a.stillDue, a.totalDue - 15000);
  assert.equal(estimateAnnual(s, 2025).ricavi, 0);
});
test('4. stima per singola fattura: imposta su (reddito − INPS maturati); col metodo "versati" nessuna deduzione', () => {
  const t = estimateTaxes(120000, P);
  assert.equal(t.imposta, 3460); assert.equal(t.total, 24402 + 3460);
  const u = estimateTaxes(120000, { ...P, inpsDeduction: 'paid' });
  assert.equal(u.imposta, 4680); assert.equal(u.total, 24402 + 4680);
});

// ─────────────── 6. Calendario: duplicati e aggiornamenti ───────────────
const parse = (ics) => ics.replaceAll('\r\n ', '').split('\r\n').filter(Boolean);
function events(ics) {
  const L = parse(ics); const out = []; let cur = null;
  for (const l of L) { if (l === 'BEGIN:VEVENT') cur = {}; else if (l === 'END:VEVENT') { out.push(cur); cur = null; } else if (cur && !/^(BEGIN|END):VALARM/.test(l)) { const i = l.indexOf(':'); const k = l.slice(0, i).split(';')[0]; if (!(k in cur)) cur[k] = l.slice(i + 1); } }
  return out;
}
async function icsState() {
  let { s, rev, isy } = await scenario();
  let r = await C.addPlanned(s, ctx(), { name: 'Claude', kind: 'subscription', cents: 2500, dueDate: '2026-06-20', accountId: rev, fundMode: 'none', recurrence: 'monthly' }); s = r.state;
  ({ state: s } = await C.addPlanned(s, ctx(), { name: 'Rinnovo', kind: 'renewal', cents: 30000, dueDate: '2026-09-01', accountId: rev, fundMode: 'none', recurrence: 'yearly' }));
  ({ state: s } = await C.addInvoiceTemplate(s, ctx(), { client: 'Cliente', cents: 120000, accountId: isy }));
  return { s, planId: r.result, rev };
}
test('6. calendario: UID univoci e stabili tra esportazioni successive (nessun duplicato)', async () => {
  const { s } = await icsState();
  const a = events(buildIcs(s, { today: TODAY, nowIso: '2026-06-15T10:00:00.000Z' }));
  const b = events(buildIcs(s, { today: TODAY, nowIso: '2026-06-16T08:30:00.000Z' }));
  const uids = (e) => e.map((x) => x.UID).sort();
  assert.equal(new Set(uids(a)).size, a.length);                                  // nessun UID ripetuto nel file
  assert.deepEqual(uids(a), uids(b));                                             // stessi UID a ogni esportazione
  assert.ok(a.every((e) => /^fp-(planned|invoice|receivable|goal)-.+@finanze\.local$/.test(e.UID)));
});
test('6. calendario: modificare importo/data mantiene lo stesso UID e aumenta SEQUENCE', async () => {
  let { s, planId } = await icsState();
  const before = events(buildIcs(s, { today: TODAY, nowIso: '2026-06-15T10:00:00.000Z' })).find((e) => e.UID.includes(planId));
  ({ state: s } = await C.updatePlanned(s, ctx(), planId, { dueDate: '2026-06-25', cents: 2900 }));
  const after = events(buildIcs(s, { today: TODAY, nowIso: '2026-06-15T11:00:00.000Z', includeAmounts: true })).find((e) => e.UID.includes(planId));
  assert.equal(after.UID, before.UID);
  assert.ok(Number(after.SEQUENCE) > Number(before.SEQUENCE));
  assert.equal(after['DTSTART'], '20260625'); assert.notEqual(after.DTSTAMP, before.DTSTAMP);
});
test('6. calendario: pagato (non ricorrente), annullato o disattivato → STATUS:CANCELLED con lo stesso UID', async () => {
  let { s, rev } = await icsState();
  let r = await C.addPlanned(s, ctx(), { name: 'Una tantum', kind: 'purchase', cents: 5000, dueDate: '2026-06-20', accountId: rev, fundMode: 'none' }); s = r.state;
  const uid = `fp-planned-${r.result}@finanze.local`;
  assert.ok(!events(buildIcs(s, { today: TODAY })).find((e) => e.UID === uid).STATUS);
  ({ state: s } = await C.completePlanned(s, ctx(), { id: r.result }));
  const e = events(buildIcs(s, { today: TODAY })).find((x) => x.UID === uid);
  assert.equal(e.STATUS, 'CANCELLED');
  const tpl = s.invoiceTemplates[0];
  ({ state: s } = await C.updateInvoiceTemplate(s, ctx(), tpl.id, { active: false }));
  assert.equal(events(buildIcs(s, { today: TODAY })).find((x) => x.UID === `fp-invoice-${tpl.id}@finanze.local`).STATUS, 'CANCELLED');
});
test('6. calendario: un incasso segnato "incassato" non genera più il promemoria', async () => {
  let { s, isy } = await icsState();
  const rc = s.receivables.find((r) => r.status === 'expected');
  ({ state: s } = await C.receiveReceivable(s, ctx(), { id: rc.id, cents: 120000, date: TODAY }));
  assert.equal(events(buildIcs(s, { today: TODAY })).find((e) => e.UID === `fp-receivable-${rc.id}@finanze.local`)?.STATUS, 'CANCELLED');
  void isy;
});
test('6. calendario: formato valido (CRLF, righe ≤ 75 byte, allarmi, RRULE) e nessun importo di default', async () => {
  const { s } = await icsState();
  const ics = buildIcs(s, { today: TODAY, nowIso: '2026-06-15T10:00:00.000Z' });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  for (const l of ics.split('\r\n')) assert.ok(new TextEncoder().encode(l).length <= 75);
  assert.match(ics, /DTSTAMP:20260615T100000Z/); assert.match(ics, /RRULE:FREQ=YEARLY/); assert.match(ics, /BEGIN:VALARM/);
  assert.doesNotMatch(ics, /25,00|1\.200|1200/);
});
