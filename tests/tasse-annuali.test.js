// Tasse sull'INCASSATO dell'anno (cassa): dati iniziali inseriti a mano, niente doppioni, incassi di gennaio fuori, scenario non garantito.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { estimateAnnual, taxLedger } from '../src/core/tax.js';
import { validateState } from '../src/core/validate.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, expectError, TODAY } from './helpers.js';

async function setup() {
  let s = createEmptyState(ctx());
  let r = await C.addAccount(s, ctx(), { name: 'Isy', openingCents: 0, openingDate: '2026-01-01' }); s = r.state; const acc = r.result;
  r = await C.setupFreelanceProfile(s, ctx(), { taxAccountId: acc }); s = r.state;
  return { s, acc };
}
const inc = async (s, acc, cents, date) => (await C.addTransaction(s, ctx({ today: date > TODAY ? date : TODAY }), { accountId: acc, cents, kind: 'income', categoryId: 'cat_pro', date })).state;

test('senza dati iniziali conta solo ciò che è registrato', async () => {
  let { s, acc } = await setup();
  s = await inc(s, acc, 140000, '2026-06-10');
  const a = estimateAnnual(s, 2026);
  assert.equal(a.ricavi, 140000);
  assert.equal(a.base, 109200);          // 78%
  assert.equal(a.inpsDue, 28468);        // 26,07% di 1.092,00 = 284,68
});

test('dati iniziali a mano si sommano; i movimenti fino alla data non si contano due volte', async () => {
  let { s, acc } = await setup();
  s = await inc(s, acc, 50000, '2026-03-01');   // registrato nell'app ma già dentro i dati a mano
  s = (await C.setTaxOpening(s, ctx(), { year: 2026, untilDate: '2026-05-31', ricaviCents: 1000000, inpsPaidCents: 100000, impostaPaidCents: 20000 })).state;
  s = await inc(s, acc, 140000, '2026-06-10');
  const a = estimateAnnual(s, 2026);
  assert.equal(a.ricavi, 1140000);       // 10.000 a mano + 1.400 dopo il 31/5 (i 500 del 1/3 NON contano)
  assert.equal(a.ricaviFromApp, 140000);
  assert.equal(a.inpsPaid, 100000);
  assert.equal(a.paid, 120000);
  assert.deepEqual(validateState(s), []);
  assert.equal((await runIntegrityChecks(s)).ok, true);
});

test('incasso di gennaio dell\'anno dopo non entra nell\'anno corrente', async () => {
  let { s, acc } = await setup();
  s = await inc(s, acc, 140000, '2026-12-20');
  s = await inc(s, acc, 100000, '2027-01-12');
  assert.equal(estimateAnnual(s, 2026).ricavi, 140000);
  assert.equal(estimateAnnual(s, 2027).ricavi, 100000);
});

test('scenario: aggiunge gli incassi attesi entro il 31/12, separato dal dovuto reale', async () => {
  let { s, acc } = await setup();
  s = await inc(s, acc, 140000, '2026-06-10');
  s = (await C.addReceivable(s, ctx(), { client: 'X', expectedCents: 100000, expectedDate: '2026-12-15', accountId: acc })).state;
  s = (await C.addReceivable(s, ctx(), { client: 'Y', expectedCents: 70000, expectedDate: '2027-01-10', accountId: acc })).state;
  const a = estimateAnnual(s, 2026);
  assert.equal(a.ricavi, 140000);
  assert.equal(a.scenario.expectedRest, 100000);
  assert.ok(a.scenario.totalDue > a.totalDue);
  assert.equal(taxLedger(s, 2026, TODAY).estimate.scenario.expectedRest, 100000);
});

test('validazione dei dati iniziali e rimozione', async () => {
  const { s } = await setup();
  await expectError(C.setTaxOpening(s, ctx(), { year: 2026, untilDate: '2025-12-31', ricaviCents: 1 }), 'data_non_valida');
  await expectError(C.setTaxOpening(s, ctx(), { year: 2026, untilDate: '2026-12-31', ricaviCents: 1 }), 'data_futura');
  await expectError(C.setTaxOpening(s, ctx(), { year: 2026, untilDate: '2026-05-31', ricaviCents: -5 }), 'importo');
  let r = await C.setTaxOpening(s, ctx(), { year: 2026, untilDate: '2026-05-31', ricaviCents: 5000 });
  assert.ok(r.state.audit.at(-1).note.includes('iniziali'));
  r = await C.setTaxOpening(r.state, ctx(), null);
  assert.equal(r.state.settings.taxProfile.opening, null);
});

test('formula dell\'utente: 17.330 € incassati → imponibile 78%, INPS 26,07%, imposta 5% su (reddito − INPS), netto', async () => {
  let { s, acc } = await setup();
  s = await inc(s, acc, 1733000, '2026-06-10');
  const a = estimateAnnual(s, 2026);
  assert.equal(a.base, 1351740);                        // 13.517,40
  assert.equal(a.inpsDue, 352399);                      // 26,07% → 3.523,99
  assert.equal(a.impostaDue, 49967);                    // (13.517,40 − 3.523,95) × 5% = 499,67
  assert.equal(a.totalDue, 352399 + 49967);
  assert.equal(1733000 - a.totalDue, 1330634);          // netto
  s.settings.taxProfile.inpsDeduction = 'paid';
  assert.equal(estimateAnnual(s, 2026).impostaDue, 67587);   // senza versamenti nessuna deduzione
});

import { grossForNet, estimateTaxes } from '../src/core/tax.js';
test('calcolatrice: compenso → netto; "voglio il netto" → compenso minimo che lo garantisce', () => {
  const P = { coefficientBp: 7800, inpsBp: 2607, taxBp: 500, roundStepCents: 1000 };
  const t = estimateTaxes(20000, P);                       // 200 €
  assert.equal(t.base, 15600); assert.equal(t.inps, 4067);   // 156,00 · 40,67
  assert.equal(t.netAfter, 20000 - t.total);
  for (const net of [1, 50000, 107495, 1000000]) {
    const g = grossForNet(net, P);
    assert.ok(estimateTaxes(g, P).netAfter >= net, 'garantisce il netto');
    assert.ok(estimateTaxes(g - 1, P).netAfter < net, 'è il minimo');
  }
  assert.equal(grossForNet(0, P), 0);
});

test('incassi registrati dentro il periodo dei dati iniziali: esclusi dal calcolo ma SEGNALATI (mai in silenzio)', async () => {
  let { s, acc } = await setup();
  s = (await C.setTaxOpening(s, ctx(), { year: 2026, untilDate: '2026-06-15', ricaviCents: 1733000 })).state;
  s = await inc(s, acc, 140000, '2026-06-15');                    // stesso giorno del limite: ignorato
  let a = estimateAnnual(s, 2026);
  assert.equal(a.ricavi, 1733000); assert.equal(a.ricaviFromApp, 0);
  assert.deepEqual([a.ignoredByOpening.count, a.ignoredByOpening.cents], [1, 140000]);
  assert.equal(taxLedger(s, 2026, TODAY).estimate.ignoredByOpening.count, 1);
  // spostando il limite al giorno prima, l'incasso conta e la segnalazione sparisce
  s = (await C.setTaxOpening(s, ctx(), { year: 2026, untilDate: '2026-06-14', ricaviCents: 1733000 })).state;
  a = estimateAnnual(s, 2026);
  assert.equal(a.ricavi, 1873000); assert.equal(a.ricaviFromApp, 140000); assert.equal(a.ignoredByOpening.count, 0);
});
