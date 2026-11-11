// Budget settimanale con riporto. Può essere solo un TETTO DI SPESA oppure — se attivi il finanziamento — un FONDO vero:
// ogni settimana l'app riserva (virtualmente) il budget dal denaro libero del conto spese, e le spese lo consumano.
// Conta solo: uscite effettive, non annullate, in categorie "nel budget", NON legate a una scadenza programmata
// (affitto, abbonamenti… sono impegni a parte) e non pagate da un altro fondo.
import { addDays, weekStart } from './dates.js';

export function budgetStatus(state, today) {
  const b = state.settings.budget;
  const startsOn = state.settings.weekStartsOn;
  const cat = Object.fromEntries(state.categories.map((c) => [c.id, c]));
  const out = { started: false, weekStart: weekStart(today, startsOn), weekEnd: null, baseCents: b.weeklyCents, carryCents: 0, spentCents: 0, remainingCents: 0, weeks: [] };
  out.weekEnd = addDays(out.weekStart, 6);
  if (b.weeklyCents <= 0 || today < b.startDate) return out;
  out.started = true;

  const spentByWeek = new Map();
  for (const t of state.transactions) {
    if (t.status !== 'posted' || t.kind !== 'expense' || t.plannedId) continue;
    if (t.fundId && t.fundId !== b.fundId) continue;     // pagata da un altro fondo: non pesa sul budget
    if (cat[t.categoryId]?.inBudget === false) continue;
    if (t.date < b.startDate || t.date > today) continue;
    const ws = weekStart(t.date, startsOn);
    spentByWeek.set(ws, (spentByWeek.get(ws) ?? 0) - t.cents);
  }
  let ws = weekStart(b.startDate, startsOn);
  let carry = 0;
  for (let guard = 0; guard < 1100 && ws <= out.weekStart; guard++) {
    const spent = spentByWeek.get(ws) ?? 0;
    const remaining = b.weeklyCents + carry - spent;
    out.weeks.push({ weekStart: ws, base: b.weeklyCents, carry, spent, remaining });
    if (ws === out.weekStart) { out.carryCents = carry; out.spentCents = spent; out.remainingCents = remaining; break; }
    carry = b.carryOver ? (b.carryDeficit ? remaining : Math.max(0, remaining)) : 0;
    ws = addDays(ws, 7);
  }
  return out;
}

/**
 * Quanto dovrebbe esserci nel fondo budget all'inizio della settimana corrente:
 *   settimanale + riporto (avanzo riportato; sforo sottratto), mai meno di zero.
 * Le stesse regole di riporto che hai già configurato.
 */
export function budgetTargetLevel(state, today) {
  const st = budgetStatus(state, today);
  if (!st.started) return 0;
  return Math.max(0, st.baseCents + st.carryCents);
}
