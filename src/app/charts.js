// Grafici SVG scritti a mano (nessuna libreria, nessuno stile inline: colori e tratti dalle classi CSS).
// Tutti con assi "puliti" in euro, griglia, valori e — dove serve — un mese selezionabile con un tocco.
import { html, raw, esc } from './html.js';
import { formatEuro } from '../core/money.js';
import { formatDate, toDays, addDays } from '../core/dates.js';
import { niceScale, compactEuro, monthLabel } from '../core/reports.js';

const W = 340, PL = 36, PR = 8, PT = 12, PB = 22;
const f1 = (n) => n.toFixed(1);

function frame(sc, H) {
  const h = H - PT - PB;
  const y = (v) => PT + (1 - (v - sc.min) / (sc.max - sc.min)) * h;
  const grid = sc.ticks.map((t) => `<line class="${t === 0 ? 'axis0' : 'grid'}" x1="${PL}" x2="${W - PR}" y1="${f1(y(t))}" y2="${f1(y(t))}"/><text class="axis" x="${PL - 5}" y="${f1(y(t) + 3)}" text-anchor="end">${compactEuro(t)}</text>`).join('');
  return { y, grid };
}
const bar = (cls, x, yTop, w, h, rx = 2) => (h > 0.4 ? `<rect class="${cls}" x="${f1(x)}" y="${f1(yTop)}" width="${f1(w)}" height="${f1(h)}" rx="${rx}"/>` : '');
const svg = (H, label, inner) => html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${raw(inner)}</svg>`;

/** Entrate e uscite per mese: barra degli incassi + barra impilata (spese · riserva fiscale · investito) e linea del NETTO. */
export function flowChart(rows, { selected = null, height = 190, interactive = true } = {}) {
  const H = height, n = rows.length;
  const stack = (r) => r.expense + r.tax + r.invested;
  const sc = niceScale(Math.min(0, ...rows.map((r) => r.net)), Math.max(1, ...rows.map((r) => Math.max(r.income, stack(r)))), 4);
  const { y, grid } = frame(sc, H);
  const gw = (W - PL - PR) / n, bw = Math.min(14, (gw - 6) / 2);
  let g = '', pts = [];
  rows.forEach((r, i) => {
    const x0 = PL + i * gw, cx = x0 + gw / 2, y0 = y(0);
    const sel = r.month === selected;
    const incH = y0 - y(r.income);
    let acc = 0, stk = '';
    for (const [cls, v] of [['b-exp', r.expense], ['b-tax', r.tax], ['b-inv', r.invested]]) { if (v > 0) { stk += bar(cls, cx + 1, y(acc + v), bw, y(acc) - y(acc + v), 1.5); acc += v; } }
    const title = `${monthLabel(r.month)}: incassi ${formatEuro(r.income)} · spese ${formatEuro(r.expense)} · riserva fiscale ${formatEuro(r.tax)} · investito ${formatEuro(r.invested)} · disponibile ${formatEuro(r.net)}`;
    g += `<g ${interactive ? `data-action="chart-month" data-v="${r.month}" role="button" tabindex="0"` : ''} aria-label="${esc(title)}">${sel ? `<rect class="band" x="${f1(x0 + 1)}" y="${PT - 4}" width="${f1(gw - 2)}" height="${H - PT - PB + 8}" rx="6"/>` : ''}<title>${esc(title)}</title>${bar('b-inc', cx - bw - 1, y(r.income), bw, incH, 2)}${stk}<text class="axis ${sel ? 'sel' : ''}" x="${f1(cx)}" y="${H - 6}" text-anchor="middle">${esc(r.label ?? monthLabel(r.month, true))}</text><rect class="hit" x="${f1(x0)}" y="${PT - 6}" width="${f1(gw)}" height="${H - PT - PB + 28}"/></g>`;
    pts.push([cx, y(r.net)]);
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${f1(p[0])} ${f1(p[1])}`).join(' ');
  const dots = pts.map((p, i) => `<circle class="dot-net ${rows[i].net < 0 ? 'neg' : ''}" cx="${f1(p[0])}" cy="${f1(p[1])}" r="${rows.length > 8 ? 2.4 : 3.2}"/>`).join('');
  return svg(H, 'Entrate e uscite per mese, con il disponibile netto: ' + rows.map((r) => `${monthLabel(r.month)} incassi ${formatEuro(r.income)} spese ${formatEuro(r.expense)}`).join('; '), `${grid}${g}<path class="l-net" d="${line}"/>${dots}`);
}

/** Andamento della liquidità: storico a fine mese + previsione giornaliera (prudente e con incassi previsti). */
export function balanceChart(history, points, { height = 190 } = {}) {
  const H = height;
  const hist = history.filter((h) => !h.partial);
  if (hist.length + points.length < 2) return html`<div class="muted small">Dati insufficienti per l'andamento.</div>`;
  const all = [...hist.map((h) => h.liquid), ...points.flatMap((p) => [p.total, p.totalWithExpected])];
  const sc = niceScale(Math.min(...all), Math.max(...all), 4);
  const { y, grid } = frame(sc, H);
  const d0 = toDays((hist[0] ?? points[0]).date), d1 = toDays(points.at(-1)?.date ?? hist.at(-1).date);
  const x = (d) => PL + ((toDays(d) - d0) / Math.max(1, d1 - d0)) * (W - PL - PR);
  const path = (arr, k) => arr.map((p, i) => `${i ? 'L' : 'M'}${f1(x(p.date))} ${f1(y(p[k]))}`).join(' ');
  const today = hist.at(-1)?.date ?? points[0].date;
  const area = hist.length > 1 ? `<path class="area" d="${path(hist, 'liquid')} L${f1(x(hist.at(-1).date))} ${f1(y(Math.max(sc.min, 0)))} L${f1(x(hist[0].date))} ${f1(y(Math.max(sc.min, 0)))} Z"/>` : '';
  const histDots = hist.map((h) => `<circle class="dot-bal" cx="${f1(x(h.date))}" cy="${f1(y(h.liquid))}" r="2.6"><title>${esc(formatDate(h.date, { year: true }))}: ${esc(formatEuro(h.liquid))}</title></circle>`).join('');
  const fc = points.length ? `<path class="l-total" d="${path(points, 'total')}"/><path class="l-exp" d="${path(points, 'totalWithExpected')}"/>` : '';
  const last = points.at(-1);
  const label = last ? `Liquidità: oggi ${formatEuro(points[0].total)}, tra ${points.length - 1} giorni ${formatEuro(last.total)} (prudente) o ${formatEuro(last.totalWithExpected)} con gli incassi previsti.` : 'Andamento della liquidità';
  return svg(H, label, `${grid}${area}${hist.length > 1 ? `<path class="l-free" d="${path(hist, 'liquid')}"/>` : ''}${fc}${histDots}<line class="today" x1="${f1(x(today))}" x2="${f1(x(today))}" y1="${PT}" y2="${H - PB}"/><text class="axis" x="${f1(x(today) + 4)}" y="${PT + 8}" text-anchor="start">oggi</text><text class="axis" x="${PL}" y="${H - 6}" text-anchor="start">${esc(formatDate((hist[0] ?? points[0]).date))}</text><text class="axis" x="${W - PR}" y="${H - 6}" text-anchor="end">${esc(formatDate(points.at(-1)?.date ?? hist.at(-1).date))}</text>`);
}

/** Previsione per mese: ENTRATE previste (tratteggiate: non garantite) e USCITE previste impilate (scadenze · budget · investimenti). */
export function cashflowChart(rows, { height = 190 } = {}) {
  const H = height, n = rows.length;
  const sc = niceScale(Math.min(0, ...rows.map((r) => r.netPrudent)), Math.max(1, ...rows.map((r) => Math.max(r.inExpected, r.outTotal))), 4);
  const { y, grid } = frame(sc, H);
  const gw = (W - PL - PR) / n, bw = Math.min(14, (gw - 6) / 2);
  let g = '', pr = [];
  rows.forEach((r, i) => {
    const x0 = PL + i * gw, cx = x0 + gw / 2, y0 = y(0);
    let acc = 0, stk = '';
    for (const [cls, v] of [['b-exp', r.outFixed], ['b-bud', r.outBudget], ['b-inv', r.outInvest]]) { if (v > 0) { stk += bar(cls, cx + 1, y(acc + v), bw, y(acc) - y(acc + v), 1.5); acc += v; } }
    const title = `${monthLabel(r.month)}: entrate previste ${formatEuro(r.inExpected)} (non garantite) · uscite ${formatEuro(r.outTotal)} · netto prudente ${formatEuro(r.netPrudent)} · netto con entrate ${formatEuro(r.netWithExpected)}`;
    g += `<g aria-label="${esc(title)}"><title>${esc(title)}</title>${bar('b-in-exp', cx - bw - 1, y(r.inExpected), bw, y0 - y(r.inExpected), 2)}${stk}<text class="axis" x="${f1(cx)}" y="${H - 6}" text-anchor="middle">${esc(r.label)}</text></g>`;
    pr.push([cx, y(r.netPrudent), y(r.netWithExpected)]);
  });
  const dots = pr.map((p) => `<circle class="dot-net" cx="${f1(p[0])}" cy="${f1(p[1])}" r="3"/><circle class="dot-exp" cx="${f1(p[0])}" cy="${f1(p[2])}" r="3"/>`).join('');
  return svg(H, 'Previsione di entrate e uscite per mese', `${grid}${g}${dots}`);
}

/** Budget settimanale: speso (barra) contro il livello disponibile (base + riporto) e il budget base (linea). */
export function budgetChart(weeks, base, { height = 150 } = {}) {
  const H = height, n = weeks.length;
  if (!n) return '';
  const sc = niceScale(0, Math.max(base, ...weeks.map((w) => Math.max(w.spent, w.base + w.carry))), 3);
  const { y, grid } = frame(sc, H);
  const gw = (W - PL - PR) / n, bw = Math.min(20, gw - 8);
  let g = '';
  weeks.forEach((w, i) => {
    const cx = PL + i * gw + gw / 2, allowed = Math.max(0, w.base + w.carry), over = w.spent > allowed;
    const title = `Settimana dal ${formatDate(w.weekStart)}: speso ${formatEuro(w.spent)} su ${formatEuro(allowed)} disponibili`;
    g += `<g aria-label="${esc(title)}"><title>${esc(title)}</title>${bar(over ? 'b-neg' : 'b-pos', cx - bw / 2, y(w.spent), bw, y(0) - y(w.spent), 2)}<line class="tick-allowed" x1="${f1(cx - bw / 2 - 2)}" x2="${f1(cx + bw / 2 + 2)}" y1="${f1(y(allowed))}" y2="${f1(y(allowed))}"/><text class="axis" x="${f1(cx)}" y="${H - 6}" text-anchor="middle">${esc(w.weekStart.slice(8) + '/' + w.weekStart.slice(5, 7))}</text></g>`;
  });
  return svg(H, 'Budget settimanale: speso contro disponibile', `${grid}<line class="base" x1="${PL}" x2="${W - PR}" y1="${f1(y(base))}" y2="${f1(y(base))}"/>${g}`);
}

/** Spese per categoria nei mesi (colonne impilate). */
export function stackedChart(trend, { height = 170 } = {}) {
  const H = height, n = trend.months.length;
  const totals = trend.months.map((_, i) => trend.series.reduce((s, c) => s + c.values[i], 0));
  const sc = niceScale(0, Math.max(1, ...totals), 4);
  const { y, grid } = frame(sc, H);
  const gw = (W - PL - PR) / n, bw = Math.min(26, gw - 8);
  let g = '';
  trend.months.forEach((m, i) => {
    const cx = PL + i * gw + gw / 2; let acc = 0, st = '';
    for (const c of trend.series) { const v = c.values[i]; if (v > 0) { st += bar(`seg col-${c.color}`, cx - bw / 2, y(acc + v), bw, y(acc) - y(acc + v), 1.5); acc += v; } }
    g += `<g aria-label="${esc(monthLabel(m) + ': ' + formatEuro(totals[i]))}"><title>${esc(monthLabel(m) + ': spese ' + formatEuro(totals[i]))}</title>${st}<text class="axis" x="${f1(cx)}" y="${H - 6}" text-anchor="middle">${esc(monthLabel(m, true))}</text></g>`;
  });
  return svg(H, 'Spese per categoria nei mesi', `${grid}${g}`);
}
export { addDays };
