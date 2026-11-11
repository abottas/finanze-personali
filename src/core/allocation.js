// Suggerimento di allocazione: funzione PURA e deterministica.
// Ordine: 1) imposte/contributi (profilo fiscale o regole %), 2) fabbisogni urgenti (scadenza entro N giorni,
// per scadenza poi priorità), 3) il resto per priorità poi scadenza. Il resto rimane libero ("me lo tengo").
// Un fondo può stare su un altro conto: in quel caso l'item richiede un VERO trasferimento bancario dal conto
// che ha ricevuto i soldi (fromAccountId), che viene registrato separatamente dall'allocazione virtuale.
import { snapshot, fundNeed } from './derive.js';
import { mulBp, mulRatio, formatEuro } from './money.js';
import { diffDays, addMonths } from './dates.js';
import { suggestedSetAside } from './tax.js';

export function deadlineOf(state, fund) {
  if (fund.kind === 'goal') return fund.goal?.deadline ?? null;
  if (fund.kind === 'planned') return state.planned.find((p) => p.id === fund.plannedId)?.dueDate ?? null;
  return null;
}
function priorityOf(state, fund) {
  if (fund.kind === 'goal') return fund.goal?.priority ?? 2;
  if (fund.kind === 'planned') return state.planned.find((p) => p.id === fund.plannedId)?.priority ?? 2;
  return 3;
}

/** Quanto accantonare al mese per arrivare in tempo alla scadenza (null se non applicabile). */
export function monthlyPace(state, fund, snap, today) {
  const dl = deadlineOf(state, fund);
  if (!dl) return null;
  const need = fundNeed(state, fund, snap);
  if (need <= 0) return 0;
  let months = 0;
  while (months < 600 && addMonths(today, months + 1) <= dl) months++;
  const frac = diffDays(dl, addMonths(today, months));     // giorni residui oltre i mesi interi
  const m = months + (frac > 0 ? 1 : 0);
  return Math.ceil(need / Math.max(1, m));
}

export function proposeAllocation(state, { accountId, cents, today, professional = false, receivable = null }) {
  const snap = snapshot(state);
  const cap = Math.max(0, Math.min(cents, snap.freeByAccount[accountId] ?? 0));
  let left = cap;
  const items = [];
  const taken = {};
  // Ogni voce è un vincolo VIRTUALE sul denaro libero di `accountId`. Se il fondo "abita" su un altro conto,
  // `pendingTransferTo` indica il bonifico da fare (e confermare) in seguito: non viene registrato nulla.
  const push = (fund, amount, reason, detail) => {
    if (amount <= 0) return;
    taken[fund.id] = (taken[fund.id] ?? 0) + amount;
    left -= amount;
    items.push({ fundId: fund.id, name: fund.name, icon: fund.icon, color: fund.color, cents: amount, reason, detail, accountId, pendingTransferTo: fund.accountId !== accountId ? fund.accountId : null });
  };

  const tp = state.settings.taxProfile;
  let taxInfo = null;
  if (professional && tp.enabled) {
    const f = state.funds.find((x) => x.id === tp.fundId);
    if (f && !f.archived) {
      const theo = suggestedSetAside(cents, tp);
      const r = receivable;
      let amount = theo.setAside, detail, mode = 'theoretical', info = {};
      if (r && r.reserveCents != null) {
        // Riserva FISSA di default. Parziale → quota proporzionale a quanto effettivamente incassato.
        // Importo definitivo diverso dal previsto → riserva fissa predefinita, con alternative a scelta dell'utente.
        const planned = r.reserveCents;
        const done = state.allocations.filter((a) => a.receivableId === r.id).reduce((t, a) => t + a.cents, 0);
        const remaining = Math.max(0, planned - done);
        const got = r.receivedCents ?? cents;                  // totale incassato finora (questo incasso incluso)
        const propThis = Math.min(remaining, mulRatio(planned, cents, r.expectedCents));
        const propFinal = Math.max(0, mulRatio(planned, got, r.expectedCents) - done);
        const theoFinal = Math.max(0, suggestedSetAside(got, tp).setAside - done);
        if (r.status === 'partial') {
          mode = 'partial'; amount = propThis;
          detail = `incasso parziale: ${formatEuro(cents)} su ${formatEuro(r.expectedCents)} → quota proporzionale ${formatEuro(propThis)} della riserva prevista ${formatEuro(planned)}`;
        } else if (got === r.expectedCents) {
          mode = 'full'; amount = remaining;
          detail = `riserva fissa ${formatEuro(planned)}${done ? ` (già accantonati ${formatEuro(done)}, restano ${formatEuro(remaining)})` : ''}`;
        } else {
          mode = 'definitive_diff'; amount = remaining;
          detail = `importo definitivo ${formatEuro(got)} diverso dal previsto ${formatEuro(r.expectedCents)}: riserva fissa ${formatEuro(remaining)} (puoi ricalcolarla)`;
        }
        info = { planned, done, remaining, propThis, propFinal, theoFinal, fixed: remaining, got, remainingAfter: Math.max(0, remaining - Math.min(amount, left)) };
      } else {
        detail = `stima teorica: INPS ${formatEuro(theo.inps)} + imposta ${formatEuro(theo.imposta)} = ${formatEuro(theo.total)}${theo.setAside !== theo.total ? `, arrotondata a ${formatEuro(theo.setAside)}` : ''}`;
      }
      const used = Math.min(amount, left);
      taxInfo = { ...theo, ...info, mode, custom: r?.reserveCents ?? null, used, differsFromExpected: !!r && r.status === 'received' && (r.receivedCents ?? cents) !== r.expectedCents };
      push(f, used, 'tax', detail);
      if (r) items[items.length - 1] && (items[items.length - 1].receivableId = r.id);
    }
    // Il resto dell'incasso è disponibilità personale: nessun altro fondo viene proposto in automatico.
    return { items, allocatedCents: cap - left, remainderCents: left, requestedCents: cents, cappedByFree: cap < cents, taxInfo };
  }
  for (const rule of state.settings.taxRules) {
    const f = state.funds.find((x) => x.id === rule.fundId);
    if (!f || f.archived) continue;
    push(f, Math.min(mulBp(cents, rule.bp), left), 'tax', `${(rule.bp / 100).toLocaleString('it-IT')}% dell'importo (regola "${rule.name}")`);
  }

  const needs = state.funds
    .filter((f) => !f.archived && f.kind !== 'tax')
    .map((f) => {
      const need = fundNeed(state, f, snap) - (taken[f.id] ?? 0);
      const dl = deadlineOf(state, f);
      return { f, need, dl, pr: priorityOf(state, f), urgent: dl != null && diffDays(dl, today) <= state.settings.urgentDays };
    })
    .filter((n) => n.need > 0);
  const byDl = (a, b) => (a.dl ?? '9999-12-31') < (b.dl ?? '9999-12-31') ? -1 : (a.dl ?? '9999-12-31') > (b.dl ?? '9999-12-31') ? 1 : 0;
  const byPr = (a, b) => a.pr - b.pr;
  const byName = (a, b) => (a.f.name + a.f.id < b.f.name + b.f.id ? -1 : 1);
  const urgent = needs.filter((n) => n.urgent).sort((a, b) => byDl(a, b) || byPr(a, b) || byName(a, b));
  const rest = needs.filter((n) => !n.urgent).sort((a, b) => byPr(a, b) || byDl(a, b) || byName(a, b));
  for (const n of urgent) push(n.f, Math.min(n.need, left), 'urgent', n.dl ? `scade tra ${Math.max(0, diffDays(n.dl, today))} giorni` : 'urgente');
  for (const n of rest) push(n.f, Math.min(n.need, left), 'priority', `priorità ${n.pr}`);

  return { items, allocatedCents: cap - left, remainderCents: left, requestedCents: cents, cappedByFree: cap < cents, taxInfo };
}
