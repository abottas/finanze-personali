import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot, pendingTransfers } from '../src/core/derive.js';
import { estimateTaxes, suggestedSetAside, roundToStep } from '../src/core/tax.js';
import { proposeAllocation, monthlyPace } from '../src/core/allocation.js';
import { monthlySeries, categoryBreakdown } from '../src/core/analytics.js';
import { buildIcs } from '../src/core/ics.js';
import { forecast } from '../src/core/forecast.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { validateState } from '../src/core/validate.js';
import { migrateState } from '../src/core/state.js';
import { base, ctx, expectError, TODAY } from './helpers.js';

const PROFILE = { coefficientBp: 7800, inpsBp: 2607, taxBp: 500, deductInps: false, roundStepCents: 1000 };

test('forfettario + Gestione Separata: esempio fattura 1.200 €', () => {
  const t = estimateTaxes(120000, PROFILE);
  assert.equal(t.base, 93600);           // 936,00 € imponibile (78%)
  assert.equal(t.inps, 24402);           // 26,07% di 936 = 244,02 (244,0152 arrotondato)
  assert.equal(t.imposta, 4680);         // 5% di 936 = 46,80
  assert.equal(t.total, 29082);
  assert.equal(t.netAfter, 90918);
});
test('stima per singola fattura: nessuna deduzione arbitraria dei contributi (la deduzione è solo annuale, sui versamenti reali)', () => {
  const t = estimateTaxes(120000, { ...PROFILE, deductInps: true }); // un eventuale flag residuo viene ignorato
  assert.equal(t.imposta, 4680);
});
test('accantonamento suggerito: arrotondato al passo scelto, mai oltre l\'importo', () => {
  assert.equal(suggestedSetAside(70000, PROFILE).setAside, 17000);       // 169,64 → 170
  assert.equal(suggestedSetAside(120000, PROFILE).setAside, 29000);      // 290,82 → 290
  assert.equal(suggestedSetAside(120000, { ...PROFILE, roundStepCents: 5000 }).setAside, 30000);
  assert.equal(suggestedSetAside(100, PROFILE).setAside <= 100, true);
  assert.equal(roundToStep(1234, 1), 1234);
});
test('nessun errore di arrotondamento: percentuali sempre in aritmetica intera', () => {
  for (let c = 1; c < 3000; c += 7) { const t = estimateTaxes(c, PROFILE); assert.ok(Number.isInteger(t.total) && t.total >= 0 && t.total <= c); }
});

async function freelanceSetup() {
  let { s, a1, a2 } = await base(); // a1 = accrediti, a2 = conto tasse
  let r = await C.setupFreelanceProfile(s, ctx(), { taxAccountId: a2, weeklyBudgetCents: 22000 }); s = r.state;
  return { s, a1, a2, taxFund: r.result };
}
test('incasso professionale: la riserva è VIRTUALE sul conto di accredito; nessun bonifico registrato', async () => {
  let { s, a1, a2, taxFund } = await freelanceSetup();
  let r = await C.addReceivable(s, ctx(), { client: 'Cliente', expectedCents: 120000, expectedDate: TODAY, accountId: a1 }); s = r.state;
  ({ state: s } = await C.receiveReceivable(s, ctx(), { id: r.result, cents: 120000 }));
  const before = JSON.stringify(s);
  const plan = proposeAllocation(s, { accountId: a1, cents: 120000, today: TODAY, professional: true });
  assert.equal(JSON.stringify(s), before);                        // la proposta non modifica nulla
  assert.equal(plan.items.length, 1); assert.equal(plan.items[0].cents, 29000);
  assert.equal(plan.items[0].accountId, a1); assert.equal(plan.items[0].pendingTransferTo, a2);
  ({ state: s } = await C.applyAllocationPlan(s, ctx(), plan.items));
  assert.equal(s.transfers.length, 0);                            // NESSUN trasferimento registrato come eseguito
  const sn = snapshot(s);
  assert.equal(sn.balances[a1], 100000 + 120000); assert.equal(sn.balances[a2], 50000); // i saldi bancari non cambiano
  assert.equal(sn.funds[taxFund].byAccount[a1], 29000);           // la riserva pesa sul conto dove sono i soldi
  assert.equal(sn.freeByAccount[a1], 220000 - 29000);
  assert.deepEqual(pendingTransfers(s, sn), [{ fundId: taxFund, fromAccountId: a1, toAccountId: a2, cents: 29000 }]);
  // solo dopo la CONFERMA del bonifico nasce il trasferimento reale e la riserva segue il denaro
  ({ state: s } = await C.confirmFundTransfer(s, ctx(), { fundId: taxFund, fromAccountId: a1, toAccountId: a2, cents: 29000, date: TODAY }));
  const sn2 = snapshot(s);
  assert.equal(s.transfers.length, 1); assert.equal(s.transfers[0].purpose, 'fund');
  assert.equal(sn2.balances[a1], 220000 - 29000); assert.equal(sn2.balances[a2], 50000 + 29000);
  assert.equal(sn2.funds[taxFund].byAccount[a2], 29000); assert.equal(sn2.funds[taxFund].byAccount[a1] ?? 0, 0);
  assert.equal(sn2.total, sn.total); assert.deepEqual(pendingTransfers(s, sn2), []);
  assert.equal(sn2.freeByAccount[a1], sn.freeByAccount[a1]);      // il libero personale non cambia
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('l\'utente può tenere più o meno del suggerito: il piano è modificabile (virtuale)', async () => {
  let { s, a1, taxFund } = await freelanceSetup();
  ({ state: s } = await C.applyAllocationPlan(s, ctx(), [{ fundId: taxFund, cents: 30000, accountId: a1 }]));
  assert.equal(snapshot(s).funds[taxFund].available, 30000); assert.equal(s.transfers.length, 0);
});
test('allocazione virtuale: non si riserva più del libero del conto di accredito', async () => {
  let { s, a1, taxFund } = await freelanceSetup();
  await expectError(C.applyAllocationPlan(s, ctx(), [{ fundId: taxFund, cents: 999999, accountId: a1 }]), 'libero_insufficiente');
});
test('anche gli obiettivi su un altro conto (es. risparmio) si finanziano con trasferimento', async () => {
  let { s, a1, a2 } = await freelanceSetup();
  const r = await C.addFund(s, ctx(), { name: 'Viaggio', kind: 'goal', accountId: a2, goal: { targetCents: 130000, priority: 1, deadline: '2026-12-30' }, icon: '✈️', color: 'blue' }); s = r.state;
  const p = proposeAllocation(s, { accountId: a1, cents: 50000, today: TODAY });
  assert.equal(p.items[0].fundId, r.result); assert.equal(p.items[0].accountId, a1); assert.equal(p.items[0].pendingTransferTo, a2); // virtuale: bonifico da confermare
  assert.equal(p.items[0].icon, '✈️');
});
test('ritmo mensile: quanto mettere da parte al mese per arrivare alla scadenza', async () => {
  let { s, a2 } = await freelanceSetup();
  const r = await C.addFund(s, ctx(), { name: 'Viaggio', kind: 'goal', accountId: a2, goal: { targetCents: 130000, priority: 1, deadline: '2026-12-30' } }); s = r.state;
  const f = s.funds.find((x) => x.id === r.result);
  const pace = monthlyPace(s, f, snapshot(s), TODAY); // 15 giu → 30 dic: 6 mesi + 15 gg → 7 rate
  assert.equal(pace, Math.ceil(130000 / 7));
  assert.equal(monthlyPace(s, s.funds[0], snapshot(s), TODAY), null); // fondo senza scadenza
});
test('reintegro: fondo con riserva oltre il saldo del suo conto → segnalato; il trasferimento lo ripara', async () => {
  let { s, a1, a2, taxFund } = await freelanceSetup();
  ({ state: s } = await C.assignToFund(s, ctx(), taxFund, 30000));              // 300 € riservati su a2 (saldo 500)
  ({ state: s } = await C.addTransfer(s, ctx(), { fromAccountId: a2, toAccountId: a1, cents: 40000, date: '2026-06-10' })); // anticipo preso dal conto tasse
  assert.ok(snapshot(s).freeByAccount[a2] < 0);
  assert.ok(forecast(s, TODAY, 30).issues.some((i) => i.kind === 'account_overcommitted' && i.refId === a2));
  ({ state: s } = await C.addTransfer(s, ctx(), { fromAccountId: a1, toAccountId: a2, cents: 40000, date: TODAY }));
  assert.ok(snapshot(s).freeByAccount[a2] >= 0);
  assert.ok(!forecast(s, TODAY, 30).issues.some((i) => i.kind === 'account_overcommitted'));
});

// ───────── Fatture ricorrenti (il 27 di ogni mese, incasso dopo ~12 giorni) ─────────
test('fatture ricorrenti: generano gli incassi attesi dei prossimi mesi, idempotente', async () => {
  let { s, a1 } = await base();
  let r = await C.addInvoiceTemplate(s, ctx(), { client: 'Cliente A', cents: 120000, invoiceDay: 27, collectDays: 12, accountId: a1 }); s = r.state;
  const exp = s.receivables.filter((x) => x.status === 'expected').sort((a, b) => (a.expectedDate < b.expectedDate ? -1 : 1));
  assert.ok(exp.length >= 2);
  const jun = exp.find((x) => x.invoiceDate === '2026-06-27');
  assert.equal(jun.expectedDate, '2026-07-09'); assert.equal(jun.expectedCents, 120000);
  const n = s.receivables.length;
  ({ state: s } = await C.materializeInvoices(s, ctx()));
  assert.equal(s.receivables.length, n); // nessun duplicato
  assert.equal(validateState(s).length, 0);
});
test('fatture ricorrenti: gli incassi attesi non toccano i saldi; la modifica aggiorna quelli futuri', async () => {
  let { s, a1 } = await base();
  const tot = snapshot(s).total;
  let r = await C.addInvoiceTemplate(s, ctx(), { client: 'A', cents: 50000, accountId: a1 }); s = r.state;
  assert.equal(snapshot(s).total, tot);
  ({ state: s } = await C.updateInvoiceTemplate(s, ctx(), r.result, { cents: 60000 }));
  assert.ok(s.receivables.filter((x) => x.status === 'expected').every((x) => x.expectedCents === 60000));
});
test('fatture ricorrenti: un incasso già ricevuto non viene toccato né rigenerato', async () => {
  let { s, a1 } = await base();
  let r = await C.addInvoiceTemplate(s, ctx(), { client: 'A', cents: 50000, invoiceDay: 10, collectDays: 5, accountId: a1 }); s = r.state;
  const rc = s.receivables.find((x) => x.templateKey && x.expectedDate >= '2026-06-01');
  ({ state: s } = await C.receiveReceivable(s, ctx(), { id: rc.id, cents: 48000, date: TODAY }));
  ({ state: s } = await C.updateInvoiceTemplate(s, ctx(), r.result, { cents: 70000 }));
  assert.equal(s.receivables.find((x) => x.id === rc.id).receivedCents, 48000);
  assert.equal(s.receivables.filter((x) => x.templateKey === rc.templateKey).length, 1);
});
test('fatture ricorrenti: parametri validi', async () => {
  const { s, a1 } = await base();
  await expectError(C.addInvoiceTemplate(s, ctx(), { client: 'A', cents: 100, invoiceDay: 31, accountId: a1 }), 'giorno');
  await expectError(C.addInvoiceTemplate(s, ctx(), { client: 'A', cents: 0, accountId: a1 }), 'importo');
});

// ───────── Spese ricorrenti e scadenze ─────────
test('abbonamento mensile e corso: dopo il pagamento la scadenza avanza; settimanale di 7 giorni', async () => {
  let { s, a1 } = await base();
  let r = await C.addPlanned(s, ctx(), { name: 'Claude', kind: 'subscription', cents: 2500, dueDate: '2026-06-15', accountId: a1, fundMode: 'none', recurrence: 'monthly', categoryId: 'cat_subs', autoPay: true }); s = r.state;
  ({ state: s } = await C.completePlanned(s, ctx(), { id: r.result }));
  assert.equal(s.planned[0].dueDate, '2026-07-15'); assert.equal(s.planned[0].status, 'planned');
  assert.equal(s.transactions[0].categoryId, 'cat_subs'); assert.equal(s.transactions[0].cents, -2500);
  r = await C.addPlanned(s, ctx(), { name: 'Spesa', cents: 22000, dueDate: '2026-06-15', accountId: a1, fundMode: 'none', recurrence: 'weekly' }); s = r.state;
  ({ state: s } = await C.completePlanned(s, ctx(), { id: r.result }));
  assert.equal(s.planned[1].dueDate, '2026-06-22');
});
test('le ricorrenze alimentano la previsione (mensile e settimanale)', async () => {
  let { s, a1 } = await base();
  ({ state: s } = await C.addPlanned(s, ctx(), { name: 'PAC', kind: 'investment', cents: 10000, dueDate: '2026-06-20', accountId: a1, fundMode: 'none', recurrence: 'monthly', categoryId: 'cat_invest' }));
  const f = forecast(s, TODAY, 90);
  assert.equal(f.events.filter((e) => e.kind === 'planned').length, 3); // 20/6, 20/7, 20/8 (il 20/9 è oltre i 90 giorni)
  assert.equal(f.points.at(-1).total, 150000 - 30000);
});
test('calendario .ics: eventi ricorrenti con allarmi, senza importi se non richiesti, righe ≤ 75 byte', async () => {
  let { s, a1 } = await base();
  ({ state: s } = await C.addPlanned(s, ctx(), { name: 'Abbonamento Claude con un nome molto molto lungo per forzare la piegatura della riga ICS, vediamo', kind: 'subscription', cents: 2500, dueDate: '2026-06-20', accountId: a1, fundMode: 'none', recurrence: 'monthly', remindDays: 2 }));
  ({ state: s } = await C.addInvoiceTemplate(s, ctx(), { client: 'Cliente; "A", B', cents: 120000, accountId: a1 }));
  const ics = buildIcs(s, { today: TODAY });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR') && ics.trimEnd().endsWith('END:VCALENDAR'));
  assert.match(ics, /RRULE:FREQ=MONTHLY/); assert.match(ics, /TRIGGER:-P2DT15H/); assert.match(ics, /TRIGGER:PT9H/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260620/);
  assert.doesNotMatch(ics, /25,00|1200|1\.200/);             // niente importi di default
  assert.match(buildIcs(s, { today: TODAY, includeAmounts: true }).replaceAll('\r\n ', ''), /25\\,00/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  assert.match(ics, /Cliente\; "A"\\, B/);                   // escaping di ; e ,
  assert.equal(buildIcs(s, { today: TODAY }), buildIcs(s, { today: TODAY })); // deterministico (UID stabili)
});

// ───────── Guadagni vs costi ─────────
test('analisi mensile: incassi, spese, tasse stimate e netto', async () => {
  let { s, a1, a2 } = await freelanceSetup();
  const add = async (cents, kind, cat, date) => ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a1, cents, kind, categoryId: cat, date }));
  await add(120000, 'income', 'cat_pro', '2026-06-05');
  await add(-22000, 'expense', 'cat_food', '2026-06-08');
  await add(-2500, 'expense', 'cat_subs', '2026-06-09');
  await add(-9999, 'expense', 'cat_tax', '2026-06-10');         // pagamento imposte: non conta due volte
  await add(30000, 'income', 'cat_in_other', '2026-05-20');
  ({ state: s } = await C.addTransfer(s, ctx(), { fromAccountId: a1, toAccountId: a2, cents: 5000, date: '2026-06-11' })); // trasferimento: non è né entrata né spesa
  ({ state: s } = await C.assignToFund(s, ctx(), s.settings.taxProfile.fundId, 29000, 'riserva', a1)); // riserva effettiva (tua regola)
  const m = monthlySeries(s, TODAY, 3);
  assert.deepEqual(m.map((x) => x.month), ['2026-04', '2026-05', '2026-06']);
  const jun = m[2];
  assert.equal(jun.income, 120000); assert.equal(jun.expense, 24500);
  assert.equal(jun.tax, 29000);                 // grafico = riserva EFFETTIVA
  assert.equal(jun.taxEstimate, 29082);         // la stima teorica resta distinta
  assert.equal(jun.net, 120000 - 29000 - 24500);
  assert.equal(m[1].income, 30000); assert.equal(m[1].tax, 0); // altre entrate: nessuna riserva
  const cats = categoryBreakdown(s, '2026-06');
  assert.deepEqual(cats.map((c) => [c.id, c.cents]), [['cat_food', 22000], ['cat_subs', 2500]]);
});

// ───────── Personalizzazione e migrazione ─────────
test('conti e fondi: banca, colore, icona e logo validati', async () => {
  let { s } = await base();
  let r = await C.addAccount(s, ctx(), { name: 'Revolut', bank: 'revolut', color: 'ink', emoji: '💳', openingCents: 0, openingDate: '2026-01-01' }); s = r.state;
  assert.equal(s.accounts.at(-1).bank, 'revolut');
  ({ state: s } = await C.updateAccount(s, ctx(), r.result, { logo: 'data:image/png;base64,iVBORw0KGgo=' }));
  assert.equal(validateState(s).length, 0);
  const bad = structuredClone(s); bad.accounts.at(-1).logo = 'data:text/html;base64,PHNjcmlwdD4=';
  assert.ok(validateState(bad).some((p) => /logo/.test(p)));       // solo PNG base64: niente contenuti attivi
  const bad2 = structuredClone(s); bad2.accounts.at(-1).logo = 'javascript:alert(1)';
  assert.ok(validateState(bad2).length > 0);
  const bad3 = structuredClone(s); bad3.funds.push({ id: 'x', name: 'F', kind: 'reserve', accountId: s.accounts[0].id, goal: null, plannedId: null, archived: false, createdAt: 'x', color: 'rosa-shocking', icon: '💰' });
  assert.ok(validateState(bad3).some((p) => /aspetto/.test(p)));
});
test('migrazione da schema v1: aggiunge i campi nuovi senza perdere nulla', async () => {
  let { s } = await base();
  const v1 = structuredClone(s);
  v1.schemaVersion = 1; delete v1.invoiceTemplates; delete v1.settings.taxProfile;
  v1.accounts.forEach((a) => { delete a.bank; delete a.color; delete a.emoji; delete a.logo; });
  migrateState(v1);
  assert.equal(v1.schemaVersion, 3); assert.deepEqual(validateState(v1), []);
  assert.equal(v1.accounts.length, s.accounts.length);
  assert.equal(JSON.stringify(migrateState(structuredClone(v1))), JSON.stringify(v1)); // idempotente
});
test('profilo fiscale: attivabile solo con un fondo valido', async () => {
  const { s } = await base();
  await expectError(C.setTaxProfile(s, ctx(), { enabled: true }), 'non_trovato');
});
test('previsione: lo scoperto è segnalato anche se gli incassi attesi lo coprirebbero, ma dichiarandolo', async () => {
  let { s, a1 } = await base(); // 1.500 €
  ({ state: s } = await C.addPlanned(s, ctx(), { name: 'Grossa', cents: 200000, dueDate: '2026-06-25', accountId: a1, fundMode: 'none' }));
  let f = forecast(s, TODAY, 60);
  let i = f.issues.find((x) => x.kind === 'free_negative');
  assert.equal(i.coveredByExpected, false); assert.equal(i.severity, 'high'); assert.match(i.message, /Senza contare gli incassi attesi/);
  ({ state: s } = await C.addReceivable(s, ctx(), { client: 'C', expectedCents: 300000, expectedDate: '2026-06-20', accountId: a1 }));
  f = forecast(s, TODAY, 60);
  i = f.issues.find((x) => x.kind === 'free_negative');
  assert.equal(i.coveredByExpected, true); assert.equal(i.severity, 'medium'); assert.match(i.message, /non sono garantiti/);
  assert.equal(f.points.at(-1).free, 150000 - 200000); // la serie prudente resta negativa: l'incasso non conta
});
