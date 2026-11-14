// Esportazione della situazione per un'analisi esterna (es. ChatGPT): UN unico JSON, di SOLA LETTURA.
// Non ricalcola nulla e non tocca lo stato: riusa i risultati delle funzioni già presenti nell'app
// (snapshot, previsioni, budget, stima fiscale, situazione a una data) e i dati così come sono nel modello.
// Dove un'informazione non esiste nel modello, il campo è null oppure è elencato in `notAvailable`: non si inventa nulla.
// Esclusi per costruzione: password, chiavi di cifratura, IBAN (il modello non li contiene), loghi, registro modifiche.
import { snapshot, pendingTransfers, fundTarget, fundNeed, reserveProgress, childFunds } from './derive.js';
import { forecast } from './forecast.js';
import { countsInWeeklyBudget } from './budget.js';
import { budgetStatus } from './budget.js';
import { taxLedger } from './tax.js';
import { monthlySeries } from './analytics.js';
import { cashflowByMonth, situationAt } from './reports.js';
import { addDays } from './dates.js';

export const AI_EXPORT_SCHEMA = { name: 'finanze-personali/situazione-per-analisi', version: '1.0.0' };

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/**
 * @param {object} state  stato dell'app (non viene modificato)
 * @param {{today:string, nowIso:string, appVersion?:string}} opts
 */
export function buildAiExport(state, { today, nowIso, appVersion = null }) {
  const snap = snapshot(state);
  const pending = pendingTransfers(state, snap);
  const fundById = Object.fromEntries(state.funds.map((f) => [f.id, f]));
  const catById = Object.fromEntries(state.categories.map((c) => [c.id, c]));
  const unknownAccounts = state.accounts.filter((a) => a.balanceUnknown && !a.archived);
  const year = Number(today.slice(0, 4));

  // ───────── 1. Situazione attuale ─────────
  const lastAdjustment = {};
  for (const t of state.transactions) if (t.status === 'posted' && t.kind === 'adjustment' && (!lastAdjustment[t.accountId] || t.date > lastAdjustment[t.accountId])) lastAdjustment[t.accountId] = t.date;
  const lastRec = {};
  for (const r of state.reconciliations) if (!lastRec[r.accountId] || r.date > lastRec[r.accountId].date) lastRec[r.accountId] = r;

  const accounts = state.accounts.map((a) => {
    const unknown = !!a.balanceUnknown;
    const reservations = state.funds
      .map((f) => ({ fundId: f.id, fundName: f.name, fundKind: f.kind, cents: snap.funds[f.id].byAccount[a.id] ?? 0 }))
      .filter((r) => r.cents !== 0);
    const isInvestment = a.type === 'investment';
    return {
      id: a.id, name: a.name, bank: a.bank ?? null, type: a.type, role: a.role ?? null, archived: !!a.archived,
      countsAsLiquidity: !isInvestment,
      balanceCents: unknown ? null : snap.balances[a.id],
      balanceStatus: unknown ? 'unknown_to_be_updated' : 'derived_from_recorded_movements',
      openingBalanceCents: a.openingCents, openingDate: a.openingDate,
      lastBalanceAdjustmentDate: lastAdjustment[a.id] ?? null,
      lastBankReconciliation: lastRec[a.id] ? pick(lastRec[a.id], ['id', 'date', 'bankCents', 'resolvedTxId']) : null,
      reservedCents: isInvestment || unknown ? null : snap.reservedByAccount[a.id] ?? 0,
      freeCents: isInvestment || unknown ? null : snap.freeByAccount[a.id],
      reservations,
    };
  });
  const currentSituation = {
    accounts,
    totals: {
      liquidCents: snap.liquid, investedCents: snap.invested, totalWealthCents: snap.total, reservedCents: snap.reserved, freeCents: snap.free,
      reservedByFundKindCents: { ...snap.reservedByKind },
      partial: unknownAccounts.length > 0, accountsWithUnknownBalance: unknownAccounts.map((a) => a.id),
    },
    pendingBankTransfers: pending.map((p) => ({ fundId: p.fundId, fromAccountId: p.fromAccountId, toAccountId: p.toAccountId, cents: p.cents, meaning: 'riserva virtuale su un conto diverso da quello di riferimento del fondo: bonifico reale non ancora confermato' })),
    note: 'freeCents = saldo − somme riservate ai fondi (vincoli contabili virtuali, non movimenti bancari). I conti di investimento non sono liquidità.',
  };

  // ───────── 2. Incassi ─────────
  const fc = forecast(state, today);
  const evRec = fc.events.filter((e) => e.kind === 'receivable' && !e.projected);
  const receivables = state.receivables.map((r) => {
    const open = r.status === 'expected' || r.status === 'partial';
    const remaining = open ? r.expectedCents - (r.receivedCents ?? 0) : 0;
    const rp = reserveProgress(state, r);
    const ev = open ? evRec.filter((e) => e.label === r.client && e.date === r.expectedDate && e.total === remaining) : [];
    const m = ev.length >= 1 && ev.every((e) => e.free === ev[0].free) ? ev[0] : null;   // più incassi identici: stessa previsione per tutti; se i valori differissero non si indovina
    return {
      id: r.id, client: r.client, description: r.description || null, status: r.status, accountId: r.accountId,
      invoiceDate: r.invoiceDate ?? null, expectedDate: r.expectedDate, receivedDate: r.receivedDate ?? null,
      grossExpectedCents: r.expectedCents, grossReceivedCents: r.receivedCents ?? null, grossRemainingCents: open ? remaining : null,
      taxReserve: { configuredCents: rp.planned, allocatedCents: rp.done, remainingToAllocateCents: rp.remaining, configuredBy: rp.planned == null ? 'non impostata: vale la stima del profilo fiscale' : 'regola per questo incasso' },
      projection: open ? (m ? { date: m.date, grossCents: m.total, freeAfterReserveCents: m.free, impliedReserveCents: m.total - m.free, nature: 'estimated', counted: 'solo nello scenario "con incassi attesi"' } : { available: false, reason: r.expectedDate < today ? 'incasso scaduto: non entra nelle previsioni' : 'nessun evento di previsione corrispondente' }) : null,
      overdue: open && r.expectedDate < today, linkedTransactionId: r.receivedTxId ?? null, recurringTemplateKey: r.templateKey ?? null, cancelReason: r.cancelReason ?? null,
    };
  }).sort((a, b) => (a.expectedDate < b.expectedDate ? -1 : a.expectedDate > b.expectedDate ? 1 : a.id < b.id ? -1 : 1));
  const recurringInvoices = state.invoiceTemplates.map((t) => ({ id: t.id, client: t.client, grossCents: t.cents, invoiceDay: t.invoiceDay, collectDays: t.collectDays, accountId: t.accountId, taxReserveCents: t.reserveCents ?? null, active: t.active !== false, toReview: !!t.review, note: t.note || null }));

  // ───────── 3. Spese ─────────
  const planned = state.planned.map((p) => {
    const f = p.fundId ? fundById[p.fundId] : null;
    const avail = f ? snap.funds[f.id].available : 0;
    const atPay = f ? snap.funds[f.id].byAccount[p.accountId] ?? 0 : 0;
    const open = p.status === 'planned';
    const funded = Math.min(avail, p.cents);
    let state_ = 'no_fund';
    if (f) state_ = avail >= p.cents ? (atPay >= p.cents ? 'covered_on_payment_account' : 'reserved_bank_transfer_to_do') : avail > 0 ? 'partially_funded' : 'unfunded';
    return {
      id: p.id, name: p.name, kind: p.kind, status: p.status, isRecurring: p.recurrence !== 'none', recurrence: p.recurrence,
      amountCents: p.cents, nextDueDate: p.dueDate, anchorDay: p.anchorDay, leadDays: p.leadDays ?? 0, priority: p.priority,
      categoryId: p.categoryId ?? null, paymentAccountId: p.accountId, fundingAccountId: p.fundingAccountId ?? null, toInvestmentAccountId: p.toAccountId ?? null,
      autoDebit: !!p.autoPay, autoExecute: !!p.autoExecute, confirmationNeeded: p.confirm ?? null, origin: p.origin ?? null,
      coverage: open ? { fundId: f ? f.id : null, fundAvailableCents: f ? avail : null, reservedOnPaymentAccountCents: f ? atPay : null, fundedCents: f ? funded : 0, stillToFundCents: p.cents - (f ? funded : 0), state: state_ } : null,
    };
  }).sort((a, b) => (a.nextDueDate < b.nextDueDate ? -1 : a.nextDueDate > b.nextDueDate ? 1 : a.id < b.id ? -1 : 1));

  const bs = budgetStatus(state, today);
  const b = state.settings.budget;
  const budget = {
    weeklyCents: b.weeklyCents, startDate: b.startDate, carryOverSurplus: !!b.carryOver, carryOverDeficit: !!b.carryDeficit,
    fundedAsFund: !!b.fundId, fundId: b.fundId ?? null, spendingAccountId: b.accountId ?? null, advanceWeeks: b.advanceWeeks ?? 0, advanceSourceAccountId: b.sourceAccountId ?? null, lastFundedWeek: b.lastFundedWeek ?? null,
    fundReservedByAccount: b.fundId ? Object.entries(snap.funds[b.fundId].byAccount).filter(([, c]) => c !== 0).map(([accountId, cents]) => ({ accountId, cents })) : [],
    currentWeek: { started: bs.started, weekStart: bs.weekStart, weekEnd: bs.weekEnd, baseCents: bs.baseCents, carryCents: bs.carryCents, spentCents: bs.spentCents, remainingCents: bs.remainingCents },
    weeks: bs.weeks.map((w) => ({ weekStart: w.weekStart, baseCents: w.base, carryCents: w.carry, spentCents: w.spent, remainingCents: w.remaining })),
  };
  const expenses = {
    incurredExpenses: 'Spese già sostenute: vedi movements.transactions con kind = "expense" (e "investment" per i versamenti), status = "posted". Una sola lista, nessuna copia qui.',
    plannedItems: planned, budget,
    plannedFunding: { ...state.settings.plannedFunding },
  };

  // ───────── 4. Fondi e obiettivi ─────────
  const funds = state.funds.map((f) => {
    const sf = snap.funds[f.id];
    const kids = childFunds(state, f).map((k) => k.id);
    return {
      id: f.id, name: f.name, kind: f.kind, archived: !!f.archived, provisional: !!f.provisional, referenceAccountId: f.accountId, parentFundId: f.parentId ?? null, childFundIds: kids,
      linkedPlannedId: f.plannedId ?? null, refillFundId: f.refillFundId ?? null,
      goal: f.goal ? { targetCents: f.goal.targetCents ?? null, minCents: f.goal.minCents ?? null, priority: f.goal.priority ?? null, deadline: f.goal.deadline ?? null } : null,
      targetCents: fundTarget(state, f), allocatedAvailableCents: sf.available, assignedTotalCents: sf.assigned, spentFromFundCents: sf.spent,
      stillNeededCents: fundNeed(state, f, snap),
      locations: Object.entries(sf.byAccount).filter(([, c]) => c !== 0).map(([accountId, cents]) => ({ accountId, cents, isReferenceAccount: accountId === f.accountId })),
      pendingBankTransferCents: pending.filter((p) => p.fundId === f.id).reduce((t, p) => t + p.cents, 0),
    };
  });
  const refills = state.funds.filter((f) => f.refillFundId && fundById[f.refillFundId]).map((f) => {
    const r = fundById[f.refillFundId];
    return { whenPayingFromFundId: f.id, increasesGoalOfFundId: r.id, refillTargetCents: fundTarget(state, r), refillAllocatedCents: snap.funds[r.id].available, refillStillNeededCents: fundNeed(state, r, snap) };
  });

  // ───────── Movimenti effettivi (registri, ciascuno una sola volta) ─────────
  const movements = {
    note: 'Registri effettivi: ogni movimento compare una sola volta. I trasferimenti non sono entrate né uscite; le allocazioni sono vincoli virtuali (non muovono denaro in banca).',
    transactions: state.transactions.map((t) => ({ id: t.id, date: t.date, accountId: t.accountId, kind: t.kind, amountCents: t.cents, categoryId: t.categoryId ?? null, categoryName: catById[t.categoryId]?.name ?? null, fundId: t.fundId ?? null, plannedId: t.plannedId ?? null, receivableId: t.receivableId ?? null, note: t.note || null, status: t.status, voidReason: t.voidReason ?? null, weeklyBudgetFlag: t.weeklyBudget ?? null, countsInWeeklyBudget: countsInWeeklyBudget(state, t), budgetReserveReleasedCents: t.budgetReleaseCents ?? null, refillFundId: t.refillFundId ?? null, refillCents: t.refillCents ?? null })),
    transfers: state.transfers.map((t) => ({ id: t.id, date: t.date, fromAccountId: t.fromAccountId, toAccountId: t.toAccountId, amountCents: t.cents, purpose: t.purpose ?? null, fundId: t.fundId ?? null, plannedId: t.plannedId ?? null, note: t.note || null, status: t.status, voidReason: t.voidReason ?? null })),
    allocations: state.allocations.map((a) => ({ id: a.id, date: a.date, fundId: a.fundId, accountId: a.accountId, amountCents: a.cents, kind: a.kind, moveId: a.moveId ?? null, receivableId: a.receivableId ?? null, note: a.note || null })),
    bankReconciliations: state.reconciliations.map((r) => pick(r, ['id', 'accountId', 'date', 'bankCents', 'resolvedTxId'])),
  };

  // ───────── Storico mensile e fisco (risultati già calcolati dall'app) ─────────
  const history = { monthly: monthlySeries(state, today, 12).map((m) => ({ month: m.month, incomeCents: m.income, professionalIncomeCents: m.proIncome, expenseCents: m.expense, taxReserveAllocatedCents: m.tax, investedCents: m.invested, theoreticalTaxEstimateCents: m.taxEstimate, netAfterExpensesAndReserveCents: m.net })), nature: 'derived_from_effective_movements' };
  const tp = state.settings.taxProfile;
  const tl = tp.enabled ? taxLedger(state, year, today) : null;
  const tax = {
    profile: { enabled: !!tp.enabled, coefficientBp: tp.coefficientBp, inpsBp: tp.inpsBp, taxBp: tp.taxBp, inpsDeduction: tp.inpsDeduction, taxFundId: tp.fundId ?? null, ratesVerifiedForYear: tp.verifiedYear ?? null, openingData: tp.opening ? { ...tp.opening } : null },
    year, ledger: tl ? { registeredIncomeIgnoredByOpeningDataCents: tl.estimate.ignoredByOpening?.cents ?? 0, registeredIncomeIgnoredByOpeningDataCount: tl.estimate.ignoredByOpening?.count ?? 0, estimateTotalDueCents: tl.estimate.totalDue, estimateStillDueCents: tl.estimate.stillDue, collectedRevenueCents: tl.estimate.ricavi, taxableBaseCents: tl.estimate.base, inpsDueCents: tl.estimate.inpsDue, substituteTaxDueCents: tl.estimate.impostaDue, scenarioWithExpectedReceipts: tl.estimate.scenario, earmarkedAllocatedThisYearCents: tl.earmarked.allocatedYear, earmarkedNowCents: tl.earmarked.reservedNow, transferredThisYearCents: tl.transferred.year, paidInpsCents: tl.paid.inps, paidSubstituteTaxCents: tl.paid.imposta } : null,
    nature: 'estimated', note: 'Stima per accantonare, non un calcolo fiscale ufficiale.',
  };

  // ───────── 5. Proiezioni già calcolate dall'app ─────────
  const openRec = receivables.filter((r) => r.grossRemainingCents != null);
  const tpl = state.invoiceTemplates.filter((t) => t.active !== false);
  const refOf = (e) => {
    if (e.kind === 'planned') { const p = state.planned.find((x) => x.id === e.plannedId); return { type: 'planned', plannedId: e.plannedId ?? null, fundId: p?.fundId ?? null, match: 'direct' }; }
    if (e.kind === 'budget') return { type: 'budget', fundId: b.fundId ?? null, match: 'direct' };
    if (e.projected) { const c = tpl.filter((t) => t.client === e.label && t.cents === e.total).map((t) => t.id); return { type: 'recurringInvoice', candidateIds: c, match: c.length === 1 ? 'exact' : c.length ? 'ambiguous' : 'none' }; }
    const c = openRec.filter((r) => r.client === e.label && r.expectedDate === e.date && r.grossRemainingCents === e.total).map((r) => r.id);
    return { type: 'receivable', candidateIds: c, match: c.length === 1 ? 'exact' : c.length ? 'ambiguous' : 'none' };
  };
  const horizonEnd = addDays(today, state.settings.forecastDays);
  const cf = cashflowByMonth(state, today, 6);
  const sit = situationAt(state, today, horizonEnd);
  const projections = {
    nature: 'projection', horizonDays: state.settings.forecastDays, from: today, to: horizonEnd,
    meaning: { prudent: 'solo il denaro già presente: nessun incasso non ricevuto', withExpected: 'include gli incassi attesi (non garantiti)', free: 'liquidità non vincolata ai fondi', total: 'liquidità totale (investimenti esclusi)' },
    start: { liquidCents: fc.start.total, freeCents: fc.start.free, reservedCents: fc.start.total - fc.start.free },
    minimumFree: { cents: fc.minFree, date: fc.minFreeDate },
    insufficientLiquidity: fc.issues.map((i) => ({ kind: i.kind, severity: i.severity, date: i.date, cents: i.cents ?? null, coveredByExpectedReceipts: i.coveredByExpected ?? null, message: i.message, refId: i.refId ?? null })),
    events: fc.events.map((e) => ({ date: e.date, kind: e.kind, label: e.label, amountCents: e.total, effectOnFreeCents: e.free, countedInPrudent: !!e.prudent, projectedFromRecurringInvoice: !!e.projected, coveredByFundCents: e.covered ?? null, reference: refOf(e) })),
    dailyPoints: fc.points.map((p) => ({ date: p.date, liquidPrudentCents: p.total, freePrudentCents: p.free, reservedPrudentCents: p.total - p.free, liquidWithExpectedCents: p.totalWithExpected, freeWithExpectedCents: p.freeWithExpected, reservedWithExpectedCents: p.totalWithExpected - p.freeWithExpected })),
    end: (() => { const l = fc.points.at(-1); return { date: l.date, liquidPrudentCents: l.total, freePrudentCents: l.free, liquidWithExpectedCents: l.totalWithExpected, freeWithExpectedCents: l.freeWithExpected }; })(),
    monthlyCashflow: cf.rows.map((r) => ({ month: r.month, expectedIncomeCents: r.inExpected, outBudgetCents: r.outBudget, outFixedCents: r.outFixed, outInvestmentCents: r.outInvest, outTotalCents: r.outTotal, netPrudentCents: r.netPrudent, netWithExpectedCents: r.netWithExpected, liquidPrudentEndCents: r.liquidPrudent, liquidWithExpectedEndCents: r.liquidWithExpected, freePrudentEndCents: r.freePrudent })),
    coverageOfExpenses: {
      verdict: sit.verdict, totals: sit.totals,
      months: sit.months.map((m) => ({ month: m.month, from: m.from, to: m.to, expectedIncomeCents: m.inExpected, expectedIncomeFreeAfterReserveCents: m.inFree, outTotalCents: m.outTotal, freeEndPrudentCents: m.freeEnd, freeEndWithExpectedCents: m.freeEndWithExpected })),
      lines: sit.lines.map((l) => ({ date: l.date, direction: l.dir, type: l.type, label: l.label, amountCents: l.total, effectOnFreeCents: l.free, status: l.status ?? null, freeAfterPrudentCents: l.freeAfter, freeAfterWithExpectedCents: l.freeAfterWithExpected })),
      overdueReceivablesNotCounted: sit.overdue.map((o) => ({ client: o.client, expectedDate: o.date, amountCents: o.cents })),
      statusLegend: { ok: 'coperta dal libero', con_incassi: 'coperta solo se arrivano gli incassi previsti', scoperta: 'non coperta' },
    },
  };

  // ───────── 6. Attendibilità ─────────
  const unconfirmed = [];
  for (const a of unknownAccounts) unconfirmed.push({ type: 'account_balance_unknown', accountId: a.id, detail: 'saldo non ancora inserito: i totali sono parziali' });
  for (const p of state.planned) if (p.status === 'planned' && p.confirm) unconfirmed.push({ type: p.confirm === 'active' ? 'planned_item_to_confirm_as_active' : 'planned_item_date_to_confirm', plannedId: p.id });
  for (const p of pending) unconfirmed.push({ type: 'bank_transfer_to_confirm', fundId: p.fundId, fromAccountId: p.fromAccountId, toAccountId: p.toAccountId, cents: p.cents });
  for (const f of state.funds) {
    if (f.archived) continue;
    if (f.provisional) unconfirmed.push({ type: 'fund_provisional', fundId: f.id });
    if (f.kind === 'goal' && f.goal && f.goal.targetCents == null) unconfirmed.push({ type: 'goal_target_to_define', fundId: f.id });
  }
  for (const t of state.invoiceTemplates) if (t.active !== false && t.review) unconfirmed.push({ type: 'recurring_invoice_to_review', templateId: t.id });
  for (const r of receivables) if (r.overdue) unconfirmed.push({ type: 'receivable_overdue_not_received', receivableId: r.id });
  if (tp.enabled && tp.verifiedYear !== year) unconfirmed.push({ type: 'tax_rates_not_verified_for_year', year });
  const allDates = Object.values(lastAdjustment).concat(Object.values(lastRec).map((r) => r.date));
  const dataQuality = {
    classification: {
      effective: ['currentSituation.accounts[].balanceCents (quando noto)', 'movements.transactions', 'movements.transfers (status posted)', 'receivables con status received/partial (parte ricevuta)'],
      virtualAccountingConstraints: ['movements.allocations', 'fundsAndGoals.*.locations', 'currentSituation.accounts[].reservations'],
      planned: ['expenses.plannedItems', 'receivables con status expected/partial (parte attesa)', 'recurringIncome.invoices'],
      projected: ['projections.*'],
      estimated: ['tax.*', 'receivables[].projection', 'receivables[].taxReserve quando non impostata', 'history.monthly[].theoreticalTaxEstimateCents'],
    },
    unconfirmedOrMissing: unconfirmed,
    balances: { computedAt: nowIso, method: 'saldo iniziale + movimenti registrati + trasferimenti', latestBalanceAdjustmentDate: allDates.length ? allDates.slice().sort().at(-1) : null, accountsWithUnknownBalance: unknownAccounts.map((a) => a.id) },
    notAvailable: [
      'data/ora di "ultimo aggiornamento" dedicata a ciascun saldo (il modello conserva solo data di apertura, rettifiche e quadrature)',
      'IBAN, numeri di conto, password e chiavi di cifratura (volutamente esclusi; l\'app non li conserva)',
      'estratti conto bancari importati (l\'app non li importa)',
    ],
  };

  return {
    schema: { ...AI_EXPORT_SCHEMA, purpose: 'Valutare la sostenibilità di spese aggiuntive a partire da uno stato fedele dell\'app, senza ricalcoli.', conventions: { amounts: 'interi in centesimi di euro (100 = 1,00 €); i campi *Cents', signs: 'movements.transactions.amountCents: entrate positive, uscite negative; trasferimenti e allocazioni positivi nella direzione indicata', dates: 'ISO 8601: giorni YYYY-MM-DD, istanti UTC', basisPointsFields: 'coefficientBp/inpsBp/taxBp: punti base (2607 = 26,07%)', nulls: 'null = informazione assente nel modello o non applicabile; mai un valore inventato' }, sections: ['currentSituation', 'receivables', 'recurringIncome', 'expenses', 'fundsAndGoals', 'movements', 'history', 'tax', 'projections', 'dataQuality', 'reference'] },
    export: { exportedAt: nowIso, asOfDate: today, appVersion, appStateSchemaVersion: state.schemaVersion, containsDemoData: !!state.meta.demo, currency: state.settings.currency },
    currentSituation,
    receivables: { items: receivables },
    recurringIncome: { invoices: recurringInvoices },
    expenses, fundsAndGoals: { funds, refills },
    movements, history, tax, projections, dataQuality,
    reference: {
      categories: state.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId ?? null, countsInWeeklyBudget: c.inBudget !== false })),
      settings: { weekStartsOn: state.settings.weekStartsOn, forecastDays: state.settings.forecastDays, urgentDays: state.settings.urgentDays, taxRules: state.settings.taxRules.map((r) => ({ id: r.id, name: r.name, bp: r.bp, fundId: r.fundId })) },
    },
  };
}

/** Serializzazione stabile e leggibile. */
export const aiExportJson = (state, opts) => JSON.stringify(buildAiExport(state, opts), null, 1);
