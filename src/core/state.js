export const SCHEMA_VERSION = 3;

export const DEFAULT_CATEGORIES = [
  // Spese di consumo
  { id: 'cat_food', name: 'Alimentari', kind: 'expense', inBudget: true, icon: '🛒', color: 'green', parentId: null },
  { id: 'cat_eat', name: 'Ristoranti e bar', kind: 'expense', inBudget: true, icon: '🍽️', color: 'orange', parentId: null },
  { id: 'cat_fun', name: 'Sport e tempo libero', kind: 'expense', inBudget: true, icon: '🎾', color: 'pink', parentId: null },
  { id: 'cat_fuel', name: 'Carburante', kind: 'expense', inBudget: true, icon: '⛽', color: 'amber', parentId: null },
  { id: 'cat_transport', name: 'Trasporti', kind: 'expense', inBudget: true, icon: '🚗', color: 'blue', parentId: null },
  { id: 'cat_shop', name: 'Abbigliamento', kind: 'expense', inBudget: true, icon: '👕', color: 'purple', parentId: null },
  { id: 'cat_gifts', name: 'Regali', kind: 'expense', inBudget: true, icon: '🎁', color: 'red', parentId: null },
  { id: 'cat_tech', name: 'Tecnologia', kind: 'expense', inBudget: true, icon: '💻', color: 'indigo', parentId: null },
  { id: 'cat_health', name: 'Salute', kind: 'expense', inBudget: true, icon: '🩺', color: 'red', parentId: null },
  { id: 'cat_travel', name: 'Viaggi', kind: 'expense', inBudget: false, icon: '✈️', color: 'teal', parentId: null },
  // Sottocategoria: l'abbigliamento comprato per il viaggio conta nel viaggio, non due volte
  { id: 'cat_travel_clothes', name: 'Viaggi · abbigliamento', kind: 'expense', inBudget: false, icon: '🧳', color: 'teal', parentId: 'cat_travel' },
  { id: 'cat_subs', name: 'Abbonamenti', kind: 'expense', inBudget: false, icon: '📺', color: 'indigo', parentId: null },
  { id: 'cat_phone', name: 'Telefonia', kind: 'expense', inBudget: false, icon: '📱', color: 'blue', parentId: null },
  { id: 'cat_insurance', name: 'Assicurazioni', kind: 'expense', inBudget: false, icon: '🛡️', color: 'navy', parentId: null },
  { id: 'cat_home', name: 'Casa e utenze', kind: 'expense', inBudget: false, icon: '🏠', color: 'teal', parentId: null },
  { id: 'cat_prof', name: 'Spese professionali', kind: 'expense', inBudget: false, icon: '💼', color: 'gray', parentId: null },
  { id: 'cat_other', name: 'Altro', kind: 'expense', inBudget: true, icon: '⭐', color: 'gray', parentId: null },
  // Imposte e previdenza: pagamenti effettivi (non sono spese di consumo né entrano nei grafici delle spese)
  { id: 'cat_inps', name: 'Previdenza · contributi INPS versati', kind: 'expense', inBudget: false, icon: '🏛️', color: 'amber', parentId: null },
  { id: 'cat_tax', name: 'Imposte · imposta sostitutiva versata', kind: 'expense', inBudget: false, icon: '🧾', color: 'amber', parentId: null },
  // Investimenti: classificazione separata dalle spese
  { id: 'cat_invest', name: 'Investimenti (PAC)', kind: 'investment', inBudget: false, icon: '📈', color: 'navy', parentId: null },
  // Entrate
  { id: 'cat_pro', name: 'Incassi professionali', kind: 'income', inBudget: false, icon: '💼', color: 'green', parentId: null },
  { id: 'cat_in_other', name: 'Altre entrate', kind: 'income', inBudget: false, icon: '💰', color: 'teal', parentId: null },
  { id: 'cat_adj', name: 'Rettifica di quadratura', kind: 'adjustment', inBudget: false, icon: '⚖️', color: 'gray', parentId: null },
];

/** Profilo fiscale: lavoratore autonomo in regime forfettario con Gestione Separata INPS. Tutti i valori sono modificabili. */
export function defaultTaxProfile() {
  return { enabled: false, coefficientBp: 7800, inpsBp: 2607, taxBp: 500, roundStepCents: 1000, fundId: null, verifiedYear: null, opening: null };
}

export function defaultSettings(today) {
  return {
    currency: 'EUR',
    weekStartsOn: 1,
    autoLockSec: 120,
    hiddenLockSec: 30,
    backupReminderDays: 14,
    forecastDays: 90,
    urgentDays: 30,
    budget: { weeklyCents: 0, startDate: today, carryOver: true, carryDeficit: true, accountId: null, fundId: null, lastFundedWeek: null },
    taxRules: [],
    taxProfile: defaultTaxProfile(),
  };
}

export function createEmptyState(ctx) {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { createdAt: ctx.nowIso, demo: false, lastBackupAt: null, lastBackupSeq: 0 },
    settings: defaultSettings(ctx.today),
    categories: structuredClone(DEFAULT_CATEGORIES),
    accounts: [],
    transactions: [],
    transfers: [],
    funds: [],
    allocations: [],
    receivables: [],
    invoiceTemplates: [],
    planned: [],
    reconciliations: [],
    audit: [],
  };
}

export function makeCtx(over = {}) {
  const now = over.now ?? new Date();
  return {
    nowIso: over.nowIso ?? now.toISOString(),
    today: over.today ?? localToday(now),
    newId: over.newId ?? (() => crypto.randomUUID()),
  };
}
function localToday(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Porta uno stato di versione precedente allo schema corrente (idempotente). */
export function migrateState(st) {
  if (!st || typeof st !== 'object') return st;
  if (st.schemaVersion === 1) st.schemaVersion = 2;
  if (st.schemaVersion === 2) st.schemaVersion = 3;
  if (st.schemaVersion !== SCHEMA_VERSION) return st;
  const catDefaults = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.id, c]));
  st.invoiceTemplates ??= [];
  st.settings ??= {};
  st.settings.taxProfile ??= defaultTaxProfile();
  for (const c of st.categories ?? []) { c.icon ??= catDefaults[c.id]?.icon ?? '🏷️'; c.color ??= catDefaults[c.id]?.color ?? 'gray'; c.parentId ??= catDefaults[c.id]?.parentId ?? null; }
  for (const id of Object.keys(catDefaults)) if (!(st.categories ?? []).some((c) => c.id === id)) st.categories.push(structuredClone(catDefaults[id]));
  for (const a of st.accounts ?? []) { a.bank ??= null; a.color ??= null; a.emoji ??= null; a.logo ??= null; a.role ??= null; a.balanceUnknown ??= false; a.origin ??= null; }
  for (const f of st.funds ?? []) { f.color ??= { tax: 'amber', goal: 'indigo', planned: 'purple', reserve: 'gray' }[f.kind] ?? 'gray'; f.icon ??= { tax: '🧾', goal: '⭐', planned: '🛍️', reserve: '💰' }[f.kind] ?? '💰'; f.parentId ??= null; f.provisional ??= false; f.refillFundId ??= null; f.origin ??= null; if (f.goal) { f.goal.minCents ??= null; } }
  delete st.settings.taxProfile.deductInps; // la deduzione dei contributi si calcola sul dato annuale reale, non per singola fattura
  for (const t of st.transfers ?? []) { t.purpose ??= null; t.fundId ??= null; t.plannedId ??= null; }
  // Gli investimenti (PAC) non sono spese di consumo: cambiano tipo di movimento.
  const inv = (st.categories ?? []).find((c) => c.id === 'cat_invest'); if (inv) inv.kind = 'investment';
  for (const t of st.transactions ?? []) if (t.kind === 'expense' && t.categoryId === 'cat_invest' && !t.fundId) t.kind = 'investment';
  const fundHome = Object.fromEntries((st.funds ?? []).map((f) => [f.id, f.accountId]));
  for (const a of st.allocations ?? []) { a.accountId ??= fundHome[a.fundId] ?? null; a.receivableId ??= null; } // su quale conto "pesa" l'allocazione virtuale
  for (const r of st.receivables ?? []) { r.templateKey ??= null; r.invoiceDate ??= null; r.reserveCents ??= null; }
  for (const t of st.invoiceTemplates ?? []) { t.reserveCents ??= null; t.review ??= false; t.note ??= ''; t.origin ??= null; }
  st.settings.taxProfile.verifiedYear ??= null;
  st.settings.taxProfile.opening ??= null;
  if (st.settings.budget) { st.settings.budget.accountId ??= null; st.settings.budget.fundId ??= null; st.settings.budget.lastFundedWeek ??= null; }
  for (const p of st.planned ?? []) { p.categoryId ??= 'cat_other'; p.autoPay ??= false; p.remindDays ??= 2; p.confirm ??= null; p.origin ??= null; p.toAccountId ??= null; p.autoExecute ??= false; }
  return st;
}
