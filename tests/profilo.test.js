// Profilo personale iniziale: configura senza inventare nulla. Fixture NEUTRA (dati inventati).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../src/core/commands.js';
import { snapshot, fundNeed, fundProgress, childFunds, pendingTransfers } from '../src/core/derive.js';
import { validateProfile } from '../src/core/profile.js';
import { validateState } from '../src/core/validate.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { proposeAllocation } from '../src/core/allocation.js';
import { forecast } from '../src/core/forecast.js';
import { buildIcs } from '../src/core/ics.js';
import { taxLedger } from '../src/core/tax.js';
import { monthlySeries, categoryBreakdown } from '../src/core/analytics.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, expectError, TODAY } from './helpers.js';

const PROFILE = JSON.parse(readFileSync(new URL('./fixtures/profilo-esempio.json', import.meta.url), 'utf8'));
const fresh = async () => (await C.applyProfile(createEmptyState(ctx()), ctx(), PROFILE)).state;
const byName = (arr, n) => arr.find((x) => (x.name ?? x.client) === n);

test('profilo: il file di esempio è valido; formato/versione/chiavi errate rifiutati', () => {
  assert.deepEqual(validateProfile(PROFILE), []);
  assert.ok(validateProfile({}).length); assert.ok(validateProfile({ format: 'FP-PROFILE', v: 9 }).length);
  const bad = structuredClone(PROFILE); bad.funds[0].accountKey = 'inesistente';
  assert.ok(validateProfile(bad).some((p) => /conto inesistente/.test(p)));
  const bad2 = structuredClone(PROFILE); bad2.invoiceTemplates[0].reserveCents = 999999999;
  assert.ok(validateProfile(bad2).some((p) => /riserva/.test(p)));
  const bad3 = structuredClone(PROFILE); bad3.accounts.push({ ...bad3.accounts[0] });
  assert.ok(validateProfile(bad3).some((p) => /duplicata/.test(p)));
});
test('profilo: crea conti con ruoli, SALDI "DA AGGIORNARE" (mai zero inventato), nessun movimento', async () => {
  const s = await fresh();
  assert.deepEqual(validateState(s), []);
  assert.equal(s.accounts.length, 5);
  const unknown = s.accounts.filter((a) => a.balanceUnknown).map((a) => a.name);
  assert.deepEqual(unknown.sort(), ['Banca Accrediti', 'Banca Risparmio', 'Banca Spese', 'Broker Tasse']);
  assert.equal(byName(s.accounts, 'Banca Extra').balanceUnknown, false);        // saldo fornito dal profilo
  assert.equal(byName(s.accounts, 'Banca Accrediti').role, 'Accredito dei compensi');
  assert.ok(s.accounts.every((a) => a.origin === 'profile'));
  assert.equal(s.transactions.length, 0); assert.equal(s.transfers.length, 0);  // nessun movimento spacciato per reale
  assert.equal(s.allocations.length, 0);                                         // NESSUN fondo finanziato
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
test('profilo: incassi professionali = configurazioni di pianificazione, previsti e non incassati', async () => {
  const s = await fresh();
  assert.equal(s.invoiceTemplates.length, 2);
  assert.equal(byName(s.invoiceTemplates, 'Cliente A').reserveCents, 30000);
  assert.equal(byName(s.invoiceTemplates, 'Cliente B').review, true);
  assert.ok(s.receivables.length >= 2 && s.receivables.every((r) => r.status === 'expected' && r.receivedCents == null)); // previsti
  assert.equal(snapshot(s).total, 5000);                                         // solo il saldo noto: i previsti non sono denaro
  const jun = s.receivables.find((r) => r.client === 'Cliente A' && r.invoiceDate === '2026-06-27');
  assert.equal(jun.expectedDate, '2026-07-09');                                  // fatturazione il 27, incasso dopo 12 giorni
});
test('profilo: fondi non finanziati, gerarchia padre/figlio, obiettivo "da definire", intervallo, provvisorio', async () => {
  const s = await fresh(); const sn = snapshot(s);
  assert.ok(s.funds.every((f) => sn.funds[f.id].available === 0));
  const trip = byName(s.funds, 'Viaggio'), clothes = byName(s.funds, 'Abbigliamento viaggio');
  assert.equal(clothes.parentId, trip.id); assert.deepEqual(childFunds(s, trip).map((f) => f.name), ['Abbigliamento viaggio']);
  assert.equal(byName(s.funds, 'Obiettivo A').goal.targetCents, null);
  assert.equal(fundNeed(s, byName(s.funds, 'Obiettivo A'), sn), 0);              // "da definire": nessun fabbisogno inventato
  assert.deepEqual([clothes.goal.minCents, clothes.goal.targetCents], [10000, 15000]);
  assert.equal(byName(s.funds, 'Reintegro riserva fiscale').provisional, true);
  assert.equal(s.settings.taxProfile.fundId, byName(s.funds, 'Riserva fiscale').id);
  assert.equal(s.settings.taxProfile.verifiedYear, null);                        // aliquote da verificare
});
test('sottocategoria/sotto-fondo: nessun doppio conteggio (padre 1.000 con figlio 150 → servono 1.000, non 1.150)', async () => {
  const s = await fresh(); const sn = snapshot(s);
  const trip = byName(s.funds, 'Viaggio'), kid = byName(s.funds, 'Abbigliamento viaggio');
  assert.equal(fundNeed(s, trip, sn), 100000 - 15000);                           // il figlio è incluso nel budget del padre
  assert.equal(fundNeed(s, kid, sn), 15000);
  assert.equal(fundNeed(s, trip, sn) + fundNeed(s, kid, sn), 100000);            // somma dei fabbisogni = budget complessivo
  // finanziando il figlio il padre non ne risente (resta il totale), e l'avanzamento aggrega
  let st = s;
  ({ state: st } = await C.addTransaction(st, ctx(), { accountId: byName(st.accounts, 'Banca Extra').id, cents: 60000, kind: 'income', categoryId: 'cat_in_other', date: TODAY }));
  ({ state: st } = await C.assignToFund(st, ctx(), kid.id, 15000, '', byName(st.accounts, 'Banca Extra').id));
  const sn2 = snapshot(st);
  assert.equal(fundNeed(st, trip, sn2) + fundNeed(st, kid, sn2), 85000 + 0);
  assert.deepEqual(fundProgress(st, trip, sn2), { have: 15000, target: 100000 });
});
test('sottocategoria spesa: "Viaggi · abbigliamento" rientra in Viaggi nel dettaglio, senza doppio conteggio con Abbigliamento', async () => {
  let s = await fresh();
  const acc = byName(s.accounts, 'Banca Extra').id;
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: acc, cents: -4000, kind: 'expense', categoryId: 'cat_travel_clothes', date: TODAY }));
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: acc, cents: -1000, kind: 'expense', categoryId: 'cat_shop', date: TODAY }));
  const m = monthlySeries(s, TODAY, 1)[0];
  assert.equal(m.expense, 5000);                                                 // ogni euro contato UNA volta
  const bd = categoryBreakdown(s, '2026-06');
  assert.equal(bd.find((c) => c.id === 'cat_travel').cents, 4000);               // il viaggio include la sottocategoria
  assert.deepEqual(bd.find((c) => c.id === 'cat_travel').children.map((c) => [c.id, c.cents]), [['cat_travel_clothes', 4000]]);
  assert.equal(bd.find((c) => c.id === 'cat_shop').cents, 1000);
  assert.equal(bd.reduce((t, c) => t + c.cents, 0), 5000);
});
test('profilo: scadenze ricorrenti NON pagate; PAC = investimento; data ignota → "da confermare"; assicurazione "da confermare come attiva"', async () => {
  const s = await fresh();
  assert.ok(s.planned.every((p) => p.status === 'planned') && s.transactions.length === 0);
  assert.equal(byName(s.planned, 'PAC').kind, 'investment'); assert.equal(byName(s.planned, 'PAC').categoryId, 'cat_invest');
  assert.equal(byName(s.planned, 'Corso').confirm, 'date'); assert.equal(byName(s.planned, 'Assicurazione').confirm, 'active');
  assert.ok(byName(s.planned, 'Corso').dueDate > TODAY);
  const f = forecast(s, TODAY, 90);
  const names = new Set(f.events.filter((e) => e.kind === 'planned').map((e) => e.label));
  assert.ok(names.has('Corso') && names.has('PAC') && !names.has('Assicurazione'));   // l'inattiva/da confermare non pesa
  assert.ok(!/Corso|PAC|Assicurazione/.test(buildIcs(s, { today: TODAY })));          // nessun promemoria finché non è confermata
});
test('conferma della voce "da confermare come attiva": attiva → entra in previsione; non attiva → annullata', async () => {
  let s = await fresh();
  const ins = byName(s.planned, 'Assicurazione');
  const yes = (await C.confirmPlanned(s, ctx(), ins.id, true)).state;
  assert.equal(byName(yes.planned, 'Assicurazione').confirm, null);
  assert.ok(forecast(yes, TODAY, 90).events.some((e) => e.label === 'Assicurazione'));
  const no = (await C.confirmPlanned(s, ctx(), ins.id, false)).state;
  assert.equal(byName(no.planned, 'Assicurazione').status, 'cancelled');
  await expectError(C.confirmPlanned(s, ctx(), byName(s.planned, 'PAC').id, true), 'nessuna_conferma');
});
test('impostare la data di una voce "data da confermare" la conferma', async () => {
  let s = await fresh();
  const p = byName(s.planned, 'Corso');
  ({ state: s } = await C.updatePlanned(s, ctx(), p.id, { dueDate: '2026-07-05' }));
  assert.equal(byName(s.planned, 'Corso').confirm, null);
  assert.match(buildIcs(s, { today: TODAY }), /Corso/);
});
test('saldo "da aggiornare": impostarlo calibra l\'apertura senza toccare i movimenti', async () => {
  let s = await fresh();
  const a = byName(s.accounts, 'Banca Spese');
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a.id, cents: -2500, kind: 'expense', categoryId: 'cat_food', date: TODAY })); // un movimento registrato prima di conoscere il saldo
  ({ state: s } = await C.setAccountBalance(s, ctx(), a.id, 30000));
  const acc = byName(s.accounts, 'Banca Spese');
  assert.equal(acc.balanceUnknown, false); assert.equal(snapshot(s).balances[a.id], 30000);   // il saldo di oggi è quello dichiarato
  assert.equal(s.transactions.length, 1); assert.equal(s.transactions[0].cents, -2500);       // movimento intatto
  await expectError(C.setAccountBalance(s, ctx(), a.id, 100), 'saldo_noto');
  assert.ok(s.audit.some((e) => e.action === 'set_balance'));
});
test('il profilo si applica una sola volta e solo a un archivio vuoto; la configurazione resta modificabile senza perdere lo storico', async () => {
  let s = await fresh();
  await expectError(C.applyProfile(s, ctx(), PROFILE), 'archivio_non_vuoto');
  const acc = byName(s.accounts, 'Banca Accrediti').id;
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: acc, cents: 50000, kind: 'income', categoryId: 'cat_in_other', date: TODAY }));
  const nAudit = s.audit.length;
  ({ state: s } = await C.updateAccount(s, ctx(), acc, { name: 'Nuovo nome', role: 'Altro ruolo' }));
  ({ state: s } = await C.updateFund(s, ctx(), byName(s.funds, 'Obiettivo A').id, { goal: { targetCents: 500000, priority: 2, deadline: null, minCents: null } }));
  ({ state: s } = await C.updateInvoiceTemplate(s, ctx(), byName(s.invoiceTemplates, 'Cliente B').id, { review: false }));
  assert.equal(s.transactions.length, 1); assert.ok(s.audit.length > nAudit);     // storico conservato e ampliato
  assert.equal(byName(s.funds, 'Obiettivo A').goal.targetCents, 500000);
  assert.deepEqual(validateState(s), []);
});
test('profilo: tutto è dentro UN\'operazione atomica: un profilo non valido non cambia nulla', async () => {
  const base = createEmptyState(ctx()); const j = JSON.stringify(base);
  const bad = structuredClone(PROFILE); bad.planned[0].categoryId = 'categoria_inesistente';
  await expectError(C.applyProfile(base, ctx(), bad));
  assert.equal(JSON.stringify(base), j);
});

// ── Imposte e previdenza: QUATTRO voci separate ──
test('fisco: stima, accantonamento, somme trasferite e debiti pagati restano quattro numeri distinti', async () => {
  let s = await fresh();
  const isy = byName(s.accounts, 'Banca Accrediti').id, tr = byName(s.accounts, 'Broker Tasse').id, taxFund = s.settings.taxProfile.fundId;
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: isy, cents: 120000, kind: 'income', categoryId: 'cat_pro', date: TODAY }));
  ({ state: s } = await C.assignToFund(s, ctx(), taxFund, 30000, '', isy));                       // accantonamento (virtuale)
  let L = taxLedger(s, 2026, TODAY);
  assert.equal(L.earmarked.allocatedYear, 30000); assert.equal(L.transferred.year, 0); assert.equal(L.paid.total, 0);   // nessun bonifico, nessun pagamento
  assert.ok(L.estimate.totalDue > 0);
  ({ state: s } = await C.confirmFundTransfer(s, ctx(), { fundId: taxFund, fromAccountId: isy, toAccountId: tr, cents: 20000, date: TODAY })); // bonifico reale confermato
  L = taxLedger(s, 2026, TODAY);
  assert.equal(L.transferred.year, 20000); assert.equal(L.earmarked.allocatedYear, 30000); assert.equal(L.earmarked.reservedNow, 30000);
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: tr, cents: -5000, kind: 'expense', categoryId: 'cat_inps', fundId: taxFund, date: TODAY })); // contributi versati
  L = taxLedger(s, 2026, TODAY);
  assert.equal(L.paid.inps, 5000); assert.equal(L.paid.total, 5000); assert.equal(L.earmarked.reservedNow, 25000);
  assert.equal(L.estimate.stillDue, L.estimate.totalDue - 5000);
  assert.equal(L.ratesVerified, false);
  ({ state: s } = await C.verifyTaxRates(s, ctx(), 2026));
  assert.equal(taxLedger(s, 2026, TODAY).ratesVerified, true);
});
test('categorie: risparmio, trasferimenti e investimenti separati dalle spese di consumo', async () => {
  const s = await fresh();
  const kinds = Object.fromEntries(s.categories.map((c) => [c.id, c.kind]));
  assert.equal(kinds.cat_invest, 'investment');
  for (const id of ['cat_food', 'cat_eat', 'cat_fun', 'cat_fuel', 'cat_transport', 'cat_travel', 'cat_shop', 'cat_gifts', 'cat_tech', 'cat_subs', 'cat_phone', 'cat_insurance', 'cat_prof', 'cat_tax', 'cat_inps']) assert.ok(id in kinds, id);
  assert.equal(s.categories.find((c) => c.id === 'cat_travel_clothes').parentId, 'cat_travel');
  // i trasferimenti (anche "risparmio") non sono mai spese né entrate
  let st = s; const a = byName(st.accounts, 'Banca Extra').id, b = byName(st.accounts, 'Banca Risparmio').id;
  ({ state: st } = await C.addTransfer(st, ctx(), { fromAccountId: a, toAccountId: b, cents: 1000, date: TODAY, purpose: 'saving' }));
  assert.equal(st.transfers[0].purpose, 'saving'); assert.equal(monthlySeries(st, TODAY, 1)[0].expense, 0);
});
test('previsioni con saldi "da aggiornare": nessun allarme di scoperto inventato, ma l\'avviso di previsione parziale', async () => {
  let s = await fresh();
  ({ state: s } = await C.addPlanned(s, ctx(), { name: 'Spesa grossa', cents: 900000, dueDate: '2026-06-25', accountId: byName(s.accounts, 'Banca Spese').id, fundMode: 'none' }));
  const f = forecast(s, TODAY, 60);
  assert.ok(f.issues.some((i) => i.kind === 'balances_unknown' && /Banca Spese/.test(i.message)));
  assert.ok(!f.issues.some((i) => /negative|overcommitted|goal_at_risk/.test(i.kind)));   // niente falsi allarmi su saldi sconosciuti
  for (const a of s.accounts.filter((x) => x.balanceUnknown)) ({ state: s } = await C.setAccountBalance(s, ctx(), a.id, 1000));
  assert.ok(forecast(s, TODAY, 60).issues.some((i) => i.kind === 'free_negative'));        // con saldi noti l'allarme torna
});
