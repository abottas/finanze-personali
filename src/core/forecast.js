// Previsione di liquidità PRUDENTE: gli incassi non ancora ricevuti NON sono mai disponibili.
// Le serie "prudent" non li includono; la serie "withExpected" è solo informativa (scenario ottimistico).
// Le previsioni non toccano mai i saldi reali: sono calcolate al volo, mai memorizzate.
import { snapshot } from './derive.js';
import { addDays, addMonths, diffDays } from './dates.js';
import { budgetStatus } from './budget.js';
import { mulBp } from './money.js';

const STEP = { monthly: 1, quarterly: 3, yearly: 12 };
const next = (p, cur) => (p.recurrence === 'weekly' ? addDays(cur, 7) : addMonths(cur, STEP[p.recurrence], p.anchorDay));

export function expandPlanned(p, today, horizonEnd) {
  const out = [];
  // Scaduto e non pagato → impegno immediato (oggi).
  let cur = p.dueDate;
  for (let g = 0; g < 400; g++) {
    const eff = cur < today ? today : cur;
    if (eff > horizonEnd) break;
    out.push(eff);
    if (p.recurrence === 'none') break;
    cur = next(p, cur);
  }
  return out;
}

export function forecast(state, today, days = state.settings.forecastDays) {
  const end = addDays(today, days);
  const snap = snapshot(state);
  const events = []; // { date, kind, label, total, free, prudent }

  // Budget settimanale: considerato impegnato all'inizio di ogni settimana (prudente).
  const bs = budgetStatus(state, today);
  if (bs.baseCents > 0) {
    if (bs.started && bs.remainingCents > 0) events.push({ date: today, kind: 'budget', label: 'Budget settimana (residuo)', total: -bs.remainingCents, free: -bs.remainingCents, prudent: true });
    let ws = addDays(bs.weekStart, 7);
    while (ws <= end) {
      if (ws >= state.settings.budget.startDate) events.push({ date: ws, kind: 'budget', label: 'Budget settimanale', total: -bs.baseCents, free: -bs.baseCents, prudent: true });
      ws = addDays(ws, 7);
    }
  }

  // Acquisti programmati: il totale esce per intero; sul libero pesa solo la parte non coperta dal fondo.
  const fundLeft = {};
  for (const f of state.funds) fundLeft[f.id] = snap.funds[f.id].available;
  const occ = [];
  for (const p of state.planned) {
    if (p.status !== 'planned' || p.confirm === 'active') continue;   // "da confermare come attiva": non pesa finché non la confermi
    for (const d of expandPlanned(p, today, end)) occ.push({ p, d });
  }
  occ.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.p.id < b.p.id ? -1 : 1));
  for (const { p, d } of occ) {
    let covered = 0;
    if (p.fundId) {
      covered = Math.min(p.cents, fundLeft[p.fundId] ?? 0);
      fundLeft[p.fundId] -= covered;
    }
    events.push({ date: d, kind: 'planned', label: p.name, total: -p.cents, free: -(p.cents - covered), prudent: true, plannedId: p.id, covered });
  }

  // Incassi attesi: SOLO scenario ottimistico. Al netto degli accantonamenti fiscali configurati.
  const overdue = [];
  for (const r of state.receivables) {
    if (r.status !== 'expected' && r.status !== 'partial') continue;
    const remaining = r.expectedCents - (r.receivedCents ?? 0);
    if (remaining <= 0) continue;
    if (r.expectedDate < today) { overdue.push(r); continue; }
    if (r.expectedDate > end) continue;
    const tax = state.settings.taxRules.reduce((s, rule) => s + mulBp(remaining, rule.bp), 0);
    events.push({ date: r.expectedDate, kind: 'receivable', label: r.client, total: remaining, free: remaining - tax, prudent: false });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const points = [];
  let tP = snap.total, fP = snap.free, tO = snap.total, fO = snap.free;
  let ei = 0;
  for (let d = 0; d <= days; d++) {
    const date = addDays(today, d);
    while (ei < events.length && events[ei].date <= date) {
      const e = events[ei++];
      tO += e.total; fO += e.free;
      if (e.prudent) { tP += e.total; fP += e.free; }
    }
    points.push({ date, total: tP, free: fP, totalWithExpected: tO, freeWithExpected: fO });
  }

  const issues = [];
  // Con saldi "da aggiornare" i conti sconosciuti valgono 0 nei calcoli: segnalare scoperti sarebbe FALSO.
  // L'app lo dichiara e non emette allarmi di liquidità negativa finché i saldi non sono noti.
  const unknown = state.accounts.filter((a) => a.balanceUnknown && !a.archived);
  if (unknown.length) {
    issues.push({ kind: 'balances_unknown', severity: 'medium', date: today, cents: 0, message: `Previsioni parziali: aggiorna i saldi di ${unknown.map((a) => a.name).join(', ')}.` });
  } else {
    const firstNeg = (key) => points.find((p) => p[key] < 0);
    // Il giudizio prudente NON conta gli incassi attesi; si segnala se, ipoteticamente, li coprirebbero.
    const covered = (key) => points.every((p) => p[key] >= 0);
    const nf = firstNeg('free');
    const note = (c) => (c ? ' Gli incassi attesi la coprirebbero, ma non sono garantiti.' : '');
    if (nf) issues.push({ kind: 'free_negative', severity: covered('freeWithExpected') ? 'medium' : 'high', date: nf.date, cents: nf.free, coveredByExpected: covered('freeWithExpected'), message: 'Senza contare gli incassi attesi, la liquidità libera prevista diventa negativa.' + note(covered('freeWithExpected')) });
    const nt = firstNeg('total');
    if (nt && !(nf && covered('totalWithExpected') && covered('freeWithExpected'))) issues.push({ kind: 'total_negative', severity: covered('totalWithExpected') ? 'medium' : 'high', date: nt.date, cents: nt.total, coveredByExpected: covered('totalWithExpected'), message: 'Senza contare gli incassi attesi, il saldo complessivo previsto diventa negativo.' + note(covered('totalWithExpected')) });
    // Il libero di un conto non copre i vincoli di un altro senza un trasferimento: si controlla conto per conto.
    for (const a of state.accounts) {
      if (snap.freeByAccount[a.id] < 0) issues.push({ kind: 'account_overcommitted', severity: 'high', date: today, cents: snap.freeByAccount[a.id], message: `${a.name}: il denaro vincolato supera il saldo`, refId: a.id });
    }
  }

  for (const r of overdue) issues.push({ kind: 'receivable_overdue', severity: 'medium', date: r.expectedDate, cents: r.expectedCents - (r.receivedCents ?? 0), message: `Incasso in ritardo: ${r.client} (${diffDays(today, r.expectedDate)} gg)`, refId: r.id });

  for (const f of state.funds) {
    if (unknown.length) break;            // con saldi sconosciuti un "obiettivo a rischio" sarebbe un falso allarme
    if (f.archived || f.kind !== 'goal' || !f.goal?.deadline || f.goal.targetCents == null) continue;
    const dl = f.goal.deadline;
    if (dl > end) continue;
    const short = f.goal.targetCents - snap.funds[f.id].available;
    if (short <= 0) continue;
    const idx = Math.min(days, Math.max(0, diffDays(dl, today)));
    const freeAtDl = points[idx].free;
    if (short > Math.max(0, freeAtDl)) issues.push({ kind: 'goal_at_risk', severity: 'medium', date: dl, cents: short, message: `Obiettivo "${f.name}" a rischio: mancano ${short / 100} € e la liquidità libera prevista non basta`, refId: f.id });
  }

  let minFree = points[0]?.free ?? 0, minFreeDate = points[0]?.date ?? today;
  for (const p of points) if (p.free < minFree) { minFree = p.free; minFreeDate = p.date; }
  return { points, events, issues, minFree, minFreeDate, start: { total: snap.total, free: snap.free } };
}
