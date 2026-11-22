// Budget settimanale FINANZIATO come un fondo: ogni settimana si riserva dal libero; le spese lo consumano;
// l'avanzo si riporta, lo sforo si sottrae dalla settimana dopo. Mai oltre il denaro libero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../src/core/commands.js';
import { snapshot } from '../src/core/derive.js';
import { budgetStatus } from '../src/core/budget.js';
import { forecast } from '../src/core/forecast.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { validateState } from '../src/core/validate.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, expectError, TODAY } from './helpers.js';

const W1 = TODAY;            // lunedì 15 giugno 2026
const W2 = '2026-06-22';     // lunedì successivo
const at = (d) => ctx({ today: d });

async function setup({ cash = 50000, weekly = 22000 } = {}) {
  let s = createEmptyState(ctx());
  let r = await C.addAccount(s, ctx(), { name: 'Revolut', openingCents: cash, openingDate: '2026-01-01' }); s = r.state; const rev = r.result;
  r = await C.addAccount(s, ctx(), { name: 'Isybank', openingCents: 100000, openingDate: '2026-01-01' }); s = r.state; const isy = r.result;
  ({ state: s } = await C.updateBudget(s, ctx(), { weeklyCents: weekly, startDate: W1 }));
  r = await C.setupBudgetFund(s, ctx(), { accountId: rev }); s = r.state;
  return { s, rev, isy, fund: r.result };
}
const fund = (s, f) => snapshot(s).funds[f].available;
const run = async (s, d, opts) => C.runBudgetFunding(s, at(d), opts);
const spend = async (s, acc, cents, d, cat = 'cat_food') => (await C.addTransaction(s, at(d), { accountId: acc, cents: -cents, kind: 'expense', categoryId: cat, date: d })).state;

test('il tuo esempio: 500 € in conto e budget da 220 € → 220 vengono riservati, restano liberi 280', async () => {
  let { s, rev, fund: f } = await setup();
  assert.equal(snapshot(s).freeByAccount[rev], 50000);                               // prima del finanziamento il libero è tutto
  const out = await run(s, W1); s = out.state;
  assert.deepEqual([out.result.level, out.result.funded, out.result.shortfall], [22000, 22000, 0]);
  assert.equal(fund(s, f), 22000);
  const sn = snapshot(s);
  assert.equal(sn.freeByAccount[rev], 28000); assert.equal(sn.balances[rev], 50000); // il denaro resta sul conto: è un vincolo virtuale
  assert.equal(s.settings.budget.lastFundedWeek, W1);
  assert.equal((await runIntegrityChecks(s)).ok, true); assert.deepEqual(validateState(s), []);
});
test('si finanzia UNA volta a settimana; "finanzia ora" non raddoppia', async () => {
  let { s, f = null, fund: bf } = await setup(); void f;
  s = (await run(s, W1)).state;
  const again = await run(s, W1); assert.equal(again.result.skipped, 'gia_fatto'); assert.equal(fund(again.state, bf), 22000);
  const forced = await run(s, W1, { force: true }); assert.equal(fund(forced.state, bf), 22000);   // già al livello: nessuna aggiunta
});
test('spendere dal budget scala il fondo e il saldo; il libero NON cambia', async () => {
  let { s, rev, fund: f } = await setup();
  s = (await run(s, W1)).state;
  const freeBefore = snapshot(s).freeByAccount[rev];
  s = await spend(s, rev, 6000, W1);
  const t = s.transactions.at(-1);
  assert.equal(t.fundId, f);                                                         // pagata dal fondo budget
  assert.equal(fund(s, f), 16000); assert.equal(snapshot(s).balances[rev], 44000);
  assert.equal(snapshot(s).freeByAccount[rev], freeBefore);
  assert.equal(budgetStatus(s, W1).remainingCents, 16000);                           // coerente con il residuo del budget
});
test('AVANZO: resta nel fondo e si riporta (livello = settimanale + avanzo)', async () => {
  let { s, rev, fund: f } = await setup();
  s = (await run(s, W1)).state; s = await spend(s, rev, 6000, W1);                   // avanzano 160
  const out = await run(s, W2); s = out.state;
  assert.equal(out.result.level, 22000 + 16000); assert.equal(out.result.funded, 22000);  // si aggiungono solo i 220 della nuova settimana
  assert.equal(fund(s, f), 38000);
});
test('AVANZO non riportato (impostazione): il fondo torna a 220 e l\'eccedenza torna libera', async () => {
  let { s, rev, fund: f } = await setup();
  ({ state: s } = await C.updateBudget(s, ctx(), { carryOver: false }));
  s = (await run(s, W1)).state; s = await spend(s, rev, 6000, W1);
  const free = snapshot(s).freeByAccount[rev];
  const out = await run(s, W2); s = out.state;
  // l'avanzo di 160 NON si somma: torna libero e la settimana nuova vale 220 in tutto (riservati di nuovo dal libero)
  assert.equal(out.result.level, 22000); assert.equal(out.result.released, 16000); assert.equal(out.result.funded, 22000); assert.equal(fund(s, f), 22000);
  assert.equal(snapshot(s).freeByAccount[rev], free - 6000);
});
test('SFORO: il fondo si esaurisce, il resto esce dal libero; la settimana dopo si finanzia meno', async () => {
  let { s, rev, fund: f } = await setup();
  s = (await run(s, W1)).state;                                                      // libero 280
  s = await spend(s, rev, 30000, W1);                                                // spendo 300 contro 220 di budget
  const t = s.transactions.at(-1);
  assert.equal(t.fundId, null); assert.equal(fund(s, f), 0);                         // fondo svuotato
  assert.equal(snapshot(s).freeByAccount[rev], 20000);                               // dal libero sono usciti solo gli 80 di sforo (280 − 80)
  assert.ok(s.audit.some((e) => /Sforo del budget/.test(e.note)));
  assert.equal(budgetStatus(s, W1).remainingCents, -8000);
  const out = await run(s, W2); s = out.state;
  assert.equal(out.result.level, 22000 - 8000);                                      // 220 − 80 di sforo = 140
  assert.equal(fund(s, f), 14000);
});
test('SFORO non riportato (impostazione): si ricomincia da 220', async () => {
  let { s, rev, fund: f } = await setup();
  ({ state: s } = await C.updateBudget(s, ctx(), { carryDeficit: false }));
  s = (await run(s, W1)).state; s = await spend(s, rev, 30000, W1);
  const out = await run(s, W2); s = out.state;
  // lo sforo non si recupera: il livello dovuto è 220, ma il denaro è REALE: dopo lo sforo il libero è 200, quindi si finanziano 200
  assert.equal(out.result.level, 22000); assert.equal(out.result.funded, 20000); assert.equal(out.result.shortfall, 2000);
  assert.equal(fund(s, f), 20000);
});
test('MAI oltre il libero: con 100 € liberi si finanzia 100 e si segnala quanto manca; col denaro arrivato si completa', async () => {
  let { s, rev, fund: f } = await setup({ cash: 10000 });
  const out = await run(s, W1); s = out.state;
  assert.equal(out.result.funded, 10000); assert.equal(out.result.shortfall, 12000);   // mancano 120
  assert.equal(fund(s, f), 10000); assert.equal(snapshot(s).freeByAccount[rev], 0);    // non si va sotto zero
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: rev, cents: 50000, kind: 'income', categoryId: 'cat_in_other', date: W1 }));
  const done = await run(s, W1, { force: true });
  assert.equal(done.result.funded, 12000); assert.equal(done.result.shortfall, 0); assert.equal(fund(done.state, f), 22000);
});
test('solo le spese giuste attingono al fondo: altro conto, categoria fuori budget, scadenza programmata, settimana passata', async () => {
  let { s, rev, isy, fund: f } = await setup();
  s = (await run(s, W1)).state;
  s = await spend(s, isy, 1000, W1);                                                 // altro conto
  s = await spend(s, rev, 1000, W1, 'cat_home');                                     // categoria "Casa e utenze": fuori budget
  s = (await C.addTransaction(s, ctx(), { accountId: rev, cents: -1000, kind: 'expense', categoryId: 'cat_fun', date: W1, plannedId: null })).state;
  assert.deepEqual(s.transactions.map((t) => t.fundId), [null, null, f]);            // solo l'ultima è nel budget
  // scadenza programmata (es. un corso): NON è budget settimanale
  let r = await C.addPlanned(s, ctx(), { name: 'Corso', kind: 'subscription', cents: 3000, dueDate: W1, accountId: rev, fundMode: 'none', recurrence: 'monthly', categoryId: 'cat_fun' }); s = r.state;
  ({ state: s } = await C.completePlanned(s, ctx(), { id: r.result }));
  assert.equal(s.transactions.at(-1).fundId, null);
  assert.equal(budgetStatus(s, W1).spentCents, 1000);                                // con il budget finanziato conta solo il conto spese (l'altro conto no, salvo flag esplicito); il corso (3000) NON pesa
  // spesa di una settimana passata registrata ora: non consuma il fondo di questa settimana
  s = await spend(s, rev, 1000, '2026-06-10');
  assert.equal(s.transactions.at(-1).fundId, null); assert.equal(fund(s, f), 22000 - 1000);
});
test('annullare o modificare una spesa del budget riallinea il fondo', async () => {
  let { s, rev, fund: f } = await setup();
  s = (await run(s, W1)).state; s = await spend(s, rev, 6000, W1);
  const id = s.transactions.at(-1).id;
  ({ state: s } = await C.updateTransaction(s, ctx(), id, { cents: -10000 }));
  assert.equal(fund(s, f), 12000); assert.equal(s.transactions.at(-1).fundId, f);
  ({ state: s } = await C.voidTransaction(s, ctx(), id, 'errore'));
  assert.equal(fund(s, f), 22000);
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('previsione: il budget già riservato non si sottrae due volte dal libero', async () => {
  let { s } = await setup();
  const before = forecast(s, W1, 30);
  s = (await run(s, W1)).state;
  const after = forecast(s, W1, 30);
  const cur = (f) => f.events.find((e) => e.label === 'Budget settimana (residuo)');
  assert.equal(cur(before).free, -22000); assert.equal(cur(after).free, 0); assert.equal(cur(after).total, -22000);   // riservato: non pesa di nuovo sul libero
  assert.equal(after.events.filter((e) => e.label === 'Budget settimanale').every((e) => e.free === -22000), true);   // le settimane future sì
  assert.equal(after.start.free, 28000 + 100000);                                        // libero totale: Revolut (500 − 220 riservati) + Isybank (1.000)
});
test('saldo "da aggiornare": non si finanzia nulla; ridurre il budget rilascia l\'eccedenza; disattivarlo libera tutto', async () => {
  let { s, rev, fund: f } = await setup();
  const unk = structuredClone(s); unk.accounts.find((a) => a.id === rev).balanceUnknown = true;
  assert.equal((await run(unk, W1)).result.skipped, 'saldo_da_aggiornare');
  s = (await run(s, W1)).state;
  ({ state: s } = await C.updateBudget(s, ctx(), { weeklyCents: 15000 }));
  const out = await run(s, W1, { force: true }); s = out.state;
  assert.equal(out.result.released, 7000); assert.equal(fund(s, f), 15000);
  await expectError(C.closeFund(s, ctx(), f), 'fondo_in_regola');                   // protetto: si disattiva dal budget
  ({ state: s } = await C.disableBudgetFund(s, ctx()));
  assert.equal(snapshot(s).freeByAccount[rev], 50000); assert.equal(s.settings.budget.fundId, null);
  assert.deepEqual(validateState(s), []);
});
test('non si attiva senza importo né su un conto di investimento; una sola volta', async () => {
  let { s, rev } = await setup();
  await expectError(C.setupBudgetFund(s, ctx(), { accountId: rev }), 'gia_attivo');
  let e = createEmptyState(ctx());
  const r = await C.addAccount(e, ctx(), { name: 'X', openingCents: 1000, openingDate: '2026-01-01' }); e = r.state;
  await expectError(C.setupBudgetFund(e, ctx(), { accountId: r.result }), 'budget_zero');
});
test('profilo: il fondo budget nasce NON finanziato e si finanzia da solo solo quando il saldo è noto', async () => {
  const P = JSON.parse(readFileSync(new URL('./fixtures/profilo-esempio.json', import.meta.url), 'utf8'));
  let s = (await C.applyProfile(createEmptyState(ctx()), ctx(), P)).state;
  const bf = s.funds.find((f) => f.kind === 'budget');
  assert.ok(bf); assert.equal(s.settings.budget.fundId, bf.id); assert.equal(s.allocations.length, 0);   // nessun fondo finanziato dal profilo
  assert.equal((await run(s, W1)).result.skipped, 'saldo_da_aggiornare');
  const daily = s.accounts.find((a) => a.name === 'Banca Spese').id;
  ({ state: s } = await C.updateBalances(s, ctx(), [{ accountId: daily, balanceCents: 50000 }]));
  const out = await run(s, W1); assert.equal(out.result.funded, 20000);
  assert.equal(snapshot(out.state).funds[bf.id].available, 20000);
});

// ───── Settimane in anticipo: azione ESPLICITA, mai automatica; mai prelievi da altri conti ─────
import { budgetWeeksCoverage } from '../src/core/budget.js';
const byAcc = (s, f, a) => snapshot(s).funds[f].byAccount[a] ?? 0;
const resv = byAcc;
import { pendingTransfers } from '../src/core/derive.js';
async function withBuddy(cash = 22000) {
  const x = await setup({ cash });
  const bb = await C.addAccount(x.s, ctx(), { name: 'Buddy', openingCents: 100000, openingDate: '2026-01-01' });
  return { ...x, f: x.fund, s: bb.state, buddy: bb.result };
}
test('anticipo: le settimane si riservano SOLO su richiesta, dal libero del conto scelto; il denaro resta dov\'è', async () => {
  let { s, rev, buddy, f } = await withBuddy();
  s = (await run(s, W1, { force: true })).state;                                   // 220 sul conto spese
  const r = await C.fundAdvanceWeeks(s, ctx(), { weeks: 3, accountId: buddy }); s = r.state;
  assert.deepEqual([r.result.reserved, r.result.shortfall], [66000, 0]);
  assert.equal(resv(s, f, buddy), 66000); assert.equal(snapshot(s).freeByAccount[buddy], 100000 - 66000);
  assert.equal(snapshot(s).balances[buddy], 100000);                               // nessun bonifico
  assert.equal(pendingTransfers(s, snapshot(s), W1).length, 0);                    // settimana corrente già coperta: le future restano ferme
  assert.deepEqual(budgetWeeksCoverage(s, W1, 5).map((w) => w.funded), [true, true, true, true, false]);   // corrente + 3 in anticipo
});
test('anticipo: se il libero non basta riserva ciò che c\'è e lo dichiara, mai in negativo', async () => {
  let { s, rev, buddy, f } = await withBuddy();
  s = (await C.updateBudget(s, ctx(), { weeklyCents: 40000 })).state;
  const r = await C.fundAdvanceWeeks(s, ctx(), { weeks: 4, accountId: buddy });    // 4 × 400 = 1.600, ne ha 1.000
  assert.deepEqual([r.result.reserved, r.result.shortfall], [100000, 60000]);
  assert.ok(snapshot(r.state).freeByAccount[buddy] >= 0);
});
test('NESSUN prelievo automatico da altri conti: "Finanzia ora" usa solo il libero del conto spese', async () => {
  let { s, rev, buddy, f } = await withBuddy(0);                                   // il conto spese non ha libero
  const before = snapshot(s).freeByAccount[buddy];
  const out = await run(s, W1, { force: true });
  assert.equal(out.result.funded, 0); assert.equal(out.result.shortfall, 22000);   // lo dichiara
  assert.equal(snapshot(out.state).freeByAccount[buddy], before);                  // Buddy non perde un centesimo
  assert.equal(out.state.allocations.length, 0);
});
test('il lunedì la settimana corrente si copre con quella già riservata altrove: compare il bonifico, e NON se ne pretende una nuova', async () => {
  let { s, rev, buddy, f } = await withBuddy(22000);
  s = (await run(s, W1, { force: true })).state;
  s = (await C.fundAdvanceWeeks(s, ctx(), { weeks: 3, accountId: buddy })).state;  // 220 su Revolut · 660 su Buddy
  s = await spend(s, rev, 20590, W1);                                              // restano 14,10
  // settimana nuova, con riporto spento: il budget è di nuovo 220 e i 14,10 d'avanzo tornano liberi
  s = (await C.updateBudget(s, ctx(), { carryOver: false })).state;
  const out = await run(s, W2); s = out.state;
  assert.equal(out.result.released, 1410); assert.equal(out.result.shortfall, 0); assert.equal(out.result.funded, 0);   // l'avanzo di 14,10 torna libero
  assert.equal(byAcc(s, f, rev), 0); assert.equal(byAcc(s, f, buddy), 66000);        // nessun nuovo prelievo: Buddy ha ancora 660
  assert.deepEqual(pendingTransfers(s, snapshot(s), W2).map((p) => [p.fromAccountId, p.cents]), [[buddy, 22000]]);   // il bonifico copre l'intera settimana (220)
  s = (await C.confirmFundTransfer(s, at(W2), { fundId: f, fromAccountId: buddy, toAccountId: rev, cents: 22000, date: W2 })).state;
  assert.equal(byAcc(s, f, rev), 22000); assert.equal(byAcc(s, f, buddy), 44000);   // restano 2 settimane in anticipo, senza obbligo di rifarne una
  assert.equal(pendingTransfers(s, snapshot(s), W2).length, 0);
  assert.deepEqual(budgetWeeksCoverage(s, W2, 4).map((w) => w.funded), [true, true, true, false]);   // calendario: corrente + 2
  const again = await run(s, W2, { force: true });
  assert.equal(again.result.funded, 0); assert.equal(again.result.shortfall, 0);   // nessun "buco" da riempire
  assert.deepEqual(validateState(again.state), []); assert.equal((await runIntegrityChecks(again.state)).ok, true);
});
test('con il riporto attivo il livello è 220 + avanzo; i 0,39 € non vengono più presi da nessun altro conto', async () => {
  let { s, rev, buddy, f } = await withBuddy(22000);
  s = (await run(s, W1, { force: true })).state;
  s = (await C.fundAdvanceWeeks(s, ctx(), { weeks: 3, accountId: buddy })).state;
  s = await spend(s, rev, 20590, W1);                                              // avanzo 14,10 (riporto attivo)
  const freeBuddy = snapshot(s).freeByAccount[buddy];
  const out = await run(s, W2, { force: true });
  assert.equal(out.result.level, 23410);                                           // 220 + 14,10
  assert.equal(snapshot(out.state).freeByAccount[buddy], freeBuddy);               // nessun prelievo da Buddy
});
test('anticipo: validazioni (conto diverso dal conto spese, settimane 1–12, budget finanziato)', async () => {
  const { s, rev, buddy } = await withBuddy();
  await expectError(C.fundAdvanceWeeks(s, ctx(), { weeks: 2, accountId: rev }), 'conto_non_valido');
  await expectError(C.fundAdvanceWeeks(s, ctx(), { weeks: 0, accountId: buddy }), 'settimane');
  await expectError(C.fundAdvanceWeeks(createEmptyState(ctx()), ctx(), { weeks: 1, accountId: buddy }), 'non_attivo');
});
test('anticipo: la previsione non conta due volte le settimane già riservate', async () => {
  let { s, buddy } = await withBuddy();
  const noAdv = forecast((await run(s, W1, { force: true })).state, W1, 40);
  s = (await run(s, W1, { force: true })).state;
  s = (await C.fundAdvanceWeeks(s, ctx(), { weeks: 2, accountId: buddy })).state;
  const adv = forecast(s, W1, 40);
  const fut = (x) => x.events.filter((e) => e.kind === 'budget' && e.date > W1);
  assert.equal(fut(adv).slice(0, 2).every((e) => e.free === 0), true);
  assert.ok(fut(noAdv).every((e) => e.free < 0));
  assert.equal(fut(adv)[0].total, -22000);
});

// ───── Spostare il fondo su un altro conto ─────
test('sposta il budget: un bonifico per ciascun conto (non uno da 880), solo le parti spuntate; il conto spese del budget segue il fondo', async () => {
  let { s, rev, isy, fund: f } = await setup({ cash: 10000 });
  const bud = await C.addAccount(s, ctx(), { name: 'Buddy', openingCents: 100000, openingDate: '2026-01-01' }); s = bud.state; const buddy = bud.result;
  s = (await run(s, W1, { force: true })).state;
  s = (await C.fundAdvanceWeeks(s, ctx(), { weeks: 3, accountId: buddy })).state;
  assert.equal(byAcc(s, f, rev), 10000); assert.equal(byAcc(s, f, buddy), 66000);
  // sposto verso Isybank SOLO la parte che sta su Buddy
  const out = await C.relocateFund(s, ctx(), f, isy, { onlyFrom: [buddy] }); s = out.state;
  assert.deepEqual(s.transfers.map((t) => [t.fromAccountId, t.toAccountId, t.cents]), [[buddy, isy, 66000]]);
  assert.equal(byAcc(s, f, isy), 66000); assert.equal(byAcc(s, f, rev), 10000);        // la parte su Revolut non è stata toccata
  assert.equal(s.settings.budget.accountId, isy);                                       // il conto spese del budget ha seguito il fondo
  assert.deepEqual(pendingTransfers(s, snapshot(s)).map((p) => [p.fromAccountId, p.cents]), [[rev, 10000]]);   // il resto resta "bonifico da fare"
  assert.deepEqual(validateState(s), []); assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('conto spese del budget: si cambia senza bonifici; "Finanzia" usa solo il libero del NUOVO conto spese e mai quello degli altri', async () => {
  let { s, rev, isy, fund: f } = await setup({ cash: 5000 });                 // conto spese = Revolut (50 €), Isybank 1.000 €
  const bb = await C.addAccount(s, ctx(), { name: 'BBVA', openingCents: 500000, openingDate: '2026-01-01' }); s = bb.state; const bbva = bb.result;
  s = (await C.setBudgetAccount(s, ctx(), { accountId: bbva })).state;       // per errore finisce su BBVA
  s = (await run(s, W1, { force: true })).state;
  assert.equal(byAcc(s, f, bbva), 22000);                                      // la settimana corrente la prende da BBVA
  s = (await C.releaseFromFund(s, ctx(), f, 22000, '', bbva)).state;
  s = (await C.setBudgetAccount(s, ctx(), { accountId: rev })).state;
  assert.equal(s.transfers.length, 0); assert.equal(s.settings.budget.accountId, rev);
  assert.equal(s.funds.find((x) => x.id === f).accountId, rev);
  const freeBefore = [snapshot(s).freeByAccount[bbva], snapshot(s).freeByAccount[isy]];
  const out = await run(s, W1, { force: true }); s = out.state;
  assert.equal(byAcc(s, f, rev), 5000); assert.equal(out.result.shortfall, 17000);   // tutto il libero di Revolut, il resto lo dichiara
  assert.deepEqual([snapshot(s).freeByAccount[bbva], snapshot(s).freeByAccount[isy]], freeBefore);   // BBVA e Isybank intatti
  assert.deepEqual(validateState(s), []);
});
// ───── "Finanzia ora" a metà settimana non rifinanzia ciò che è già stato speso ─────
test('a metà settimana "Finanzia ora" non riporta il fondo a 220: il livello è ciò che RESTA', async () => {
  let { s, rev, isy, fund: f } = await setup({ cash: 100000 });
  s = (await run(s, W1, { force: true })).state;                                        // lunedì: 220
  s = await spend(s, rev, 16590, W1);                                                    // spesi 165,90 → restano 54,10
  assert.equal(fund(s, f), 5410);
  const out = await run(s, W1, { force: true });
  assert.equal(out.result.funded, 0); assert.equal(out.result.shortfall, 0); assert.equal(out.result.level, 5410);
  assert.equal(fund(out.state, f), 5410);
  assert.equal(snapshot(out.state).freeByAccount[rev], snapshot(s).freeByAccount[rev]);   // nessun denaro libero toccato
});


// ───── Avanzo della settimana: rinunciarvi a mano, o farlo tornare libero al lunedì ─────
test('"Rilascia" a mano l\'avanzo sul conto spese = rinuncia: il residuo scende, nessun bonifico da fare, nessun riporto', async () => {
  let { s, rev, buddy, f } = await withBuddy(22000);
  s = (await run(s, W1, { force: true })).state;
  s = (await C.fundAdvanceWeeks(s, ctx(), { weeks: 1, accountId: buddy })).state;          // 1 settimana in anticipo (220 su Buddy)
  s = await spend(s, rev, 14909, W1);                                                       // spesi 149,09 → restano 70,91
  assert.equal(budgetStatus(s, W1).remainingCents, 7091);
  s = (await C.releaseFromFund(s, ctx(), f, 7091, '', rev)).state;                         // lo porto in liquidità
  const st = budgetStatus(s, W1);
  assert.equal(st.remainingCents, 0); assert.equal(st.givenUpCents, 7091);
  assert.equal(snapshot(s).freeByAccount[rev], 7091);                                       // ora è liquidità libera e spendibile
  assert.equal(pendingTransfers(s, snapshot(s), W1).length, 0);                             // niente "bonifico da confermare": la settimana non vuole più quel denaro
  const out = await run(s, W1, { force: true });
  assert.deepEqual([out.result.funded, out.result.shortfall], [0, 0]); assert.equal(snapshot(out.state).freeByAccount[buddy], snapshot(s).freeByAccount[buddy]);
  // la settimana dopo l'avanzo rinunciato NON si riporta (anche con il riporto attivo)
  assert.equal(budgetStatus(out.state, W2).carryCents, 0);
});
test('gli sblocchi automatici non sono rinunce: solo il "Rilascia" dell\'utente conta', async () => {
  let { s, rev, f } = await setup({ cash: 100000 });
  s = (await run(s, W1, { force: true })).state;
  s = (await C.updateBudget(s, ctx(), { weeklyCents: 20000 })).state;                       // budget ridotto: l'eccedenza torna libera da sola
  const out = await run(s, W1, { force: true });
  assert.equal(out.result.released, 2000); assert.equal(budgetStatus(out.state, W1).givenUpCents, 0);
});
test('lunedì con riporto spento: l\'avanzo della settimana scorsa torna libero e il bonifico copre tutta la settimana nuova (220)', async () => {
  let { s, rev, buddy, f } = await withBuddy(22000);
  s = (await run(s, W1, { force: true })).state;
  s = (await C.fundAdvanceWeeks(s, ctx(), { weeks: 2, accountId: buddy })).state;           // 440 su Buddy
  s = (await C.updateBudget(s, ctx(), { carryOver: false })).state;
  s = await spend(s, rev, 14909, W1);                                                       // restano 70,91 sul conto spese
  const freeBefore = snapshot(s).freeByAccount[rev];
  const out = await run(s, W2); s = out.state;
  assert.equal(out.result.released, 7091);                                                  // l'avanzo torna libero
  assert.equal(snapshot(s).freeByAccount[rev], freeBefore + 7091);
  assert.equal(byAcc(s, f, rev), 0);
  assert.deepEqual(pendingTransfers(s, snapshot(s), W2).map((p) => [p.fromAccountId, p.cents]), [[buddy, 22000]]);   // il bonifico copre l'intera settimana
  assert.equal(out.result.funded, 0);
  assert.deepEqual(validateState(s), []); assert.equal((await runIntegrityChecks(s)).ok, true);
});
