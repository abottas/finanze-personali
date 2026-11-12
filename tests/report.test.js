// Report, statistiche, previsione di cassa ed esportazioni CSV.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot } from '../src/core/derive.js';
import { niceScale, compactEuro, monthlyReport, balanceHistory, categoryTrend, weeklyBudget, kpis, cashflowByMonth, statsCsv, forecastSummaryCsv, forecastDetailCsv, monthEnd } from '../src/core/reports.js';
import { cell, money, toCsv, pct } from '../src/core/csv.js';
import { forecast } from '../src/core/forecast.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, TODAY } from './helpers.js';

async function world() {
  let s = createEmptyState(ctx());
  let r = await C.addAccount(s, ctx(), { name: 'Conto', openingCents: 100000, openingDate: '2026-01-01' }); s = r.state; const a = r.result;
  r = await C.addAccount(s, ctx(), { name: 'PAC', type: 'investment', openingCents: 0, openingDate: '2026-01-01' }); s = r.state; const pac = r.result;
  const tx = async (cents, kind, cat, date) => { ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a, cents, kind, categoryId: cat, date })); };
  await tx(200000, 'income', 'cat_pro', '2026-04-10'); await tx(-30000, 'expense', 'cat_food', '2026-04-12'); await tx(-10000, 'expense', 'cat_eat', '2026-04-20');
  await tx(150000, 'income', 'cat_pro', '2026-05-10'); await tx(-50000, 'expense', 'cat_food', '2026-05-12');
  await tx(100000, 'income', 'cat_pro', '2026-06-05'); await tx(-20000, 'expense', 'cat_food', '2026-06-08');
  ({ state: s } = await C.addTransfer(s, ctx(), { fromAccountId: a, toAccountId: pac, cents: 10000, date: '2026-06-02', purpose: 'investment' }));
  return { s, a, pac };
}

test('scala degli assi: passi 1/2/5, sempre con lo zero, nessun valore strano', () => {
  assert.deepEqual(niceScale(0, 92000, 4).ticks, [0, 25000, 50000, 75000, 100000]);   // 0–1.000 € a passi di 250
  const n = niceScale(-30000, 90000, 4); assert.ok(n.min <= -30000 && n.max >= 90000 && n.ticks.includes(0));
  assert.ok(niceScale(0, 0).max > 0);
  for (const [lo, hi] of [[0, 1234], [-5, 77], [0, 1e9], [-1e6, -10]]) { const t = niceScale(lo, hi).ticks; assert.ok(t.every((v, i) => i === 0 || v > t[i - 1])); }
});
test('formato compatto degli importi per gli assi', () => {
  assert.equal(compactEuro(150000), '1,5k'); assert.equal(compactEuro(90000), '900'); assert.equal(compactEuro(-250000), '-2,5k'); assert.equal(compactEuro(0), '0'); assert.equal(compactEuro(120000000), '1,2M');
});
test('report mensile: incassi, spese, investito (trasferimento verso il PAC), disponibile e tasso di risparmio', async () => {
  const { s } = await world();
  const r = monthlyReport(s, TODAY, 3);
  assert.deepEqual(r.map((m) => m.month), ['2026-04', '2026-05', '2026-06']);
  assert.deepEqual([r[0].income, r[0].expense, r[0].invested], [200000, 40000, 0]);
  assert.deepEqual([r[2].income, r[2].expense, r[2].invested], [100000, 20000, 10000]);
  assert.equal(r[0].available, 160000); assert.equal(r[0].savingsRate, 0.8);
  assert.equal(r[1].label, 'mag');
});
test('storia del saldo: liquido e investito a fine mese, coerenti con il saldo di oggi', async () => {
  const { s } = await world();
  const h = balanceHistory(s, TODAY, 3);
  assert.equal(h[0].liquid, 100000 + 200000 - 40000);            // fine aprile
  assert.equal(h[1].liquid, h[0].liquid + 150000 - 50000);       // fine maggio
  const sn = snapshot(s);
  assert.equal(h[2].liquid, sn.liquid); assert.equal(h[2].invested, sn.invested); assert.equal(h[2].date, TODAY);
  assert.equal(h[2].invested, 10000);                              // il PAC non è liquidità
  assert.equal(h[1].date, '2026-05-31');
});
test('storia del saldo: un conto "da aggiornare" è escluso e il dato è segnalato come parziale', async () => {
  let { s } = await world();
  const r = await C.addAccount(s, ctx(), { name: 'Ignoto', openingCents: 0, openingDate: '2026-01-01', balanceUnknown: true }); s = r.state;
  assert.equal(balanceHistory(s, TODAY, 2).every((x) => x.partial), true);
});
test('andamento per categoria: top N + "Altre", ogni euro contato una sola volta', async () => {
  const { s } = await world();
  const t = categoryTrend(s, TODAY, 3, 1);
  assert.deepEqual(t.series.map((x) => x.id), ['cat_food', '_altre']);
  assert.deepEqual(t.series[0].values, [30000, 50000, 20000]); assert.deepEqual(t.series[1].values, [10000, 0, 0]);
  const all = categoryTrend(s, TODAY, 3, 99);
  assert.equal(all.series.flatMap((x) => x.values).reduce((a, b) => a + b, 0), 40000 + 50000 + 20000);
});
test('indicatori: medie sugli ultimi mesi COMPLETI e autonomia', async () => {
  const { s } = await world();
  const k = kpis(s, TODAY);
  // mesi completi considerati: marzo (vuoto, escluso), aprile, maggio
  assert.equal(k.monthsOfData, 2);
  assert.equal(k.avgIncome, 175000); assert.equal(k.avgExpense, 45000);
  assert.equal(k.runwayMonths, snapshot(s).liquid / 45000);
});
test('budget settimanale: speso contro budget per settimana', async () => {
  let { s, a } = await world();
  ({ state: s } = await C.updateBudget(s, ctx(), { weeklyCents: 20000, startDate: '2026-06-01' }));
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a, cents: -8000, kind: 'expense', categoryId: 'cat_fun', date: '2026-06-03' }));
  const w = weeklyBudget(s, TODAY, 4);
  assert.equal(w.base, 20000); assert.equal(w.weeks.at(-1).weekStart, '2026-06-15');
  assert.deepEqual(w.weeks.map((x) => x.spent), [8000, 20000, 0]);                    // settimane del 1/6, 8/6 e 15/6
});
test('previsione di cassa: entrate previste, uscite (budget/scadenze/PAC) e saldi per mese', async () => {
  let { s, a, pac } = await world();
  ({ state: s } = await C.updateBudget(s, ctx(), { weeklyCents: 10000, startDate: TODAY }));
  ({ state: s } = await C.addPlanned(s, ctx(), { name: 'Abbonamento', kind: 'subscription', cents: 2500, dueDate: '2026-07-05', accountId: a, fundMode: 'none', recurrence: 'monthly', categoryId: 'cat_subs' }));
  ({ state: s } = await C.addPlanned(s, ctx(), { name: 'PAC', kind: 'investment', cents: 10000, dueDate: '2026-07-02', accountId: a, toAccountId: pac, fundMode: 'none', recurrence: 'monthly', categoryId: 'cat_invest' }));
  ({ state: s } = await C.addReceivable(s, ctx(), { client: 'Cliente', expectedCents: 80000, expectedDate: '2026-07-20', accountId: a }));
  const cf = cashflowByMonth(s, TODAY, 3);
  const jul = cf.rows.find((r) => r.month === '2026-07');
  assert.equal(jul.inExpected, 80000); assert.equal(jul.outFixed, 2500); assert.equal(jul.outInvest, 10000);
  assert.equal(jul.outBudget, 10000 * 4);                      // 4 lunedì in luglio (6, 13, 20, 27); il 29/6 cade in giugno
  assert.equal(jul.outTotal, jul.outBudget + 2500 + 10000);
  assert.equal(jul.netPrudent, -jul.outTotal); assert.equal(jul.netWithExpected, 80000 - jul.outTotal);
  assert.ok(jul.liquidWithExpected - jul.liquidPrudent >= 80000);
  assert.equal(cf.rows[0].inExpected, 0);                       // giugno: nessun incasso previsto
  assert.equal(cf.start.total, snapshot(s).liquid);
});
test('previsione: le fatture ricorrenti sono proiettate oltre i mesi generati, con la riserva reale di ogni cliente', async () => {
  let { s, a } = await world();
  ({ state: s } = await C.setupFreelanceProfile(s, ctx(), { taxAccountId: a }));                    // profilo fiscale attivo: la riserva dell'incasso non è libera
  let r = await C.addInvoiceTemplate(s, ctx(), { client: 'Cliente', cents: 120000, invoiceDay: 27, collectDays: 12, accountId: a, reserveCents: 30000 }); s = r.state;
  const generated = s.receivables.filter((x) => x.templateKey).length;
  const f = forecast(s, TODAY, 365);
  const proj = f.events.filter((e) => e.projected);
  assert.ok(proj.length > 0 && generated >= 2);
  assert.ok(proj.every((e) => e.total === 120000 && e.free === 90000 && e.prudent === false));   // 1.200 − 300 di riserva
  const dates = f.events.filter((e) => e.kind === 'receivable').map((e) => e.date);
  assert.equal(new Set(dates).size, dates.length);                                                // nessun doppione tra generati e proiettati
  assert.ok(dates.some((d) => d >= '2026-10-01'));                                                // arriva oltre i 3 mesi generati
  assert.equal(f.points.at(-1).total, snapshot(s).liquid);                                        // le entrate previste restano fuori dallo scenario prudente
});
test('CSV: separatore ;, decimali con virgola, BOM, virgolette e protezione da formule', () => {
  assert.equal(money(123456), '1234,56'); assert.equal(money(-5), '-0,05'); assert.equal(money(0), '0,00');
  assert.equal(cell('a;b'), '"a;b"'); assert.equal(cell('di "x"'), '"di ""x"""'); assert.equal(cell('=SOMMA(A1)'), "'=SOMMA(A1)"); assert.equal(cell('+39 333'), "'+39 333");
  assert.equal(pct(0.8), '80,0'); assert.equal(pct(null), '');
  const out = toCsv(['A', 'B'], [[1050, 'x;y']]);
  assert.ok(out.startsWith('﻿A;B\r\n')); assert.ok(out.endsWith('10,50;"x;y"\r\n'));
});
test('export statistiche: una riga per mese, colonne per categoria, nessuna cifra in virgola mobile', async () => {
  const { s } = await world();
  const csv = statsCsv(s, TODAY, 3);
  const lines = csv.replace('﻿', '').trim().split('\r\n');
  assert.equal(lines.length, 4);
  const head = lines[0].split(';');
  assert.ok(head.includes('Incassi') && head.includes('Spese: Alimentari') && head.includes('Tasso di risparmio %'));
  const apr = lines[1].split(';');
  assert.equal(apr[0], '2026-04'); assert.equal(apr[1], '2000,00'); assert.equal(apr[3], '400,00'); assert.equal(apr[head.indexOf('Spese: Alimentari')], '300,00');
  assert.ok(!/\d\.\d{3,}/.test(csv));
});
test('export previsione: riepilogo mensile e dettaglio per evento, coerenti tra loro', async () => {
  let { s, a } = await world();
  ({ state: s } = await C.addPlanned(s, ctx(), { name: 'Rinnovo; "speciale"', kind: 'renewal', cents: 30000, dueDate: '2026-08-10', accountId: a, fundMode: 'none', recurrence: 'yearly', categoryId: 'cat_subs' }));
  ({ state: s } = await C.addReceivable(s, ctx(), { client: 'Cliente', expectedCents: 50000, expectedDate: '2026-07-15', accountId: a }));
  const sum = forecastSummaryCsv(s, TODAY, 3).replace('﻿', '').trim().split('\r\n');
  const det = forecastDetailCsv(s, TODAY, 3).replace('﻿', '').trim().split('\r\n');
  assert.equal(sum.length, 4);
  const ago = sum.find((l) => l.startsWith('2026-08;')).split(';');
  assert.equal(ago[3], '300,00');                                    // uscite: scadenze e spese
  assert.ok(det.some((l) => l.includes('"Rinnovo; ""speciale"""')));  // quoting corretto
  assert.ok(det.some((l) => l.includes('Incasso previsto') && l.includes(';no;')));   // l'incasso non è garantito
  const totIn = det.slice(1).reduce((t, l) => t + (Number(l.split(';')[3]?.replace(',', '.')) || 0), 0);
  assert.equal(Math.round(totIn * 100), 50000);
});
test('mese: ultimo giorno corretto anche a febbraio bisestile', () => { assert.equal(monthEnd('2028-02'), '2028-02-29'); assert.equal(monthEnd('2026-02'), '2026-02-28'); });

// ───── Situazione a una data ─────
import { situationAt, situationCsv } from '../src/core/reports.js';
async function sit({ withReceivable = true } = {}) {
  let s = createEmptyState(ctx());
  let r = await C.addAccount(s, ctx(), { name: 'Conto', openingCents: 100000, openingDate: '2026-01-01' }); s = r.state; const acc = r.result;
  s = (await C.addPlanned(s, ctx(), { name: 'Affitto', kind: 'subscription', cents: 80000, dueDate: '2026-06-20', accountId: acc, fundMode: 'none', recurrence: 'none' })).state;
  s = (await C.addPlanned(s, ctx(), { name: 'Assicurazione', kind: 'renewal', cents: 50000, dueDate: '2026-07-05', accountId: acc, fundMode: 'none', recurrence: 'none' })).state;
  if (withReceivable) s = (await C.addReceivable(s, ctx(), { client: 'Cliente A', expectedCents: 100000, expectedDate: '2026-06-28', accountId: acc })).state;
  s = (await C.addReceivable(s, ctx(), { client: 'Ritardatario', expectedCents: 30000, expectedDate: '2026-06-01', accountId: acc })).state;
  return s;
}
test('situazione: una spesa coperta solo dagli incassi previsti è segnalata come tale, non come coperta', async () => {
  const s = await sit();
  const r = situationAt(s, '2026-06-15', '2026-07-31');
  const byLabel = Object.fromEntries(r.lines.map((l) => [l.label, l]));
  assert.equal(byLabel['Affitto'].status, 'ok'); assert.equal(byLabel['Affitto'].freeAfter, 20000);
  assert.equal(byLabel['Assicurazione'].status, 'con_incassi');            // prudente −300 €, con l'incasso di 1.000 € torna positivo
  assert.equal(byLabel['Assicurazione'].freeAfter, -30000); assert.equal(byLabel['Assicurazione'].freeAfterWithExpected, 70000);
  assert.equal(r.verdict.level, 'attenzione'); assert.equal(r.verdict.shortfallPrudent, 30000); assert.equal(r.verdict.shortfallWithExpected, 0);
  assert.equal(r.verdict.dependOnReceipts, 1); assert.equal(r.verdict.uncovered, 0);
});
test('situazione: senza incassi previsti la spesa è NON coperta e il verdetto è critico; i ritardi sono elencati e non contati', async () => {
  const r = situationAt(await sit({ withReceivable: false }), '2026-06-15', '2026-07-31');
  assert.equal(r.lines.find((l) => l.label === 'Assicurazione').status, 'scoperta');
  assert.equal(r.verdict.level, 'critico'); assert.equal(r.verdict.shortfallWithExpected, 30000);
  assert.deepEqual(r.overdue.map((x) => [x.client, x.cents]), [['Ritardatario', 30000]]);
  assert.equal(r.totals.inExpected, 0);                                      // l'incasso in ritardo non entra nei totali
});
test('situazione: riepilogo per mese coerente con le righe e con i punti della previsione', async () => {
  const r = situationAt(await sit(), '2026-06-15', '2026-07-31');
  assert.deepEqual(r.months.map((m) => m.month), ['2026-06', '2026-07']);
  const [g, l] = r.months;
  assert.equal(g.inExpected, 100000); assert.equal(g.outFixed, 80000); assert.equal(g.partialStart, true);
  assert.equal(l.outFixed, 50000); assert.equal(g.freeEnd, 20000); assert.equal(l.freeEnd, -30000); assert.equal(l.freeEndWithExpected, 70000);
  assert.equal(r.totals.inExpected, 100000); assert.equal(r.totals.outTotal, 130000);
  assert.equal(r.totals.freeEnd, 100000 - 130000);
  assert.equal(r.start.free, 100000);
});
test('situazione: export CSV con stato leggibile', async () => {
  const csv = situationCsv(await sit(), '2026-06-15', '2026-07-31');
  assert.ok(csv.startsWith('﻿Data;Tipo')); assert.ok(csv.includes('Coperta solo se arrivano gli incassi')); assert.ok(csv.includes('Incasso previsto'));
});
