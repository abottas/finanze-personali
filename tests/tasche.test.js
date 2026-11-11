// Trade Republic in due tasche: "Tasse" (liquidità) e "PAC" (investito). Il bonifico del PAC arriva nella tasca Tasse e il
// giorno 2 viene spostato in automatico nella tasca PAC. Il PAC è un investimento: non è una spesa e non è liquidità.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot } from '../src/core/derive.js';
import { forecast } from '../src/core/forecast.js';
import { monthlySeries, investedTotal } from '../src/core/analytics.js';
import { budgetStatus } from '../src/core/budget.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { validateState } from '../src/core/validate.js';
import { createEmptyState } from '../src/core/state.js';
import { buildIcs } from '../src/core/ics.js';
import { ctx, expectError, TODAY } from './helpers.js';

// TODAY = 2026-06-15
async function setup({ taxCash = 50000, due = '2026-06-02', auto = true } = {}) {
  let s = createEmptyState(ctx());
  const mk = async (name, type, cents, extra = {}) => { const r = await C.addAccount(s, ctx(), { name, type, openingCents: cents, openingDate: '2026-01-01', bank: extra.bank ?? null }); s = r.state; return r.result; };
  const isy = await mk('Isybank', 'checking', 100000);
  const tasse = await mk('Trade Republic · Tasse', 'savings', taxCash, { bank: 'trade_republic' });
  const pac = await mk('Trade Republic · PAC', 'investment', 0, { bank: 'trade_republic' });
  const r = await C.setupFreelanceProfile(s, ctx(), { taxAccountId: tasse }); s = r.state;
  const p = await C.addPlanned(s, ctx(), { name: 'PAC', kind: 'investment', cents: 10000, dueDate: due, accountId: tasse, toAccountId: pac, fundMode: 'none', recurrence: 'monthly', categoryId: 'cat_invest', autoExecute: auto }); s = p.state;
  return { s, isy, tasse, pac, taxFund: r.result, plan: p.result };
}

test('il conto PAC è patrimonio ma NON liquidità: il libero da spendere non lo conta', async () => {
  let { s, tasse, pac } = await setup();
  ({ state: s } = await C.addTransfer(s, ctx(), { fromAccountId: tasse, toAccountId: pac, cents: 20000, date: TODAY, purpose: 'investment' }));
  const sn = snapshot(s);
  assert.equal(sn.invested, 20000); assert.equal(sn.total, 100000 + 50000);          // il patrimonio non cambia
  assert.equal(sn.liquid, 130000); assert.equal(sn.free, 130000);                     // la liquidità scende di 200 €
  assert.equal(sn.freeByAccount[pac], 0);
});
test('non si può riservare denaro (fondi) su un conto di investimento', async () => {
  let { s, taxFund, pac } = await setup();
  await expectError(C.assignToFund(s, ctx(), taxFund, 1000, '', pac), 'conto_investimento');
  const bad = structuredClone(s); bad.allocations.push({ id: 'x', fundId: taxFund, accountId: pac, cents: 100, date: TODAY, kind: 'assign', moveId: null, note: '', createdAt: s.meta.createdAt, receivableId: null });
  assert.ok(validateState(bad).some((p) => /investimento/.test(p)));
});
test('il bonifico del PAC arriva nella tasca Tasse (liquidità) e NON gonfia la riserva fiscale', async () => {
  let { s, isy, tasse, taxFund } = await setup();
  ({ state: s } = await C.assignToFund(s, ctx(), taxFund, 30000, '', tasse));            // riserva fiscale 300 € già nella tasca
  const reserveBefore = snapshot(s).funds[taxFund].available;
  ({ state: s } = await C.addTransfer(s, ctx(), { fromAccountId: isy, toAccountId: tasse, cents: 10000, date: TODAY })); // bonifico di 100 € per il PAC
  const sn = snapshot(s);
  assert.equal(sn.balances[tasse], 50000 + 10000);
  assert.equal(sn.funds[taxFund].available, reserveBefore);                               // la riserva fiscale non cambia
  assert.equal(sn.freeByAccount[tasse], 60000 - 30000);                                   // i 100 € sono "liberi" nella tasca, in attesa del giorno 2
});
test('il giorno 2: spostamento interno automatico Tasse → PAC (trasferimento, non spesa)', async () => {
  let { s, tasse, pac, plan } = await setup({ due: '2026-06-02' });
  const before = snapshot(s);
  const out = await C.runAutoPlanned(s, ctx()); s = out.state;
  assert.equal(out.result, 1);
  const t = s.transfers.at(-1);
  assert.deepEqual([t.fromAccountId, t.toAccountId, t.cents, t.purpose, t.plannedId, t.date], [tasse, pac, 10000, 'investment', plan, '2026-06-02']);
  assert.equal(s.transactions.filter((x) => x.kind !== 'adjustment').length, 0);          // non è una spesa
  const sn = snapshot(s);
  assert.equal(sn.total, before.total);                                                   // il patrimonio non cambia
  assert.equal(sn.balances[tasse], before.balances[tasse] - 10000); assert.equal(sn.balances[pac], 10000);
  assert.equal(sn.free, before.free - 10000);                                             // incide sulla liquidità
  assert.equal(sn.invested, 10000);
  assert.equal(s.planned.find((p) => p.id === plan).dueDate, '2026-07-02');               // prossima scadenza
  assert.ok(s.audit.some((e) => /automaticamente/.test(e.note)));                         // tracciato come automatico
  assert.equal((await runIntegrityChecks(s)).ok, true); assert.deepEqual(validateState(s), []);
});
test('il PAC non falsa i grafici delle spese né il budget: compare come "investito"', async () => {
  let { s } = await setup();
  ({ state: s } = await C.updateBudget(s, ctx(), { weeklyCents: 20000, startDate: '2026-06-01' }));
  ({ state: s } = (await C.runAutoPlanned(s, ctx())));
  const m = monthlySeries(s, TODAY, 1)[0];
  assert.equal(m.expense, 0); assert.equal(m.invested, 10000); assert.equal(investedTotal(s), 10000);
  assert.equal(budgetStatus(s, TODAY).spentCents, 0);
});
test('recupera le scadenze saltate (non apri l\'app per mesi) con le date corrette', async () => {
  let { s, tasse, pac } = await setup({ taxCash: 90000, due: '2026-03-02' });          // 2/3, 2/4, 2/5, 2/6 passati
  const out = await C.runAutoPlanned(s, ctx()); s = out.state;
  assert.equal(out.result, 4);
  assert.deepEqual(s.transfers.map((t) => t.date), ['2026-03-02', '2026-04-02', '2026-05-02', '2026-06-02']);
  assert.equal(snapshot(s).balances[pac], 40000); assert.equal(snapshot(s).balances[tasse], 50000);
  assert.equal(s.planned.at(-1).dueDate, '2026-07-02');
});
test('non esegue se nella tasca di origine non c\'è denaro LIBERO sufficiente (resta da confermare a mano)', async () => {
  let { s, taxFund, tasse } = await setup({ taxCash: 50000 });
  ({ state: s } = await C.assignToFund(s, ctx(), taxFund, 45000, '', tasse));            // solo 50 € liberi: non bastano per 100
  const out = await C.runAutoPlanned(s, ctx());
  assert.equal(out.result, 0); assert.equal(out.state.transfers.length, 0);
  assert.equal(out.state.planned.at(-1).dueDate, '2026-06-02');                           // la scadenza resta ferma
});
test('la riserva fiscale non viene mai consumata dal PAC automatico', async () => {
  let { s, taxFund, tasse } = await setup({ taxCash: 50000 });
  ({ state: s } = await C.assignToFund(s, ctx(), taxFund, 50000, '', tasse));            // tutto il contante è riserva
  const out = await C.runAutoPlanned(s, ctx());
  assert.equal(out.result, 0); assert.equal(snapshot(out.state).funds[taxFund].available, 50000);
});
test('senza "esegui automaticamente" nulla parte da solo; la conferma manuale crea lo stesso trasferimento', async () => {
  let { s, plan, pac } = await setup({ auto: false });
  assert.equal((await C.runAutoPlanned(s, ctx())).result, 0);
  ({ state: s } = await C.completePlanned(s, ctx(), { id: plan, date: '2026-06-02' }));
  assert.equal(s.transfers.length, 1); assert.equal(snapshot(s).balances[pac], 10000);
});
test('le voci "da confermare" non partono in automatico', async () => {
  let { s, plan } = await setup();
  s = structuredClone(s); s.planned.find((p) => p.id === plan).confirm = 'date';
  assert.equal((await C.runAutoPlanned(s, ctx())).result, 0);
});
test('previsione di liquidità: il versamento PAC riduce la liquidità; la tasca PAC non è liquidità disponibile', async () => {
  let { s } = await setup({ due: '2026-06-20' });
  const f = forecast(s, TODAY, 60);
  assert.equal(f.start.total, 150000);                                                    // PAC (0 €) non conta
  const ev = f.events.filter((e) => e.label === 'PAC');
  assert.ok(ev.length >= 2 && ev.every((e) => e.total === -10000 && e.free === -10000));
  assert.equal(f.points.at(-1).total, 150000 - 20000);
});
test('la destinazione deve essere un conto di investimento diverso dall\'origine', async () => {
  let { s, isy, tasse } = await setup();
  await expectError(C.addPlanned(s, ctx(), { name: 'X', kind: 'investment', cents: 100, dueDate: '2026-07-01', accountId: tasse, toAccountId: isy, fundMode: 'none' }), 'stato_non_valido');
  await expectError(C.addPlanned(s, ctx(), { name: 'Y', kind: 'investment', cents: 100, dueDate: '2026-07-01', accountId: tasse, toAccountId: tasse, fundMode: 'none' }), 'stato_non_valido');
});
test('annullare un versamento PAC lo toglie dai conti e dall\'"investito"', async () => {
  let { s, plan, pac } = await setup({ auto: false });
  const r = await C.completePlanned(s, ctx(), { id: plan, date: '2026-06-02' }); s = r.state;
  ({ state: s } = await C.voidTransfer(s, ctx(), r.result, 'versamento non avvenuto'));
  assert.equal(snapshot(s).balances[pac], 0); assert.equal(investedTotal(s), 0);
});
test('calendario: il PAC compare come promemoria con la sua scadenza', async () => {
  const { s } = await setup({ due: '2026-06-20' });
  assert.match(buildIcs(s, { today: TODAY }), /PAC/);
});
