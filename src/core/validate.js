// Validazione strutturale e invarianti "duri". Usata dopo OGNI comando, al caricamento
// e al ripristino di un backup. Ritorna un array di problemi (vuoto = ok).
import { isCents } from './money.js';
import { isDate } from './dates.js';
import { SCHEMA_VERSION } from './state.js';
import { COLOR_KEYS, LOGO_RE, MAX_LOGO_CHARS } from './palette.js';

const COLLECTIONS = ['categories', 'accounts', 'transactions', 'transfers', 'funds', 'allocations', 'receivables', 'invoiceTemplates', 'planned', 'reconciliations', 'audit'];
const isStr = (s, max = 200) => typeof s === 'string' && s.length <= max;
const isId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 64;
const okColor = (c) => c == null || COLOR_KEYS.includes(c);
const okIcon = (i) => i == null || (typeof i === 'string' && i.length <= 12);
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

export function validateState(st) {
  const P = [];
  const bad = (m) => { if (P.length < 50) P.push(m); };
  if (!st || typeof st !== 'object') return ['stato assente'];
  if (st.schemaVersion !== SCHEMA_VERSION) return [`versione schema non supportata: ${st.schemaVersion}`];
  for (const c of COLLECTIONS) if (!Array.isArray(st[c])) return [`collezione mancante: ${c}`];
  if (!st.meta || typeof st.meta !== 'object') return ['meta mancante'];
  if (!st.settings || typeof st.settings !== 'object') return ['impostazioni mancanti'];

  const ids = {};
  for (const c of COLLECTIONS) {
    if (c === 'audit') continue;
    const set = (ids[c] = new Set());
    for (const x of st[c]) {
      if (!x || !isId(x.id)) { bad(`${c}: id non valido`); continue; }
      if (set.has(x.id)) bad(`${c}: id duplicato ${x.id}`);
      set.add(x.id);
    }
  }
  const has = (c, id) => ids[c].has(id);

  for (const a of st.accounts) {
    if (!isStr(a.name, 80) || !a.name.trim()) bad(`conto ${a.id}: nome non valido`);
    if (!isCents(a.openingCents)) bad(`conto ${a.id}: saldo iniziale non valido`);
    if (!isDate(a.openingDate)) bad(`conto ${a.id}: data iniziale non valida`);
    if (!['checking', 'savings', 'cash', 'investment', 'other'].includes(a.type)) bad(`conto ${a.id}: tipo non valido`);
    if (!okColor(a.color) || !okIcon(a.emoji)) bad(`conto ${a.id}: aspetto non valido`);
    if (a.bank != null && !isStr(a.bank, 40)) bad(`conto ${a.id}: banca non valida`);
    if (a.role != null && !isStr(a.role, 80)) bad(`conto ${a.id}: ruolo non valido`);
    if (typeof a.balanceUnknown !== 'boolean') bad(`conto ${a.id}: stato del saldo non valido`);
    if (a.logo != null && (typeof a.logo !== 'string' || a.logo.length > MAX_LOGO_CHARS || !LOGO_RE.test(a.logo))) bad(`conto ${a.id}: logo non valido`);
  }
  for (const c of st.categories) {
    if (!isStr(c.name, 80) || !['expense', 'income', 'investment', 'adjustment'].includes(c.kind)) bad(`categoria ${c.id} non valida`);
    if (!okColor(c.color) || !okIcon(c.icon)) bad(`categoria ${c.id}: aspetto non valido`);
    if (c.parentId != null && (!has('categories', c.parentId) || c.parentId === c.id)) bad(`categoria ${c.id}: categoria madre non valida`);
  }
  for (const t of st.transactions) {
    if (!has('accounts', t.accountId)) bad(`movimento ${t.id}: conto inesistente`);
    if (!isDate(t.date)) bad(`movimento ${t.id}: data non valida`);
    if (!isCents(t.cents) || t.cents === 0) bad(`movimento ${t.id}: importo non valido`);
    else if (t.kind === 'income' && t.cents < 0) bad(`movimento ${t.id}: entrata con segno negativo`);
    else if ((t.kind === 'expense' || t.kind === 'investment') && t.cents > 0) bad(`movimento ${t.id}: uscita con segno positivo`);
    if (!['income', 'expense', 'investment', 'adjustment'].includes(t.kind)) bad(`movimento ${t.id}: tipo non valido`);
    if (!['posted', 'void'].includes(t.status)) bad(`movimento ${t.id}: stato non valido`);
    if (t.categoryId != null && !has('categories', t.categoryId)) bad(`movimento ${t.id}: categoria inesistente`);
    if (t.fundId != null) {
      if (!has('funds', t.fundId)) bad(`movimento ${t.id}: fondo inesistente`);
      if (t.kind !== 'expense') bad(`movimento ${t.id}: solo le uscite possono usare un fondo`);
    }
    if (t.receivableId != null && !has('receivables', t.receivableId)) bad(`movimento ${t.id}: incasso inesistente`);
    if (!isStr(t.note ?? '', 500)) bad(`movimento ${t.id}: nota troppo lunga`);
  }
  for (const t of st.transfers) {
    if (!has('accounts', t.fromAccountId) || !has('accounts', t.toAccountId)) bad(`trasferimento ${t.id}: conto inesistente`);
    if (t.fromAccountId === t.toAccountId) bad(`trasferimento ${t.id}: stesso conto`);
    if (!isCents(t.cents) || t.cents <= 0) bad(`trasferimento ${t.id}: importo non valido`);
    if (!isDate(t.date)) bad(`trasferimento ${t.id}: data non valida`);
    if (t.purpose != null && !['fund', 'saving', 'investment'].includes(t.purpose)) bad(`trasferimento ${t.id}: scopo non valido`);
    if (t.plannedId != null && !has('planned', t.plannedId)) bad(`trasferimento ${t.id}: scadenza inesistente`);
    if (t.fundId != null && !has('funds', t.fundId)) bad(`trasferimento ${t.id}: fondo inesistente`);
    if (!['posted', 'void'].includes(t.status)) bad(`trasferimento ${t.id}: stato non valido`);
  }
  for (const f of st.funds) {
    if (!has('accounts', f.accountId)) bad(`fondo ${f.id}: conto inesistente`);
    if (!isStr(f.name, 80) || !f.name.trim()) bad(`fondo ${f.id}: nome non valido`);
    if (!['goal', 'tax', 'planned', 'reserve', 'budget'].includes(f.kind)) bad(`fondo ${f.id}: tipo non valido`);
    if (f.goal != null) {
      const g = f.goal;
      if (g.targetCents !== null && (!isCents(g.targetCents) || g.targetCents <= 0)) bad(`fondo ${f.id}: obiettivo non valido`);  // null = "da definire"
      if (g.minCents != null && (!isCents(g.minCents) || g.minCents <= 0 || g.targetCents === null || g.minCents > g.targetCents)) bad(`fondo ${f.id}: minimo dell'obiettivo non valido`);
      if (![1, 2, 3].includes(g.priority)) bad(`fondo ${f.id}: priorità non valida`);
      if (g.deadline != null && !isDate(g.deadline)) bad(`fondo ${f.id}: scadenza non valida`);
    }
    if (f.kind === 'goal' && !f.goal) bad(`fondo ${f.id}: obiettivo mancante`);
    if (f.parentId != null && (!has('funds', f.parentId) || f.parentId === f.id)) bad(`fondo ${f.id}: fondo madre non valido`);
    if (f.refillFundId != null) { const rf = st.funds.find((x) => x.id === f.refillFundId); if (!rf || rf.kind !== 'goal' || rf.id === f.id) bad(`fondo ${f.id}: fondo di reintegro non valido`); }
    if (!okColor(f.color) || !okIcon(f.icon)) bad(`fondo ${f.id}: aspetto non valido`);
  }
  for (const a of st.allocations) {
    if (!has('funds', a.fundId)) bad(`allocazione ${a.id}: fondo inesistente`);
    if (!has('accounts', a.accountId)) bad(`allocazione ${a.id}: conto inesistente`);
    if (a.receivableId != null && !has('receivables', a.receivableId)) bad(`allocazione ${a.id}: incasso inesistente`);
    if (st.accounts.find((x) => x.id === a.accountId)?.type === 'investment') bad(`allocazione ${a.id}: non si riserva denaro su un conto di investimento`);
    if (!isCents(a.cents) || a.cents === 0) bad(`allocazione ${a.id}: importo non valido`);
    if (!isDate(a.date)) bad(`allocazione ${a.id}: data non valida`);
  }
  for (const r of st.receivables) {
    if (!has('accounts', r.accountId)) bad(`incasso ${r.id}: conto inesistente`);
    if (!isCents(r.expectedCents) || r.expectedCents <= 0) bad(`incasso ${r.id}: importo atteso non valido`);
    if (!isDate(r.expectedDate)) bad(`incasso ${r.id}: data attesa non valida`);
    if (r.reserveCents != null && (!isCents(r.reserveCents) || r.reserveCents < 0 || r.reserveCents > r.expectedCents)) bad(`incasso ${r.id}: riserva fiscale non valida`);
    if (!['expected', 'partial', 'received', 'cancelled'].includes(r.status)) bad(`incasso ${r.id}: stato non valido`);
    if (r.invoiceDate != null && !isDate(r.invoiceDate)) bad(`incasso ${r.id}: data fattura non valida`);
    if (r.templateKey != null && !isStr(r.templateKey, 80)) bad(`incasso ${r.id}: chiave non valida`);
    // Incassi: possono essere parziali. Lo stato deve essere coerente con i movimenti realmente collegati.
    const linked = st.transactions.filter((t) => t.receivableId === r.id && t.status === 'posted');
    const got = linked.reduce((x, t) => x + t.cents, 0);
    if (r.status === 'expected' || r.status === 'cancelled') {
      if (r.status === 'expected' && linked.length) bad(`incasso ${r.id}: atteso ma con movimenti collegati`);
    } else {
      if (!linked.length) bad(`incasso ${r.id}: ${r.status} ma senza movimento valido`);
      else if (r.receivedCents !== got) bad(`incasso ${r.id}: importo incassato non coerente con i movimenti`);
      if (r.status === 'partial' && got >= r.expectedCents) bad(`incasso ${r.id}: parziale ma già completo`);
    }
  }
  const tplKeys = new Set();
  for (const r of st.receivables) if (r.templateKey) { if (tplKeys.has(r.templateKey)) bad(`incasso ${r.id}: fattura ricorrente duplicata`); tplKeys.add(r.templateKey); }
  for (const t of st.invoiceTemplates) {
    if (!isStr(t.client, 80) || !t.client.trim()) bad(`fattura ricorrente ${t.id}: cliente non valido`);
    if (!isCents(t.cents) || t.cents <= 0) bad(`fattura ricorrente ${t.id}: importo non valido`);
    if (!Number.isInteger(t.invoiceDay) || t.invoiceDay < 1 || t.invoiceDay > 28) bad(`fattura ricorrente ${t.id}: giorno non valido`);
    if (!Number.isInteger(t.collectDays) || t.collectDays < 0 || t.collectDays > 180) bad(`fattura ricorrente ${t.id}: giorni di incasso non validi`);
    if (!has('accounts', t.accountId)) bad(`fattura ricorrente ${t.id}: conto inesistente`);
    if (typeof t.review !== 'boolean' || !isStr(t.note ?? '', 300)) bad(`fattura ricorrente ${t.id}: dati non validi`);
    if (t.reserveCents != null && (!isCents(t.reserveCents) || t.reserveCents < 0 || t.reserveCents > t.cents)) bad(`fattura ricorrente ${t.id}: riserva fiscale non valida`);
  }
  for (const p of st.planned) {
    if (!has('accounts', p.accountId)) bad(`acquisto ${p.id}: conto inesistente`);
    if (!isCents(p.cents) || p.cents <= 0) bad(`acquisto ${p.id}: importo non valido`);
    if (!isDate(p.dueDate)) bad(`acquisto ${p.id}: scadenza non valida`);
    if (![1, 2, 3].includes(p.priority)) bad(`acquisto ${p.id}: priorità non valida`);
    if (!['none', 'weekly', 'monthly', 'quarterly', 'yearly'].includes(p.recurrence)) bad(`acquisto ${p.id}: ricorrenza non valida`);
    if (p.confirm != null && !['active', 'date'].includes(p.confirm)) bad(`acquisto ${p.id}: stato di conferma non valido`);
    if (!['purchase', 'extraordinary', 'subscription', 'renewal', 'investment'].includes(p.kind)) bad(`acquisto ${p.id}: tipo non valido`);
    if (p.categoryId != null && !has('categories', p.categoryId)) bad(`acquisto ${p.id}: categoria inesistente`);
    if (!Number.isInteger(p.remindDays) || p.remindDays < 0 || p.remindDays > 30) bad(`acquisto ${p.id}: promemoria non valido`);
    if (!['planned', 'done', 'cancelled'].includes(p.status)) bad(`acquisto ${p.id}: stato non valido`);
    if (p.fundId != null && !has('funds', p.fundId)) bad(`acquisto ${p.id}: fondo inesistente`);
    if (p.toAccountId != null) {
      const to = st.accounts.find((x) => x.id === p.toAccountId);
      if (!to || to.type !== 'investment' || p.toAccountId === p.accountId) bad(`acquisto ${p.id}: la destinazione deve essere un conto di investimento diverso dall'origine`);
    }
    if (typeof p.autoExecute !== 'boolean' || (p.autoExecute && p.toAccountId == null)) bad(`acquisto ${p.id}: esecuzione automatica non valida`);
  }
  for (const r of st.reconciliations) {
    if (!has('accounts', r.accountId) || !isDate(r.date) || !isCents(r.bankCents)) bad(`quadratura ${r.id} non valida`);
  }

  // Invariante dura: la riserva di un fondo SU CIASCUN CONTO non può mai essere negativa
  // (si spenderebbe, da quel conto, denaro che il fondo non vi aveva riservato).
  const avail = {};
  const add = (f, a, c) => { if (!Number.isSafeInteger(c)) return; const k = f + '|' + a; avail[k] = (avail[k] ?? 0) + c; };
  for (const a of st.allocations) add(a.fundId, a.accountId, a.cents);
  for (const t of st.transactions) if (t.status === 'posted' && t.fundId != null) add(t.fundId, t.accountId, t.cents);
  for (const f of st.funds) for (const a of st.accounts) if ((avail[f.id + '|' + a.id] ?? 0) < 0) bad(`fondo "${f.name}": riserva negativa su ${a.name}`);

  const s = st.settings;
  if (!Number.isInteger(s.weekStartsOn) || s.weekStartsOn < 0 || s.weekStartsOn > 6) bad('impostazioni: inizio settimana non valido');
  if (!Number.isInteger(s.autoLockSec) || s.autoLockSec < 15 || s.autoLockSec > 3600) bad('impostazioni: blocco automatico non valido');
  if (!Number.isInteger(s.hiddenLockSec) || s.hiddenLockSec < 0 || s.hiddenLockSec > 3600) bad('impostazioni: blocco in background non valido');
  if (!Number.isInteger(s.forecastDays) || s.forecastDays < 7 || s.forecastDays > 365) bad('impostazioni: orizzonte previsione non valido');
  if (!Number.isInteger(s.urgentDays) || s.urgentDays < 0 || s.urgentDays > 365) bad('impostazioni: giorni urgenza non validi');
  if (!Number.isInteger(s.backupReminderDays) || s.backupReminderDays < 1 || s.backupReminderDays > 365) bad('impostazioni: promemoria backup non valido');
  const b = s.budget;
  if (!b || !isCents(b.weeklyCents) || b.weeklyCents < 0 || !isDate(b.startDate)) bad('impostazioni: budget non valido');
  else {
    if (b.accountId != null && !has('accounts', b.accountId)) bad('budget: conto inesistente');
    if (b.fundId != null && (!has('funds', b.fundId) || st.funds.find((f) => f.id === b.fundId)?.kind !== 'budget')) bad('budget: fondo inesistente o non di tipo budget');
    if (b.lastFundedWeek != null && !isDate(b.lastFundedWeek)) bad('budget: data di finanziamento non valida');
  }
  if (!Array.isArray(s.taxRules)) bad('impostazioni: regole fiscali mancanti');
  else for (const r of s.taxRules) {
    if (!isId(r.id) || !Number.isInteger(r.bp) || r.bp < 0 || r.bp > 10000) bad('regola fiscale: aliquota non valida');
    if (!has('funds', r.fundId)) bad('regola fiscale: fondo inesistente');
  }
  const tp = s.taxProfile;
  if (!tp || ![tp.coefficientBp, tp.inpsBp, tp.taxBp].every((x) => Number.isInteger(x) && x >= 0 && x <= 10000)) bad('profilo fiscale: aliquote non valide');
  else {
    if (!Number.isInteger(tp.roundStepCents) || tp.roundStepCents < 1 || tp.roundStepCents > 100000) bad('profilo fiscale: arrotondamento non valido');
    if (tp.fundId != null && !has('funds', tp.fundId)) bad('profilo fiscale: fondo inesistente');
    if (tp.verifiedYear != null && !Number.isInteger(tp.verifiedYear)) bad('profilo fiscale: anno di verifica non valido');
    if (tp.enabled && tp.fundId == null) bad('profilo fiscale attivo senza fondo di destinazione');
  }
  if (!isIso(st.meta.createdAt)) bad('meta: data creazione non valida');

  let seq = 0;
  for (const e of st.audit) if (e.seq !== ++seq) { bad('storico: sequenza non contigua'); break; }
  return P;
}
