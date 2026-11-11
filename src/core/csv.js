// Esportazione CSV italiana (separatore ";", decimali con virgola, BOM per Excel/Numbers). Nessuna libreria.
// Le celle di testo che iniziano con = + - @ vengono neutralizzate: protegge da "formula injection" se il file viene aperto in un foglio di calcolo.
const NEEDS_Q = /[";\r\n]/;
export function cell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return NEEDS_Q.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/** Centesimi → "1234,56" (nessun separatore di migliaia: più affidabile da importare). */
export function money(c) {
  if (!Number.isSafeInteger(c)) return '';
  const neg = c < 0, a = Math.abs(c);
  return `${neg ? '-' : ''}${Math.floor(a / 100)},${String(a % 100).padStart(2, '0')}`;
}
export const pct = (x) => (x == null || !Number.isFinite(x) ? '' : (Math.round(x * 1000) / 10).toFixed(1).replace('.', ','));
export function toCsv(headers, rows) {
  const line = (r) => r.map((v) => (typeof v === 'number' && Number.isSafeInteger(v) ? money(v) : cell(v))).join(';');
  return '﻿' + [headers.map(cell).join(';'), ...rows.map(line)].join('\r\n') + '\r\n';
}
