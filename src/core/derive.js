// Tutto ciò che è "derivato" nasce qui, mai memorizzato:
//   saldo conto   = saldo iniziale + movimenti effettivi + trasferimenti
//   fondo         = assegnato (allocazioni) − speso (uscite collegate al fondo)
//   libero        = saldo − somma dei disponibili dei fondi di quel conto
// Un importo può stare in un solo posto: o "libero" o in UN fondo (il libero è per differenza).
export function balanceOf(state, accountId, asOf = null) {
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) return 0;
  let b = acc.openingCents;
  for (const t of state.transactions) {
    if (t.status !== 'posted' || t.accountId !== accountId) continue;
    if (asOf && t.date > asOf) continue;
    b += t.cents;
  }
  for (const t of state.transfers) {
    if (t.status !== 'posted') continue;
    if (asOf && t.date > asOf) continue;
    if (t.toAccountId === accountId) b += t.cents;
    if (t.fromAccountId === accountId) b -= t.cents;
  }
  return b;
}

export function snapshot(state) {
  const balances = {}, byAcct = {}, spentTot = {}, assignedTot = {};
  for (const a of state.accounts) balances[a.id] = a.openingCents;
  for (const t of state.transactions) {
    if (t.status !== 'posted') continue;
    if (t.accountId in balances) balances[t.accountId] += t.cents;
    if (t.fundId) {
      spentTot[t.fundId] = (spentTot[t.fundId] ?? 0) - t.cents;
      const m = (byAcct[t.fundId] ??= {}); m[t.accountId] = (m[t.accountId] ?? 0) + t.cents; // la spesa riduce la riserva del conto da cui esce
    }
  }
  for (const t of state.transfers) {
    if (t.status !== 'posted') continue;
    if (t.toAccountId in balances) balances[t.toAccountId] += t.cents;
    if (t.fromAccountId in balances) balances[t.fromAccountId] -= t.cents;
  }
  for (const al of state.allocations) {
    assignedTot[al.fundId] = (assignedTot[al.fundId] ?? 0) + al.cents;
    const m = (byAcct[al.fundId] ??= {}); m[al.accountId] = (m[al.accountId] ?? 0) + al.cents;
  }

  // Una allocazione è un vincolo VIRTUALE su un conto preciso: il fondo può avere riserve su più conti.
  const funds = {};
  const reservedByAccount = {};
  const reservedByKind = { goal: 0, tax: 0, planned: 0, reserve: 0, budget: 0 };
  let reserved = 0;
  for (const f of state.funds) {
    const as = assignedTot[f.id] ?? 0, sp = spentTot[f.id] ?? 0;
    const byAccount = byAcct[f.id] ?? {};
    funds[f.id] = { assigned: as, spent: sp, available: as - sp, byAccount };
    for (const [acc, c] of Object.entries(byAccount)) reservedByAccount[acc] = (reservedByAccount[acc] ?? 0) + c;
    reservedByKind[f.kind] += as - sp;
    reserved += as - sp;
  }
  // I conti di INVESTIMENTO (es. la tasca PAC) fanno parte del patrimonio ma NON della liquidità: il "libero" non li conta.
  const freeByAccount = {};
  let total = 0, invested = 0;
  for (const a of state.accounts) {
    total += balances[a.id];
    if (a.type === 'investment') { invested += balances[a.id]; freeByAccount[a.id] = 0; }
    else freeByAccount[a.id] = balances[a.id] - (reservedByAccount[a.id] ?? 0);
  }
  const liquid = total - invested;
  return { balances, funds, reservedByAccount, freeByAccount, reservedByKind, total, invested, liquid, reserved, free: liquid - reserved };
}

/**
 * Bonifici DA CONFERMARE: la riserva di un fondo sta (virtualmente) su un conto diverso da quello di
 * riferimento del fondo. Non è un trasferimento eseguito: lo diventa solo quando l'utente lo conferma.
 */
export function pendingTransfers(state, snap) {
  const out = [];
  for (const f of state.funds) {
    if (f.archived) continue;
    for (const [acc, cents] of Object.entries(snap.funds[f.id].byAccount)) {
      if (acc !== f.accountId && cents > 0) out.push({ fundId: f.id, fromAccountId: acc, toAccountId: f.accountId, cents });
    }
  }
  return out;
}

/** Importo obiettivo di un fondo (0 se non ha un obiettivo o è "da definire"). */
export function fundTarget(state, fund) {
  if (fund.kind === 'goal') return fund.goal?.targetCents ?? 0;
  if (fund.kind === 'planned' && fund.plannedId) {
    const p = state.planned.find((x) => x.id === fund.plannedId);
    return p && p.status === 'planned' ? p.cents : 0;
  }
  return 0;
}
/** Sotto-fondi inclusi nel budget del fondo (es. abbigliamento dentro il viaggio). */
export const childFunds = (state, fund) => state.funds.filter((k) => !k.archived && k.parentId === fund.id);

/**
 * Fabbisogno residuo di un fondo. Un sotto-fondo è INCLUSO nel budget del fondo madre: la quota del figlio
 * (il maggiore tra il suo obiettivo e quanto ha già) si toglie dal fabbisogno del padre, così lo stesso
 * euro non viene richiesto due volte (padre 1.300 con figlio 150: in totale servono 1.300, non 1.450).
 */
export function fundNeed(state, fund, snap) {
  const own = snap.funds[fund.id]?.available ?? 0;
  const target = fundTarget(state, fund);
  const kids = childFunds(state, fund).reduce((t, k) => t + Math.max(fundTarget(state, k), snap.funds[k.id]?.available ?? 0), 0);
  return Math.max(0, target - kids - own);
}
/** Avanzamento complessivo (fondo + sotto-fondi inclusi) rispetto all'obiettivo. */
export function fundProgress(state, fund, snap) {
  const own = snap.funds[fund.id]?.available ?? 0;
  const kids = childFunds(state, fund).reduce((t, k) => t + (snap.funds[k.id]?.available ?? 0), 0);
  return { have: own + kids, target: fundTarget(state, fund) };
}

/** Riserva fiscale di un incasso: prevista (regola), già accantonata (allocazioni collegate), residua. */
export function reserveProgress(state, receivable) {
  const planned = receivable.reserveCents ?? null;
  const done = state.allocations.filter((a) => a.receivableId === receivable.id).reduce((t, a) => t + a.cents, 0);
  return { planned, done, remaining: planned == null ? null : Math.max(0, planned - done) };
}
