// Template HTML con escaping AUTOMATICO di ogni interpolazione (difesa da XSS su nomi/note inseriti dall'utente).
// Solo i valori restituiti da html``/raw() sono considerati già sicuri.
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => MAP[c]);

class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s));
const ser = (v) => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(ser).join('') : v == null || v === false ? '' : esc(v));
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += ser(vals[i]); });
  return new Safe(out);
}
export const isSafe = (v) => v instanceof Safe;
