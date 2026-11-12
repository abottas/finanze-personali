// Report e statistiche: funzioni PURE derivate dai dati (mai memorizzate). Importi in centesimi.
import { snapshot, balanceOf } from './derive.js';
import { monthlySeries, categoryBreakdown } from './analytics.js';
import { budgetStatus } from './budget.js';
import { forecast } from './forecast.js';
import { addDays, addMonths, daysInMonth, diffDays } from './dates.js';
import { estimateAnnual } from './tax.js';
import { toCsv, money, pct } from './csv.js';

export const ymOf = (d) => d.slice(0, 7);
export const monthEnd = (ym) => `${ym}-${String(daysInMonth(Number(ym.slice(0, 4)), Number(ym.slice(5)))).padStart(2, '0')}`;
const MN = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
export const monthLabel = (ym, short = false) => (short ? MN[Number(ym.slice(5)) - 1].slice(0, 3) : `${MN[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`);

/** Scala "pulita" per un asse: passi 1/2/2,5/5 × 10^n. Include sempre lo zero. */
export function niceScale(minC, maxC, count = 4) {
  let lo = Math.min(0, minC), hi = Math.max(0, maxC);
  if (hi === lo) hi = lo + 100;
  const raw = (hi - lo) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;      // passi 1 · 2 · 2,5 · 5
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v));
  return { min: lo, max: hi, step, ticks };
}
/** 123456 → "1,2k" · 150000 → "1,5k" · 90000 → "900" (valori in euro, senza simbolo). */
export function compactEuro(c) {
  const e = c / 100, a = Math.abs(e);
  const fmt = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
  if (a >= 1_000_000) return fmt(e / 1_000_000) + 'M';
  if (a >= 1000) return fmt(e / 1000) + 'k';
  return fmt(e);
}

export function monthlyReport(state, today, months = 12) {
  const series = monthlySeries(state, today, months);
  const hist = balanceHistory(state, today, months);
  return series.map((m, i) => ({ ...m, available: m.net, savingsRate: m.income > 0 ? m.net / m.income : null, liquidEnd: hist[i].liquid, investedEnd: hist[i].invested, partialBalance: hist[i].partial, label: monthLabel(m.month, true) }));
}

/** Saldo LIQUIDO e INVESTITO a fine mese (oggi per il mese in corso). I conti con saldo "da aggiornare" sono esclusi e segnalati. */
export function balanceHistory(state, today, months = 12) {
  const first = ymOf(addMonths(today.slice(0, 7) + '-01', -(months - 1)));
  const out = [];
  for (let i = 0; i < months; i++) {
    const ym = ymOf(addMonths(first + '-01', i));
    const asOf = ym === today.slice(0, 7) ? today : monthEnd(ym);
    let liquid = 0, invested = 0, partial = false;
    for (const a of state.accounts) {
      if (a.balanceUnknown) { partial = true; continue; }
      if (a.openingDate > asOf) continue;
      const b = balanceOf(state, a.id, asOf);
      if (a.type === 'investment') invested += b; else liquid += b;
    }
    out.push({ month: ym, date: asOf, liquid, invested, partial });
  }
  return out;
}

/** Spese per categoria nei mesi (top N + "Altre"), per i grafici di andamento. */
export function categoryTrend(state, today, months = 6, top = 5) {
  const mlist = monthlySeries(state, today, months).map((m) => m.month);
  const per = mlist.map((m) => categoryBreakdown(state, m));
  const tot = {};
  for (const rows of per) for (const r of rows) tot[r.id] = (tot[r.id] ?? 0) + r.cents;
  const ids = Object.entries(tot).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const keep = ids.slice(0, top);
  const meta = {};
  for (const rows of per) for (const r of rows) meta[r.id] = r;
  const series = keep.map((id) => ({ id, name: meta[id].name, icon: meta[id].icon, color: meta[id].color, values: per.map((rows) => rows.find((r) => r.id === id)?.cents ?? 0) }));
  const rest = per.map((rows) => rows.filter((r) => !keep.includes(r.id)).reduce((s, r) => s + r.cents, 0));
  if (rest.some((v) => v > 0)) series.push({ id: '_altre', name: 'Altre', icon: '⋯', color: 'gray', values: rest });
  return { months: mlist, series };
}

/** Budget settimanale: speso contro budget per le ultime `weeks` settimane. */
export function weeklyBudget(state, today, weeks = 8) {
  const st = budgetStatus(state, today);
  return { started: st.started, base: st.baseCents, weeks: st.weeks.slice(-weeks) };
}

/** Indicatori sintetici sugli ultimi mesi COMPLETI (fino a 3). */
export function kpis(state, today) {
  const rows = monthlySeries(state, today, 4).slice(0, 3).filter((m) => m.income !== 0 || m.expense !== 0 || m.invested !== 0);
  const n = rows.length;
  const sum = (k) => rows.reduce((s, m) => s + m[k], 0);
  const avg = (k) => (n ? Math.round(sum(k) / n) : 0);
  const avgIncome = avg('income'), avgExpense = avg('expense'), avgNet = avg('net'), avgInvested = avg('invested');
  const snap = snapshot(state);
  return { monthsOfData: n, avgIncome, avgExpense, avgNet, avgInvested, savingsRate: avgIncome > 0 ? avgNet / avgIncome : null, runwayMonths: avgExpense > 0 ? snap.liquid / avgExpense : null, liquid: snap.liquid, invested: snap.invested };
}

/**
 * Previsione di cassa per mese: ENTRATE previste (mai garantite) · USCITE previste (budget, scadenze, investimenti) · saldi.
 * Prudente = senza incassi attesi; "con previsti" = scenario informativo. Include le fatture ricorrenti proiettate.
 */
export function cashflowByMonth(state, today, months = 6) {
  const days = Math.min(365, months * 31);
  const f = forecast(state, today, days);
  const planned = Object.fromEntries(state.planned.map((p) => [p.id, p]));
  const mlist = [];
  for (let i = 0; i < months; i++) mlist.push(ymOf(addMonths(today.slice(0, 7) + '-01', i)));
  const rows = mlist.map((m) => ({ month: m, label: monthLabel(m, true), inExpected: 0, outBudget: 0, outFixed: 0, outInvest: 0, outTotal: 0 }));
  const idx = Object.fromEntries(mlist.map((m, i) => [m, i]));
  for (const e of f.events) {
    const r = rows[idx[ymOf(e.date)]];
    if (!r) continue;
    if (e.kind === 'receivable') r.inExpected += e.total;
    else if (e.kind === 'budget') r.outBudget += -e.total;
    else if (planned[e.plannedId]?.kind === 'investment') r.outInvest += -e.total;
    else r.outFixed += -e.total;
  }
  for (const r of rows) {
    r.outTotal = r.outBudget + r.outFixed + r.outInvest;
    r.netPrudent = -r.outTotal;
    r.netWithExpected = r.inExpected - r.outTotal;
    const lastDay = r.month === today.slice(0, 7) ? today : monthEnd(r.month);
    const endDay = lastDay > addDays(today, days) ? addDays(today, days) : monthEnd(r.month);
    const pt = [...f.points].reverse().find((p) => p.date <= endDay) ?? f.points.at(-1);
    r.liquidPrudent = pt.total; r.liquidWithExpected = pt.totalWithExpected; r.freePrudent = pt.free;
  }
  return { rows, events: f.events, points: f.points, issues: f.issues, start: f.start };
}

// ───────────────────────── CSV ─────────────────────────
export function statsCsv(state, today, months = 12) {
  const rep = monthlyReport(state, today, months);
  const trend = categoryTrend(state, today, months, 999);
  const cats = trend.series.filter((s) => s.id !== '_altre');
  const headers = ['Mese', 'Incassi', 'Di cui incassi professionali', 'Spese di consumo', 'Riserva fiscale accantonata', 'Stima fiscale teorica', 'Investito (PAC)', 'Disponibile dopo spese e riserva', 'Tasso di risparmio %', 'Liquidità a fine mese', 'Investito a fine mese', ...cats.map((c) => `Spese: ${c.name}`)];
  const rows = rep.map((m, i) => [m.month, m.income, m.proIncome, m.expense, m.tax, m.taxEstimate, m.invested, m.available, pct(m.savingsRate), m.partialBalance ? '' : m.liquidEnd, m.partialBalance ? '' : m.investedEnd, ...cats.map((c) => c.values[i])]);
  return toCsv(headers, rows);
}
export function forecastSummaryCsv(state, today, months = 12) {
  const cf = cashflowByMonth(state, today, months);
  const headers = ['Mese', 'Entrate previste (non garantite)', 'Uscite: budget settimanale', 'Uscite: scadenze e spese', 'Uscite: investimenti (PAC)', 'Uscite totali', 'Saldo netto prudente (senza entrate)', 'Saldo netto con entrate previste', 'Liquidità a fine mese (prudente)', 'Liquidità a fine mese (con entrate previste)'];
  return toCsv(headers, cf.rows.map((r) => [r.month, r.inExpected, r.outBudget, r.outFixed, r.outInvest, r.outTotal, r.netPrudent, r.netWithExpected, r.liquidPrudent, r.liquidWithExpected]));
}
export function forecastDetailCsv(state, today, months = 12) {
  const cf = cashflowByMonth(state, today, months);
  const planned = Object.fromEntries(state.planned.map((p) => [p.id, p]));
  const at = (d) => cf.points.find((p) => p.date === d) ?? cf.points.at(-1);
  const kind = (e) => (e.kind === 'receivable' ? (e.projected ? 'Incasso previsto (da fattura ricorrente)' : 'Incasso previsto') : e.kind === 'budget' ? 'Budget settimanale' : planned[e.plannedId]?.kind === 'investment' ? 'Investimento (PAC)' : 'Scadenza / spesa');
  const headers = ['Data', 'Tipo', 'Descrizione', 'Entrata', 'Uscita', 'Garantita', 'Liquidità prudente dopo l\'evento', 'Liquidità con entrate previste dopo l\'evento'];
  const rows = cf.events.map((e) => { const p = at(e.date); return [e.date, kind(e), e.label, e.total > 0 ? e.total : '', e.total < 0 ? -e.total : '', e.prudent ? 'sì' : 'no', p.total, p.totalWithExpected]; });
  return toCsv(headers, rows);
}
export { money };

// ───────────────────────── Situazione a una data ─────────────────────────
/**
 * Situazione ANALITICA da oggi a `until` (max 365 giorni): quanto entra, quanto esce, se le spese previste sono coperte.
 *  • prudente = solo il denaro che hai oggi (nessun incasso non ricevuto)
 *  • con incassi previsti = scenario informativo (non garantito)
 * Il "libero" è la liquidità non vincolata a fondi: ogni incasso entra al netto della riserva fiscale.
 * Stato di una spesa: ok (coperta dal libero) · con_incassi (coperta solo se arrivano gli incassi previsti) · scoperta.
 */
export function situationAt(state, today, until) {
  const days = Math.max(1, Math.min(365, diffDays(until, today)));
  const end = addDays(today, days);
  const f = forecast(state, today, days);
  const planned = Object.fromEntries(state.planned.map((p) => [p.id, p]));
  const ptAt = (d) => { const i = Math.min(days, Math.max(0, diffDays(d, today))); return f.points[i]; };
  const statusAt = (d) => { const p = ptAt(d); return p.free >= 0 ? 'ok' : p.freeWithExpected >= 0 ? 'con_incassi' : 'scoperta'; };

  // Righe: il budget settimanale si raggruppa per mese (altrimenti sono decine di righe uguali).
  const lines = [];
  const budgetByMonth = {};
  for (const e of f.events) {
    if (e.kind === 'receivable') { lines.push({ dir: 'in', type: 'incasso', date: e.date, label: e.label, total: e.total, free: e.free, projected: !!e.projected }); continue; }
    if (e.kind === 'budget') {
      const m = ymOf(e.date), g = (budgetByMonth[m] ??= { dir: 'out', type: 'budget', date: e.date, lastDate: e.date, label: '', total: 0, free: 0, n: 0 });
      g.total += e.total; g.free += e.free; g.n++; g.lastDate = e.date; continue;
    }
    const pl = planned[e.plannedId];
    lines.push({ dir: 'out', type: pl?.kind === 'investment' ? 'investimento' : 'scadenza', date: e.date, lastDate: e.date, label: e.label, total: e.total, free: e.free, covered: e.covered ?? 0 });
  }
  for (const g of Object.values(budgetByMonth)) { g.label = g.n === 1 ? 'Budget settimanale' : `Budget settimanale (${g.n} settimane)`; lines.push(g); }
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.dir === 'in' ? 1 : -1));
  for (const l of lines) {
    if (l.dir === 'out') { l.status = statusAt(l.lastDate); const p = ptAt(l.lastDate); l.freeAfter = p.free; l.freeAfterWithExpected = p.freeWithExpected; }
    else { const p = ptAt(l.date); l.freeAfter = p.free; l.freeAfterWithExpected = p.freeWithExpected; }
  }

  // Riepilogo per mese
  const months = [];
  for (let m = ymOf(today); m <= ymOf(end); m = ymOf(addMonths(m + '-01', 1))) {
    const mEnd = monthEnd(m) < end ? monthEnd(m) : end, mStart = m === ymOf(today) ? today : `${m}-01`;
    const row = { month: m, label: monthLabel(m), partialStart: m === ymOf(today) && today.slice(8) !== '01', partialEnd: mEnd < monthEnd(m), from: mStart, to: mEnd, inExpected: 0, inFree: 0, outFixed: 0, outBudget: 0, outInvest: 0, outFree: 0 };
    for (const l of lines) {
      if (ymOf(l.date) !== m) continue;
      if (l.dir === 'in') { row.inExpected += l.total; row.inFree += l.free; }
      else { const t = -l.total; if (l.type === 'budget') row.outBudget += t; else if (l.type === 'investimento') row.outInvest += t; else row.outFixed += t; row.outFree += -l.free; }
    }
    row.outTotal = row.outFixed + row.outBudget + row.outInvest;
    row.netPrudent = -row.outFree; row.netWithExpected = row.inFree - row.outFree;
    const p = ptAt(mEnd); row.freeEnd = p.free; row.freeEndWithExpected = p.freeWithExpected;
    months.push(row);
  }
  const sum = (k) => months.reduce((t, r) => t + r[k], 0);
  const totals = { inExpected: sum('inExpected'), inFree: sum('inFree'), outFixed: sum('outFixed'), outBudget: sum('outBudget'), outInvest: sum('outInvest'), outTotal: sum('outTotal'), outFree: sum('outFree') };
  const last = f.points.at(-1);
  totals.freeEnd = last.free; totals.freeEndWithExpected = last.freeWithExpected;
  totals.totalEnd = last.total; totals.totalEndWithExpected = last.totalWithExpected;

  // Minimi e verdetto
  let minP = f.points[0], minE = f.points[0];
  for (const p of f.points) { if (p.free < minP.free) minP = p; if (p.freeWithExpected < minE.freeWithExpected) minE = p; }
  const outs = lines.filter((l) => l.dir === 'out');
  const uncovered = outs.filter((l) => l.status === 'scoperta'), depend = outs.filter((l) => l.status === 'con_incassi');
  const unknown = state.accounts.filter((a) => a.balanceUnknown && !a.archived).map((a) => a.name);
  const shortP = Math.max(0, -minP.free), shortE = Math.max(0, -minE.freeWithExpected);
  const verdict = { minFree: minP.free, minFreeDate: minP.date, minFreeWithExpected: minE.freeWithExpected, minFreeWithExpectedDate: minE.date, uncovered: uncovered.length, dependOnReceipts: depend.length, shortfallPrudent: shortP, shortfallWithExpected: shortE, partial: unknown };
  verdict.level = shortE > 0 ? 'critico' : shortP > 0 ? 'attenzione' : 'ok';

  const overdue = state.receivables.filter((r) => (r.status === 'expected' || r.status === 'partial') && r.expectedDate < today)
    .map((r) => ({ client: r.client, date: r.expectedDate, cents: r.expectedCents - (r.receivedCents ?? 0) })).filter((r) => r.cents > 0);
  let tax = null;
  if (state.settings.taxProfile.enabled) {
    const year = Number(today.slice(0, 4)), a = estimateAnnual(state, year, today);
    const fund = state.funds.find((x) => x.id === state.settings.taxProfile.fundId);
    const reserved = fund ? snapshot(state).funds[fund.id].available : 0;
    tax = { year, stillDue: a.stillDue, reserved };
  }
  return { today, until: end, days, start: { total: f.start.total, free: f.start.free, reserved: f.start.total - f.start.free }, lines, months, totals, verdict, overdue, tax };
}

const STATUS_IT = { ok: 'Coperta', con_incassi: 'Coperta solo se arrivano gli incassi', scoperta: 'NON coperta' };
export function situationCsv(state, today, until) {
  const r = situationAt(state, today, until);
  const headers = ['Data', 'Tipo', 'Descrizione', 'Entrata', 'Uscita', 'Di cui accantonata/riservata', 'Libero dopo (prudente)', 'Libero dopo (con incassi previsti)', 'Stato'];
  const rows = r.lines.map((l) => [l.date, l.type === 'incasso' ? (l.projected ? 'Incasso previsto (fattura ricorrente)' : 'Incasso previsto') : l.type === 'budget' ? 'Budget' : l.type === 'investimento' ? 'Investimento (PAC)' : 'Scadenza', l.label, l.dir === 'in' ? l.total : '', l.dir === 'out' ? -l.total : '', l.dir === 'in' ? l.total - l.free : l.dir === 'out' ? l.covered ?? '' : '', l.freeAfter, l.freeAfterWithExpected, l.dir === 'out' ? STATUS_IT[l.status] : '']);
  return toCsv(headers, rows);
}
