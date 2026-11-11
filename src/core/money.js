// Importi SEMPRE in centesimi interi. Nessun float nei calcoli contabili.
import { AppError } from './errors.js';

export const MAX_CENTS = 1e12; // 10 miliardi di euro: ben dentro Number.MAX_SAFE_INTEGER
export const isCents = (n) => Number.isSafeInteger(n) && Math.abs(n) <= MAX_CENTS;

export function assertCents(n, label = 'Importo') {
  if (!isCents(n)) throw new AppError('importo_non_valido', `${label} non valido`);
  return n;
}

/**
 * Converte testo utente in centesimi. Accetta "1.234,56", "12,5", "12.50", "1234", "-3,00", "€ 5".
 * Rifiuta più di 2 decimali (nessun arrotondamento silenzioso). Ritorna null se non valido.
 */
export function parseEuro(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(/[€\s ]/g, '');
  if (!s) return null;
  let neg = false;
  if (s[0] === '-' || s[0] === '−') { neg = true; s = s.slice(1); }
  else if (s[0] === '+') s = s.slice(1);
  let intPart, frac = '';
  if (s.includes(',')) {
    const parts = s.split(',');
    if (parts.length !== 2) return null;
    [intPart, frac] = parts;
    if (!/^(\d{1,3}(\.\d{3})+|\d+)$/.test(intPart)) return null;
    intPart = intPart.replace(/\./g, '');
    if (frac !== '' && !/^\d{1,2}$/.test(frac)) return null;
  } else if (s.includes('.')) {
    if (/^\d+\.\d{1,2}$/.test(s)) [intPart, frac] = s.split('.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) intPart = s.replace(/\./g, '');
    else return null;
  } else {
    if (!/^\d+$/.test(s)) return null;
    intPart = s;
  }
  if (intPart.length > 11) return null;
  const cents = Number(intPart) * 100 + Number((frac + '00').slice(0, 2));
  if (!isCents(cents)) return null;
  return neg ? -cents : cents;
}

export function formatEuro(cents, { plus = false, symbol = true } = {}) {
  if (!Number.isSafeInteger(cents)) return '—';
  const neg = cents < 0;
  const a = Math.abs(cents);
  const int = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const frac = String(a % 100).padStart(2, '0');
  const sign = neg ? '−' : plus && cents > 0 ? '+' : '';
  return `${sign}${int},${frac}${symbol ? ' €' : ''}`;
}

/** Valore decimale per campi di input (es. "12,50"), senza simbolo né separatori migliaia. */
export function toInputValue(cents) {
  if (!Number.isSafeInteger(cents)) return '';
  const a = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(a / 100)},${String(a % 100).padStart(2, '0')}`;
}

/** cents * bp / 10000, arrotondato "half away from zero", in aritmetica BigInt (niente float). */
export function mulBp(cents, bp) {
  assertCents(cents);
  if (!Number.isInteger(bp) || bp < 0 || bp > 10000) throw new AppError('aliquota_non_valida', 'Aliquota non valida');
  const n = BigInt(cents) * BigInt(bp);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a + 5000n) / 10000n;
  return Number(neg ? -q : q);
}

export const sum = (arr) => arr.reduce((s, x) => s + x, 0);

/** cents × num / den, arrotondato "half away from zero", in BigInt (per riserve proporzionali). */
export function mulRatio(cents, num, den) {
  assertCents(cents);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0) throw new AppError('rapporto_non_valido', 'Rapporto non valido');
  const n = BigInt(cents) * BigInt(num);
  const d = BigInt(den);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a + d / 2n) / d;
  return Number(neg ? -q : q);
}
