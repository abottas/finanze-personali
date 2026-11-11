// Date "calendario" come stringhe YYYY-MM-DD (nessun fuso orario, nessun orario).
const RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86400000;

export function isDate(s) {
  if (typeof s !== 'string') return false;
  const m = RE.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2200) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
const parts = (s) => { const m = RE.exec(s); return [+m[1], +m[2], +m[3]]; };
export const toDays = (s) => { const [y, m, d] = parts(s); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
export const fromDays = (n) => new Date(n * DAY).toISOString().slice(0, 10);
export const addDays = (s, n) => fromDays(toDays(s) + n);
export const diffDays = (a, b) => toDays(a) - toDays(b);
export const weekday = (s) => new Date(toDays(s) * DAY).getUTCDay(); // 0 = domenica

export function weekStart(s, startsOn = 1) {
  return addDays(s, -((weekday(s) - startsOn + 7) % 7));
}
export function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/** Somma mesi con clamp a fine mese; `anchorDay` evita la deriva (31 gen → 28 feb → 31 mar). */
export function addMonths(s, n, anchorDay = null) {
  const [y, m, d] = parts(s);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Data locale odierna (l'utente ragiona in ora locale). */
export function today(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
export const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
export function formatDate(s, { year = false } = {}) {
  if (!isDate(s)) return '—';
  const [y, m, d] = parts(s);
  return `${d} ${MONTHS[m - 1]}${year ? ' ' + y : ''}`;
}
export function formatDateLong(s) {
  if (!isDate(s)) return '—';
  const [y, m, d] = parts(s);
  return `${WEEKDAYS[weekday(s)]} ${d} ${MONTHS[m - 1]} ${y}`;
}
