// Profilo personale iniziale: un FILE separato (mai nel repository) descrive conti, ruoli, fondi, regole di fatturazione
// e scadenze ricorrenti. Il codice qui è GENERICO: non contiene nessun dato personale.
// Formato documentato in docs/PROFILO.md. Tutto ciò che il profilo crea è modificabile dall'app senza perdere lo storico.
import { isCents } from './money.js';
import { isDate } from './dates.js';
import { BANKS, COLOR_KEYS } from './palette.js';

export const PROFILE_FORMAT = 'FP-PROFILE';
const isStr = (s, max = 120) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const optStr = (s, max = 300) => s == null || (typeof s === 'string' && s.length <= max);
const isKey = (s) => typeof s === 'string' && /^[a-z0-9_]{1,40}$/.test(s);

export function validateProfile(p) {
  const P = [];
  const bad = (m) => { if (P.length < 30) P.push(m); };
  if (!p || typeof p !== 'object' || p.format !== PROFILE_FORMAT) return ['Il file non è un profilo di questa app'];
  if (p.v !== 1) return [`Versione di profilo non supportata: ${p.v}`];
  const keys = (arr, what) => { const k = new Set(); for (const x of arr ?? []) { if (!isKey(x.key)) bad(`${what}: chiave non valida`); else if (k.has(x.key)) bad(`${what}: chiave duplicata ${x.key}`); k.add(x.key); } return k; };
  if (!Array.isArray(p.accounts) || p.accounts.length === 0) bad('Nessun conto nel profilo');
  const acc = keys(p.accounts, 'conto');
  for (const a of p.accounts ?? []) {
    if (!isStr(a.name, 80)) bad('conto: nome non valido');
    if (a.bank != null && !BANKS[a.bank]) bad(`conto ${a.key}: banca sconosciuta`);
    if (!optStr(a.role, 80)) bad(`conto ${a.key}: ruolo troppo lungo`);
    if (a.color != null && !COLOR_KEYS.includes(a.color)) bad(`conto ${a.key}: colore non valido`);
    if (a.openingCents != null && !isCents(a.openingCents)) bad(`conto ${a.key}: saldo non valido`);
    if (a.type != null && !['checking', 'savings', 'cash', 'investment', 'other'].includes(a.type)) bad(`conto ${a.key}: tipo non valido`);
  }
  const fk = keys(p.funds ?? [], 'fondo');
  for (const f of p.funds ?? []) {
    if (!isStr(f.name, 80)) bad('fondo: nome non valido');
    if (!['tax', 'goal', 'reserve'].includes(f.kind)) bad(`fondo ${f.key}: tipo non valido`);
    if (!acc.has(f.accountKey)) bad(`fondo ${f.key}: conto inesistente`);
    if (f.parentKey != null && !fk.has(f.parentKey)) bad(`fondo ${f.key}: fondo madre inesistente`);
    if (f.kind === 'goal') {
      const g = f.goal ?? {};
      if (g.targetCents != null && (!isCents(g.targetCents) || g.targetCents <= 0)) bad(`fondo ${f.key}: obiettivo non valido`);
      if (g.minCents != null && (g.targetCents == null || !isCents(g.minCents) || g.minCents <= 0 || g.minCents > g.targetCents)) bad(`fondo ${f.key}: minimo non valido`);
      if (![1, 2, 3].includes(g.priority ?? 2)) bad(`fondo ${f.key}: priorità non valida`);
      if (g.deadline != null && !isDate(g.deadline)) bad(`fondo ${f.key}: scadenza non valida`);
    }
  }
  if (p.taxProfile) {
    const t = p.taxProfile;
    for (const k of ['coefficientBp', 'inpsBp', 'taxBp']) if (!Number.isInteger(t[k]) || t[k] < 0 || t[k] > 10000) bad(`profilo fiscale: ${k} non valido`);
    if (!fk.has(t.fundKey)) bad('profilo fiscale: fondo inesistente');
  }
  if (p.budget && (!isCents(p.budget.weeklyCents) || p.budget.weeklyCents < 0)) bad('budget non valido');
  for (const t of p.invoiceTemplates ?? []) {
    if (!isStr(t.client, 80)) bad('fattura ricorrente: cliente non valido');
    if (!isCents(t.cents) || t.cents <= 0) bad(`fattura ${t.client}: importo non valido`);
    if (t.reserveCents != null && (!isCents(t.reserveCents) || t.reserveCents < 0 || t.reserveCents > t.cents)) bad(`fattura ${t.client}: riserva non valida`);
    if (!Number.isInteger(t.invoiceDay) || t.invoiceDay < 1 || t.invoiceDay > 28) bad(`fattura ${t.client}: giorno non valido`);
    if (!Number.isInteger(t.collectDays) || t.collectDays < 0 || t.collectDays > 180) bad(`fattura ${t.client}: giorni di incasso non validi`);
    if (!acc.has(t.accountKey)) bad(`fattura ${t.client}: conto inesistente`);
  }
  for (const x of p.planned ?? []) {
    if (!isStr(x.name, 80)) bad('scadenza: nome non valido');
    if (!isCents(x.cents) || x.cents <= 0) bad(`scadenza ${x.name}: importo non valido`);
    if (!['subscription', 'renewal', 'investment', 'purchase', 'extraordinary'].includes(x.kind)) bad(`scadenza ${x.name}: tipo non valido`);
    if (!['none', 'weekly', 'monthly', 'quarterly', 'yearly'].includes(x.recurrence)) bad(`scadenza ${x.name}: cadenza non valida`);
    if (!acc.has(x.accountKey)) bad(`scadenza ${x.name}: conto inesistente`);
    if (x.confirm != null && !['active', 'date'].includes(x.confirm)) bad(`scadenza ${x.name}: conferma non valida`);
    if (x.dueDay != null && (!Number.isInteger(x.dueDay) || x.dueDay < 1 || x.dueDay > 28)) bad(`scadenza ${x.name}: giorno non valido`);
    if (x.toAccountKey != null) {
      const dest = (p.accounts ?? []).find((a) => a.key === x.toAccountKey);
      if (!dest || dest.type !== 'investment') bad(`scadenza ${x.name}: la destinazione deve essere un conto di tipo investment`);
      if (x.toAccountKey === x.accountKey) bad(`scadenza ${x.name}: origine e destinazione coincidono`);
    }
    if (x.autoExecute && x.toAccountKey == null) bad(`scadenza ${x.name}: esecuzione automatica senza destinazione`);
  }
  return P;
}
