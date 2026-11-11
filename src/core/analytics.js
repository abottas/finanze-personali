// Guadagni vs costi: aggregazioni derivate dai movimenti (mai memorizzate).
//  • "Spese" = solo spese di consumo. Gli INVESTIMENTI (PAC) hanno un tipo a parte: riducono la liquidità
//    ma non sono una spesa, quindi non falsano i grafici delle spese.
//  • "Riserva fiscale" = quanto è stato EFFETTIVAMENTE accantonato (allocazioni nel fondo fiscale), non la stima teorica.
//  • Trasferimenti, pagamenti di imposte/contributi (già coperti dalla riserva) e rettifiche non sono spese.
import { addMonths } from './dates.js';
import { estimateTaxes } from './tax.js';

const monthOf = (d) => d.slice(0, 7);

export function monthlySeries(state, today, months = 6) {
  const first = monthOf(addMonths(today.slice(0, 7) + '-01', -(months - 1)));
  const out = [];
  for (let i = 0; i < months; i++) out.push({ month: monthOf(addMonths(first + '-01', i)), income: 0, proIncome: 0, expense: 0, invested: 0, tax: 0, taxEstimate: 0, net: 0 });
  const idx = Object.fromEntries(out.map((m, i) => [m.month, i]));
  for (const t of state.transactions) {
    if (t.status !== 'posted' || t.kind === 'adjustment') continue;
    const m = out[idx[monthOf(t.date)]];
    if (!m) continue;
    if (t.kind === 'income') { m.income += t.cents; if (t.categoryId === 'cat_pro') m.proIncome += t.cents; }
    else if (t.kind === 'investment') m.invested += -t.cents;
    else if (t.categoryId !== 'cat_tax' && t.categoryId !== 'cat_inps') m.expense += -t.cents;
  }
  // Versamenti verso conti di investimento (es. PAC dalla tasca Tasse alla tasca PAC): investimento, non spesa.
  const isInv = Object.fromEntries(state.accounts.map((a) => [a.id, a.type === 'investment']));
  for (const t of state.transfers) {
    if (t.status !== 'posted') continue;
    const m = out[idx[monthOf(t.date)]];
    if (!m) continue;
    if (isInv[t.toAccountId] && !isInv[t.fromAccountId]) m.invested += t.cents;
    else if (isInv[t.fromAccountId] && !isInv[t.toAccountId]) m.invested -= t.cents;
  }
  const tp = state.settings.taxProfile;
  if (tp.enabled && tp.fundId) {
    for (const al of state.allocations) {
      if (al.fundId !== tp.fundId || (al.kind !== 'assign' && al.kind !== 'release')) continue; // gli spostamenti tra conti non cambiano la riserva
      const m = out[idx[monthOf(al.date)]];
      if (m) m.tax += al.cents;
    }
  }
  for (const m of out) {
    m.taxEstimate = tp.enabled ? estimateTaxes(m.proIncome, tp).total : 0;
    m.net = m.income - m.tax - m.expense;
  }
  return out;
}

/** Totale versato in investimenti (versamenti cumulati, NON il valore di mercato). */
export function investedTotal(state) {
  const isInv = Object.fromEntries(state.accounts.map((a) => [a.id, a.type === 'investment']));
  let n = state.transactions.reduce((s, t) => (t.status === 'posted' && t.kind === 'investment' ? s - t.cents : s), 0);
  for (const t of state.transfers) {
    if (t.status !== 'posted') continue;
    if (isInv[t.toAccountId] && !isInv[t.fromAccountId]) n += t.cents;
    else if (isInv[t.fromAccountId] && !isInv[t.toAccountId]) n -= t.cents;
  }
  return n;
}

/**
 * Spese del mese per categoria. Una sottocategoria (es. "Viaggi · abbigliamento") è inclusa nel totale della madre e
 * mostrata come dettaglio: ogni movimento ha UNA sola categoria, quindi nessun euro è contato due volte.
 */
export function categoryBreakdown(state, month) {
  const cat = Object.fromEntries(state.categories.map((c) => [c.id, c]));
  const sums = {};
  for (const t of state.transactions) {
    if (t.status !== 'posted' || t.kind !== 'expense' || monthOf(t.date) !== month || t.categoryId === 'cat_tax' || t.categoryId === 'cat_inps') continue;
    sums[t.categoryId] = (sums[t.categoryId] ?? 0) - t.cents;
  }
  const row = (id, cents) => ({ id, cents, name: cat[id]?.name ?? 'Altro', icon: cat[id]?.icon ?? '🏷️', color: cat[id]?.color ?? 'gray' });
  const top = {};
  for (const [id, cents] of Object.entries(sums)) {
    const parent = cat[id]?.parentId && cat[cat[id].parentId] ? cat[id].parentId : id;
    const r = (top[parent] ??= { ...row(parent, 0), own: 0, children: [] });
    if (parent === id) r.own += cents; else r.children.push(row(id, cents));
    r.cents += cents;
  }
  return Object.values(top).sort((a, b) => b.cents - a.cents);
}
