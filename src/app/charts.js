// Grafico SVG della previsione di liquidità (nessuna libreria, nessuno stile inline).
import { html, raw } from './html.js';
import { formatEuro } from '../core/money.js';
import { formatDate, MONTHS } from '../core/dates.js';

export function forecastChart(f, { showExpected = false } = {}) {
  const W = 340, H = 150, PL = 8, PR = 8, PT = 10, PB = 20;
  const pts = f.points;
  const series = [pts.map((p) => p.free), pts.map((p) => p.total)];
  if (showExpected) series.push(pts.map((p) => p.freeWithExpected));
  const all = series.flat().concat(0);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = (i) => PL + (i / (pts.length - 1)) * (W - PL - PR);
  const y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const free = series[0];
  const area = `${path(free)} L${x(free.length - 1).toFixed(1)} ${y(Math.max(lo, 0)).toFixed(1)} L${x(0).toFixed(1)} ${y(Math.max(lo, 0)).toFixed(1)} Z`;
  const first = f.issues.find((i) => i.kind === 'free_negative');
  const dotIdx = first ? pts.findIndex((p) => p.date === first.date) : -1;
  const label = `Liquidità libera prevista da ${formatEuro(pts[0].free)} a ${formatEuro(pts.at(-1).free)}; minimo ${formatEuro(f.minFree)} il ${formatDate(f.minFreeDate)}.`;
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
    <line class="grid" x1="${PL}" x2="${W - PR}" y1="${y(hi - pad).toFixed(1)}" y2="${y(hi - pad).toFixed(1)}"/>
    ${Math.min(...all) < 0 ? raw(`<line class="zero" x1="${PL}" x2="${W - PR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`) : ''}
    <path class="area" d="${area}"/>
    <path class="l-total" d="${path(series[1])}"/>
    ${showExpected ? raw(`<path class="l-exp" d="${path(series[2])}"/>`) : ''}
    <path class="l-free" d="${path(free)}"/>
    ${dotIdx >= 0 ? raw(`<circle class="dot" cx="${x(dotIdx).toFixed(1)}" cy="${y(free[dotIdx]).toFixed(1)}" r="4"/>`) : ''}
    <text x="${PL}" y="${H - 5}">${formatDate(pts[0].date)}</text>
    <text x="${W / 2}" y="${H - 5}" text-anchor="middle">${formatDate(pts[Math.floor(pts.length / 2)].date)}</text>
    <text x="${W - PR}" y="${H - 5}" text-anchor="end">${formatDate(pts.at(-1).date)}</text>
  </svg>`;
}

/** Barre mensili raggruppate: incassi · spese · tasse stimate. */
export function earningsChart(series) {
  const W = 340, H = 150, PL = 6, PR = 6, PT = 8, PB = 20;
  const max = Math.max(1, ...series.flatMap((m) => [m.income, m.expense, m.tax]));
  const gw = (W - PL - PR) / series.length, bw = Math.min(14, (gw - 8) / 3);
  const h = (v) => Math.max(v > 0 ? 2 : 0, (v / max) * (H - PT - PB));
  const base = H - PB;
  const label = 'Incassi, spese e tasse stimate per mese: ' + series.map((m) => `${m.month}: incassi ${formatEuro(m.income)}, spese ${formatEuro(m.expense)}, tasse ${formatEuro(m.tax)}`).join('; ');
  const bars = series.map((m, i) => {
    const x0 = PL + i * gw + (gw - bw * 3 - 4) / 2;
    const bar = (j, v, cls) => `<rect class="${cls}" x="${(x0 + j * (bw + 2)).toFixed(1)}" y="${(base - h(v)).toFixed(1)}" width="${bw.toFixed(1)}" height="${h(v).toFixed(1)}" rx="3"/>`;
    return bar(0, m.income, 'b-inc') + bar(1, m.expense, 'b-exp') + bar(2, m.tax, 'b-tax') + `<text x="${(PL + i * gw + gw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${MONTHS[Number(m.month.slice(5)) - 1]}</text>`;
  }).join('');
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}"><line class="grid" x1="${PL}" x2="${W - PR}" y1="${base}" y2="${base}"/>${raw(bars)}</svg>`;
}
