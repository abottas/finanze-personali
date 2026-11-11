// Stima di imposte e contributi per lavoratore autonomo in regime forfettario con Gestione Separata INPS.
// Parametri tutti modificabili (aliquote e coefficienti cambiano: verificali ogni anno col tuo commercialista).
// Importi in centesimi, percentuali in punti base (26,07% = 2607). Nessun float.
//
// DUE COSE DIVERSE, da non confondere:
//  1) estimateTaxes(): stima TEORICA su UNA fattura (serve solo a suggerire quanto accantonare).
//     Non applica deduzioni: l'imposta sostitutiva si calcola sul reddito dell'INTERO anno.
//  2) estimateAnnual(): debito fiscale ANNUALE stimato, sul cumulato dell'anno (principio di cassa),
//     dove i contributi INPS effettivamente VERSATI nell'anno riducono il reddito su cui si calcola l'imposta.
//  La "riserva fiscale" che accantoni davvero è una scelta tua (regola personalizzata per cliente): terza cosa.
import { mulBp } from './money.js';

/** Stima teorica su una singola fattura (senza deduzione dei contributi: prudente). */
export function estimateTaxes(netCents, profile) {
  const base = mulBp(netCents, profile.coefficientBp);   // reddito imponibile lordo
  const inps = mulBp(base, profile.inpsBp);              // contributi: sul reddito imponibile lordo
  const imposta = mulBp(base, profile.taxBp);            // imposta: senza dedurre i contributi di questa fattura
  const total = inps + imposta;
  return { base, inps, imposta, total, netAfter: netCents - total };
}

/** Arrotonda al multiplo più vicino (default) di `step` centesimi. */
export function roundToStep(cents, step, mode = 'nearest') {
  if (step <= 1) return cents;
  const q = cents / step;
  return (mode === 'up' ? Math.ceil(q) : mode === 'down' ? Math.floor(q) : Math.round(q)) * step;
}

/** Quota teorica da accantonare: stima arrotondata, mai oltre l'importo. */
export function suggestedSetAside(netCents, profile) {
  const t = estimateTaxes(netCents, profile);
  return { ...t, setAside: Math.min(netCents, Math.max(0, roundToStep(t.total, profile.roundStepCents))) };
}

/**
 * Debito fiscale ANNUALE stimato (forfettario + Gestione Separata), per cassa:
 *  ricavi incassati nell'anno (categoria "Incassi professionali") → imponibile lordo = ricavi × coefficiente
 *  contributi maturati = imponibile lordo × aliquota INPS
 *  imposta = (imponibile lordo − contributi INPS VERSATI nell'anno) × aliquota imposta sostitutiva
 *  (i contributi sono deducibili nell'anno in cui sono versati: qui si usano i pagamenti registrati nella categoria
 *   "Contributi INPS versati"; nessuna deduzione se non risultano versamenti)
 * `scenarioInpsAllPaid`: imposta se tutti i contributi maturati venissero versati nell'anno (stima ottimistica).
 */
export function estimateAnnual(state, year, today = null) {
  const tp = state.settings.taxProfile;
  const inYear = (d) => d.slice(0, 4) === String(year) && (!today || d <= today);
  let ricavi = 0, inpsPaid = 0, impostaPaid = 0;
  for (const t of state.transactions) {
    if (t.status !== 'posted' || !inYear(t.date)) continue;
    if (t.kind === 'income' && t.categoryId === 'cat_pro') ricavi += t.cents;
    if (t.kind === 'expense' && t.categoryId === 'cat_inps') inpsPaid += -t.cents;
    if (t.kind === 'expense' && t.categoryId === 'cat_tax') impostaPaid += -t.cents;
  }
  const base = mulBp(ricavi, tp.coefficientBp);
  const inpsDue = mulBp(base, tp.inpsBp);
  const impostaDue = mulBp(Math.max(0, base - inpsPaid), tp.taxBp);
  const impostaNoDeduction = mulBp(base, tp.taxBp);
  const impostaIfAllInpsPaid = mulBp(Math.max(0, base - inpsDue), tp.taxBp);
  const totalDue = inpsDue + impostaDue;
  const paid = inpsPaid + impostaPaid;
  return { year, ricavi, base, inpsDue, inpsPaid, impostaDue, impostaNoDeduction, impostaIfAllInpsPaid, impostaPaid, totalDue, paid, stillDue: Math.max(0, totalDue - paid) };
}

/**
 * QUATTRO cose da tenere SEPARATE (non vanno mai sommate né confuse):
 *  1. stima fiscale        → quanto si prevede di dovere per l'anno (estimateAnnual)
 *  2. accantonamento       → quanto hai riservato (VIRTUALE) nel fondo fiscale: scelta personale, non una stima
 *  3. somme trasferite     → bonifici REALI confermati verso il conto del fondo fiscale
 *  4. debiti pagati        → contributi INPS e imposta effettivamente versati
 */
export function taxLedger(state, year, today = null) {
  const tp = state.settings.taxProfile;
  const estimate = estimateAnnual(state, year, today);
  const inYear = (d) => d.slice(0, 4) === String(year) && (!today || d <= today);
  const fund = state.funds.find((f) => f.id === tp.fundId) ?? null;
  let allocatedYear = 0, transferredYear = 0, reservedNow = 0;
  if (fund) {
    for (const a of state.allocations) if (a.fundId === fund.id && (a.kind === 'assign' || a.kind === 'release') && inYear(a.date)) allocatedYear += a.cents;
    for (const t of state.transfers) {
      if (t.status !== 'posted' || t.fundId !== fund.id || !inYear(t.date)) continue;
      if (t.toAccountId === fund.accountId) transferredYear += t.cents;
      if (t.fromAccountId === fund.accountId) transferredYear -= t.cents;
    }
    const by = {};
    for (const a of state.allocations) if (a.fundId === fund.id) by[a.accountId] = (by[a.accountId] ?? 0) + a.cents;
    for (const t of state.transactions) if (t.status === 'posted' && t.fundId === fund.id) by[t.accountId] = (by[t.accountId] ?? 0) + t.cents;
    reservedNow = Object.values(by).reduce((x, y) => x + y, 0);
  }
  return {
    year,
    estimate: { totalDue: estimate.totalDue, stillDue: estimate.stillDue, ricavi: estimate.ricavi, inpsDue: estimate.inpsDue, impostaDue: estimate.impostaDue },
    earmarked: { allocatedYear, reservedNow },
    transferred: { year: transferredYear },
    paid: { inps: estimate.inpsPaid, imposta: estimate.impostaPaid, total: estimate.paid },
    ratesVerified: tp.verifiedYear === year,
  };
}
