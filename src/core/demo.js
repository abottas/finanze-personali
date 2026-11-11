// Dati DIMOSTRATIVI interamente fittizi (nessun dato reale), generati in modo deterministico
// rispetto alla data odierna. Costruiti rispettando le stesse regole dei comandi.
import { createEmptyState, migrateState } from './state.js';
import { addDays, weekStart } from './dates.js';
import { appendAudit } from './audit.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

export async function buildDemoState(ctx) {
  const st = createEmptyState(ctx);
  st.meta.demo = true;
  const r = rng(20240611);
  let n = 0;
  const id = (p) => `demo-${p}-${++n}`;
  const T = ctx.today;
  const open = addDays(T, -84);

  const main = { id: 'demo-acc-main', name: 'Conto principale (demo)', type: 'checking', openingCents: 320000, openingDate: open, archived: false, createdAt: ctx.nowIso };
  const sav = { id: 'demo-acc-sav', name: 'Conto risparmio (demo)', type: 'savings', openingCents: 1500000, openingDate: open, archived: false, createdAt: ctx.nowIso };
  const cash = { id: 'demo-acc-cash', name: 'Contanti (demo)', type: 'cash', openingCents: 15000, openingDate: open, archived: false, createdAt: ctx.nowIso };
  st.accounts.push(main, sav, cash);

  const tx = (accountId, date, cents, kind, categoryId, note, extra = {}) => st.transactions.push({
    id: id('tx'), accountId, date, cents, kind, categoryId, fundId: null, receivableId: null, plannedId: null, note,
    status: 'posted', voidReason: null, createdAt: ctx.nowIso, updatedAt: ctx.nowIso, ...extra,
  });

  // Spese quotidiane (importi plausibili, tutti in centesimi interi)
  const daily = [['cat_food', 'Supermercato', 1800, 7500], ['cat_eat', 'Pranzo fuori', 900, 2800], ['cat_transport', 'Carburante', 3000, 6000], ['cat_fun', 'Cinema / uscita', 1200, 4500], ['cat_health', 'Farmacia', 500, 3000]];
  for (let d = -83; d <= -1; d++) {
    const date = addDays(T, d);
    if (r() < 0.45) {
      const [cat, note, lo, hi] = daily[Math.floor(r() * daily.length)];
      tx(main.id, date, -(lo + Math.floor(r() * (hi - lo))), 'expense', cat, note);
    }
  }
  // Voci ricorrenti
  for (const m of [-2, -1, 0]) {
    const base = addDays(T, m * 30 - 10);
    if (base < addDays(T, 0) && base > open) {
      tx(main.id, base, -62000, 'expense', 'cat_home', 'Affitto');
      tx(main.id, addDays(base, 3), -4990, 'expense', 'cat_subs', 'Abbonamenti');
    }
  }
  // Incassi professionali già ricevuti
  const rec1 = { id: id('rcv'), client: 'Studio Alfa (demo)', description: 'Consulenza trimestrale', expectedCents: 280000, expectedDate: addDays(T, -50), accountId: main.id, status: 'received', receivedTxId: null, receivedCents: 280000, receivedDate: addDays(T, -48), cancelReason: null, createdAt: ctx.nowIso };
  const rec2 = { id: id('rcv'), client: 'Beta Srl (demo)', description: 'Progetto sito web', expectedCents: 150000, expectedDate: addDays(T, -20), accountId: main.id, status: 'received', receivedTxId: null, receivedCents: 142000, receivedDate: addDays(T, -17), cancelReason: null, createdAt: ctx.nowIso };
  for (const rc of [rec1, rec2]) {
    const t = id('tx');
    st.transactions.push({ id: t, accountId: rc.accountId, date: rc.receivedDate, cents: rc.receivedCents, kind: 'income', categoryId: 'cat_pro', fundId: null, receivableId: rc.id, plannedId: null, note: `${rc.client} — ${rc.description}`, status: 'posted', voidReason: null, createdAt: ctx.nowIso, updatedAt: ctx.nowIso });
    rc.receivedTxId = t;
  }
  // Incassi attesi (NON ancora disponibili) + uno in ritardo
  const exp1 = { id: id('rcv'), client: 'Gamma SpA (demo)', description: 'Consulenza mensile', expectedCents: 320000, expectedDate: addDays(T, 9), accountId: main.id, status: 'expected', receivedTxId: null, receivedCents: null, receivedDate: null, cancelReason: null, createdAt: ctx.nowIso };
  const exp2 = { id: id('rcv'), client: 'Delta Snc (demo)', description: 'Saldo fattura', expectedCents: 90000, expectedDate: addDays(T, 40), accountId: main.id, status: 'expected', receivedTxId: null, receivedCents: null, receivedDate: null, cancelReason: null, createdAt: ctx.nowIso };
  const exp3 = { id: id('rcv'), client: 'Epsilon (demo)', description: 'Acconto', expectedCents: 60000, expectedDate: addDays(T, -6), accountId: main.id, status: 'expected', receivedTxId: null, receivedCents: null, receivedDate: null, cancelReason: null, createdAt: ctx.nowIso };
  st.receivables.push(rec1, rec2, exp1, exp2, exp3);

  // Trasferimento (non è né entrata né uscita)
  st.transfers.push({ id: id('trf'), fromAccountId: main.id, toAccountId: sav.id, cents: 100000, date: addDays(T, -30), note: 'Risparmio mensile', status: 'posted', voidReason: null, createdAt: ctx.nowIso });
  st.transfers.push({ id: id('trf'), fromAccountId: main.id, toAccountId: cash.id, cents: 10000, date: addDays(T, -12), note: 'Prelievo', status: 'posted', voidReason: null, createdAt: ctx.nowIso });

  // Fondi virtuali (sul conto principale e risparmio)
  const fTax = { id: 'demo-fund-tax', name: 'Accantonamento imposte', kind: 'tax', accountId: main.id, goal: null, plannedId: null, archived: false, createdAt: ctx.nowIso };
  const fEmerg = { id: 'demo-fund-emerg', name: 'Fondo emergenza', kind: 'goal', accountId: sav.id, goal: { targetCents: 1000000, priority: 1, deadline: null }, plannedId: null, archived: false, createdAt: ctx.nowIso };
  const fTrip = { id: 'demo-fund-trip', name: 'Vacanza estate', kind: 'goal', accountId: main.id, goal: { targetCents: 180000, priority: 2, deadline: addDays(T, 120) }, plannedId: null, archived: false, createdAt: ctx.nowIso };
  const pLap = { id: 'demo-plan-laptop', name: 'Nuovo portatile', kind: 'purchase', cents: 140000, dueDate: addDays(T, 25), anchorDay: Number(addDays(T, 25).slice(8)), priority: 2, accountId: main.id, fundId: 'demo-fund-laptop', recurrence: 'none', status: 'planned', createdAt: ctx.nowIso };
  const fLap = { id: 'demo-fund-laptop', name: 'Per: Nuovo portatile', kind: 'planned', accountId: main.id, goal: null, plannedId: pLap.id, archived: false, createdAt: ctx.nowIso };
  const pIns = { id: 'demo-plan-ins', name: 'Assicurazione auto', kind: 'extraordinary', cents: 48000, dueDate: addDays(T, 55), anchorDay: Number(addDays(T, 55).slice(8)), priority: 1, accountId: main.id, fundId: null, recurrence: 'yearly', status: 'planned', createdAt: ctx.nowIso };
  st.funds.push(fTax, fEmerg, fTrip, fLap);
  st.planned.push(pLap, pIns);
  const al = (fundId, cents, daysAgo, note) => st.allocations.push({ id: id('al'), fundId, cents, date: addDays(T, -daysAgo), kind: cents > 0 ? 'assign' : 'release', moveId: null, note, createdAt: ctx.nowIso });
  al(fTax.id, 70000, 48, '25% incasso Studio Alfa');
  al(fTax.id, 35500, 17, '25% incasso Beta Srl');
  al(fEmerg.id, 700000, 30, 'Quota iniziale');
  al(fTrip.id, 45000, 20, 'Prima quota');
  al(fLap.id, 40000, 10, 'Prima quota');
  st.settings.taxRules = [{ id: 'demo-rule-tax', name: 'Accantonamento imposte', bp: 2500, fundId: fTax.id }];
  st.settings.budget = { weeklyCents: 18000, startDate: weekStart(addDays(T, -35), 1), carryOver: true, carryDeficit: true };

  migrateState(st);
  await appendAudit(st, { action: 'load_demo', entity: 'meta', entityId: 'meta', note: 'Dati dimostrativi caricati (fittizi)' }, ctx);
  return st;
}
