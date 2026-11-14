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
  // l'avanzo di 160 NON si aggiunge: la nuova settimana vale 220 in tutto → si aggiungono solo 60
  assert.equal(out.result.level, 22000); assert.equal(out.result.funded, 6000); assert.equal(fund(s, f), 22000);
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

// ───── Settimane finanziate in anticipo da un conto di appoggio ─────
import { pendingTransfers } from '../src/core/derive.js';
const byAcc = (s, f, a) => snapshot(s).funds[f].byAccount[a] ?? 0;

test('anticipo: settimana corrente sul conto spese, settimane future sul conto di appoggio; bonifico da confermare solo per la parte corrente', async () => {
  let { s, rev, isy, fund: f } = await setup({ cash: 10000 });     // Revolut 100 €, Isybank 1.000 €
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 3, sourceAccountId: isy })).state;
  const out = await run(s, W1, { force: true }); s = out.state;
  assert.equal(out.result.level, 22000 * 4);
  assert.equal(out.result.shortfall, 0);
  assert.equal(byAcc(s, f, rev), 10000);                           // tutto il libero di Revolut
  assert.equal(byAcc(s, f, isy), 88000 - 10000);                   // il resto (parte corrente 120 + 3 settimane) su Isybank
  assert.deepEqual(pendingTransfers(s, snapshot(s)).map((p) => [p.fromAccountId, p.cents]), [[isy, 12000]]);   // solo 120 € da spostare: le 3 settimane future restano ferme
  assert.equal(snapshot(s).freeByAccount[isy], 100000 - 78000);
  assert.deepEqual(validateState(s), []); assert.equal((await runIntegrityChecks(s)).ok, true);
});

test('anticipo: se il libero non basta lo dichiara (settimane coperte parzialmente) e non va in negativo', async () => {
  let { s, isy } = await setup({ cash: 0 });
  s = (await C.updateBudget(s, ctx(), { weeklyCents: 40000 })).state;      // 4 settimane = 1.600 €, su Isybank ce ne sono 1.000
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 3, sourceAccountId: isy })).state;
  const out = await run(s, W1, { force: true });
  assert.equal(out.result.funded, 100000);                         // solo ciò che c'è su Isybank
  assert.equal(out.result.shortfall, 60000);                       // e lo dichiara
  assert.ok(snapshot(out.state).freeByAccount[isy] >= 0);
});

test('anticipo: confermando il bonifico il denaro diventa spendibile sul conto spese; il lunedì dopo si ripristina il livello', async () => {
  let { s, rev, isy, fund: f } = await setup({ cash: 0 });
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 2, sourceAccountId: isy })).state;
  s = (await run(s, W1, { force: true })).state;                    // 3 settimane su Isybank: 660
  const pend = pendingTransfers(s, snapshot(s))[0]; assert.equal(pend.cents, 22000);
  s = (await C.confirmFundTransfer(s, ctx(), { fundId: f, fromAccountId: isy, toAccountId: rev, cents: 22000 })).state;
  assert.equal(byAcc(s, f, rev), 22000); assert.equal(byAcc(s, f, isy), 44000);
  assert.equal(pendingTransfers(s, snapshot(s)).length, 0);
  s = await spend(s, rev, 20000, '2026-06-17');                      // spendo 200
  const out = await run(s, W2); s = out.state;                       // lunedì dopo: livello = 220 + riporto 20 (+ 2 sett.)
  assert.equal(out.result.level, 24000 + 44000);
  assert.equal(byAcc(s, f, rev) + byAcc(s, f, isy), 68000);
  assert.equal(pendingTransfers(s, snapshot(s)).reduce((t, p) => t + p.cents, 0), 22000);   // un solo bonifico: una settimana
});

test('anticipo: ridurre le settimane rilascia prima il conto di appoggio; validazioni', async () => {
  let { s, rev, isy, fund: f } = await setup({ cash: 22000 });
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 2, sourceAccountId: isy })).state;
  s = (await run(s, W1, { force: true })).state;
  assert.equal(byAcc(s, f, isy), 44000);
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 0 })).state;
  const out = await run(s, W1, { force: true }); s = out.state;
  assert.equal(byAcc(s, f, isy), 0); assert.equal(byAcc(s, f, rev), 22000);
  await expectError(C.setBudgetAdvance(s, ctx(), { weeks: 2, sourceAccountId: rev }), 'conto_non_valido');
  await expectError(C.setBudgetAdvance(s, ctx(), { weeks: 9, sourceAccountId: isy }), 'settimane');
});

test('anticipo: la previsione non conta due volte le settimane già finanziate', async () => {
  let { s, isy } = await setup({ cash: 22000 });
  const noAdv = forecast(s, W1, 40);
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 2, sourceAccountId: isy })).state;
  s = (await run(s, W1, { force: true })).state;
  const adv = forecast(s, W1, 40);
  const fut = (f) => f.events.filter((e) => e.kind === 'budget' && e.date > W1);
  assert.equal(fut(adv).slice(0, 2).every((e) => e.free === 0), true);       // le prime due settimane future sono già riservate
  assert.ok(fut(noAdv).every((e) => e.free < 0));
  assert.equal(fut(adv)[0].total, -22000);                                   // ma il totale di cassa esce comunque
});

// ───── Spostare il fondo su un altro conto ─────
test('sposta il budget: un bonifico per ciascun conto (non uno da 880), solo le parti spuntate; il conto spese del budget segue il fondo', async () => {
  let { s, rev, isy, fund: f } = await setup({ cash: 10000 });
  const bud = await C.addAccount(s, ctx(), { name: 'Buddy', openingCents: 100000, openingDate: '2026-01-01' }); s = bud.state; const buddy = bud.result;
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 3, sourceAccountId: buddy })).state;
  s = (await run(s, W1, { force: true })).state;
  assert.equal(byAcc(s, f, rev), 10000); assert.equal(byAcc(s, f, buddy), 78000);
  // sposto verso Isybank SOLO la parte che sta su Buddy
  const out = await C.relocateFund(s, ctx(), f, isy, { onlyFrom: [buddy] }); s = out.state;
  assert.deepEqual(s.transfers.map((t) => [t.fromAccountId, t.toAccountId, t.cents]), [[buddy, isy, 78000]]);
  assert.equal(byAcc(s, f, isy), 78000); assert.equal(byAcc(s, f, rev), 10000);        // la parte su Revolut non è stata toccata
  assert.equal(s.settings.budget.accountId, isy);                                       // il conto spese del budget ha seguito il fondo
  assert.deepEqual(pendingTransfers(s, snapshot(s)).map((p) => [p.fromAccountId, p.cents]), [[rev, 10000]]);   // il resto resta "bonifico da fare"
  assert.deepEqual(validateState(s), []); assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('sposta il budget: se la destinazione è il conto di appoggio delle settimane in anticipo si rifiuta', async () => {
  let { s, isy, fund: f } = await setup({ cash: 10000 });
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 2, sourceAccountId: isy })).state;
  await expectError(C.relocateFund(s, ctx(), f, isy), 'conto_appoggio');
});

test('conto spese del budget: si cambia senza bonifici; "Finanzia" non prende più dal vecchio conto', async () => {
  let { s, rev, isy, fund: f } = await setup({ cash: 0 });                 // conto spese = Revolut (0 €), Isybank 1.000 €
  const bb = await C.addAccount(s, ctx(), { name: 'BBVA', openingCents: 500000, openingDate: '2026-01-01' }); s = bb.state; const bbva = bb.result;
  s = (await C.setBudgetAccount(s, ctx(), { accountId: bbva })).state;       // per errore finisce su BBVA
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 3, sourceAccountId: isy })).state;
  s = (await run(s, W1, { force: true })).state;
  assert.equal(byAcc(s, f, bbva), 22000);                                      // la settimana corrente la prende da BBVA
  s = (await C.releaseFromFund(s, ctx(), f, 22000, '', bbva)).state;
  s = (await C.setBudgetAccount(s, ctx(), { accountId: rev })).state;
  assert.equal(s.transfers.length, 0); assert.equal(s.settings.budget.accountId, rev);
  assert.equal(s.funds.find((x) => x.id === f).accountId, rev);
  const out = await run(s, W1, { force: true }); s = out.state;
  assert.equal(byAcc(s, f, bbva), 0);                                          // BBVA non viene più toccata
  assert.equal(byAcc(s, f, isy), 88000 - byAcc(s, f, rev));                    // tutto il resto da Isybank
  assert.deepEqual(validateState(s), []);
});
test('conto spese del budget: non può coincidere col conto delle settimane in anticipo', async () => {
  let { s, isy } = await setup({ cash: 10000 });
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 2, sourceAccountId: isy })).state;
  await expectError(C.setBudgetAccount(s, ctx(), { accountId: isy }), 'conto_appoggio');
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

test('con settimane in anticipo e spese già fatte: il totale riservato è già quello dovuto, nessun prelievo dal conto di appoggio', async () => {
  let { s, rev, isy, fund: f } = await setup({ cash: 100000 });
  const bb = await C.addAccount(s, ctx(), { name: 'BBVA', openingCents: 15039, openingDate: '2026-01-01' }); s = bb.state; const bbva = bb.result;
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 3, sourceAccountId: isy })).state;
  s = (await run(s, W1, { force: true })).state;                                         // 220 su Revolut + 660 su Isybank
  s = await spend(s, rev, 16590, W1);                                                    // restano 54,10 + 660
  s = (await C.setBudgetAdvance(s, ctx(), { weeks: 3, sourceAccountId: bbva })).state;   // cambio conto di appoggio
  const before = snapshot(s).freeByAccount[bbva];
  const out = await run(s, W1, { force: true });
  assert.equal(out.result.shortfall, 0);
  assert.equal(snapshot(out.state).freeByAccount[bbva], before);                         // BBVA non perde nemmeno un centesimo
  assert.equal(out.result.level, 5410 + 66000);
});
