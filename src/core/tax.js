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

/**
 * Stima teorica su un compenso: reddito = compenso × coefficiente; INPS = reddito × aliquota;
 * imposta = (reddito − INPS) × aliquota sostitutiva (metodo "maturati", predefinito) oppure reddito × aliquota
 * (metodo "versati": nessuna deduzione finché non versi i contributi).
 */
export function estimateTaxes(netCents, profile) {
  const base = mulBp(netCents, profile.coefficientBp);   // reddito forfettario
  const inps = mulBp(base, profile.inpsBp);              // contributi Gestione Separata sul reddito
  const imposta = mulBp(profile.inpsDeduction === 'paid' ? base : Math.max(0, base - inps), profile.taxBp);
  const total = inps + imposta;
  return { base, inps, imposta, total, netAfter: netCents - total };
}

/**
 * Compenso lordo MINIMO necessario per ottenere almeno `netTargetCents` di netto dopo INPS e imposta.
 * Il netto cresce con il compenso, quindi basta una ricerca per bisezione (nessun calcolo in virgola mobile).
 */
export function grossForNet(netTargetCents, profile) {
  if (!Number.isInteger(netTargetCents) || netTargetCents <= 0) return 0;
  let lo = netTargetCents, hi = netTargetCents * 4 + 100;
  while (estimateTaxes(hi, profile).netAfter < netTargetCents) hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimateTaxes(mid, profile).netAfter >= netTargetCents) hi = mid; else lo = mid + 1;
  }
  return lo;
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
  const op = tp.opening && tp.opening.year === year ? tp.opening : null;
  const inYear = (d) => d.slice(0, 4) === String(year) && (!today || d <= today);
  // I dati inseriti a mano coprono dal 1° gennaio a `untilDate`: i movimenti dell'app fino a quella data NON si contano (niente doppioni).
  const counted = (d) => inYear(d) && (!op || d > op.untilDate);
  let ricavi = op?.ricaviCents ?? 0, inpsPaid = op?.inpsPaidCents ?? 0, impostaPaid = op?.impostaPaidCents ?? 0;
  const fromApp = { ricavi: 0 };
  // Incassi professionali registrati nell'app ma ESCLUSI perché cadono dentro il periodo coperto dai dati iniziali (trasparenza: mai in silenzio).
  const ignored = { count: 0, cents: 0, items: [] };
  for (const t of state.transactions) {
    if (op && t.status === 'posted' && inYear(t.date) && t.date <= op.untilDate && t.kind === 'income' && t.categoryId === 'cat_pro') { ignored.count++; ignored.cents += t.cents; ignored.items.push({ id: t.id, date: t.date, cents: t.cents }); }
    if (t.status !== 'posted' || !counted(t.date)) continue;
    if (t.kind === 'income' && t.categoryId === 'cat_pro') { ricavi += t.cents; fromApp.ricavi += t.cents; }
    if (t.kind === 'expense' && t.categoryId === 'cat_inps') inpsPaid += -t.cents;
    if (t.kind === 'expense' && t.categoryId === 'cat_tax') impostaPaid += -t.cents;
  }
  const calc = (rev, inpsDeducted) => {
    const base = mulBp(rev, tp.coefficientBp);
    const inps = mulBp(base, tp.inpsBp);
    return { base, inps, imposta: mulBp(Math.max(0, base - (inpsDeducted ?? inps)), tp.taxBp) };
  };
  const accrued = tp.inpsDeduction !== 'paid';
  const { base, inps: inpsDue, imposta: impostaDue } = calc(ricavi, accrued ? null : inpsPaid);
  const impostaNoDeduction = mulBp(base, tp.taxBp);
  const impostaIfAllInpsPaid = mulBp(Math.max(0, base - inpsDue), tp.taxBp);
  const totalDue = inpsDue + impostaDue;
  const paid = inpsPaid + impostaPaid;
  // Scenario INFORMATIVO (non garantito): aggiunge gli incassi ancora attesi entro il 31 dicembre. Quelli che arrivano a gennaio contano nell'anno dopo.
  let expectedRest = 0;
  for (const r of state.receivables) {
    if ((r.status === 'expected' || r.status === 'partial') && r.expectedDate <= `${year}-12-31`) expectedRest += r.expectedCents - (r.receivedCents ?? 0);
  }
  const sc = calc(ricavi + expectedRest, accrued ? null : inpsPaid);
  const scenarioTotalDue = sc.inps + sc.imposta;
  return { year, ricavi, ricaviFromApp: fromApp.ricavi, ignoredByOpening: ignored, opening: op, base, inpsDue, inpsPaid, impostaDue, impostaNoDeduction, impostaIfAllInpsPaid, impostaPaid, totalDue, paid, stillDue: Math.max(0, totalDue - paid), scenario: { expectedRest, ricavi: ricavi + expectedRest, totalDue: scenarioTotalDue, stillDue: Math.max(0, scenarioTotalDue - paid) } };
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
    estimate: { totalDue: estimate.totalDue, stillDue: estimate.stillDue, ricavi: estimate.ricavi, ricaviFromApp: estimate.ricaviFromApp, ignoredByOpening: estimate.ignoredByOpening, inpsDue: estimate.inpsDue, impostaDue: estimate.impostaDue, base: estimate.base, opening: estimate.opening, scenario: estimate.scenario },
    earmarked: { allocatedYear, reservedNow },
    transferred: { year: transferredYear },
    paid: { inps: estimate.inpsPaid, imposta: estimate.impostaPaid, total: estimate.paid },
    ratesVerified: tp.verifiedYear === year,
  };
}
