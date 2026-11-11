// Regole sugli incassi: riserva fissa di default · parziale = proporzionale con tracciamento · importo definitivo
// diverso = segnalato e a scelta · le regole future non cambiano mai da sole · compensi straordinari = profilo fiscale.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot, reserveProgress } from '../src/core/derive.js';
import { proposeAllocation } from '../src/core/allocation.js';
import { forecast } from '../src/core/forecast.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { validateState } from '../src/core/validate.js';
import { suggestedSetAside } from '../src/core/tax.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, expectError, TODAY } from './helpers.js';

async function setup(reserve = 30000, expected = 120000) {
  let s = createEmptyState(ctx());
  let r = await C.addAccount(s, ctx(), { name: 'Accrediti', openingCents: 0, openingDate: '2026-01-01' }); s = r.state; const acc = r.result;
  r = await C.addAccount(s, ctx(), { name: 'Tasse', openingCents: 0, openingDate: '2026-01-01' }); s = r.state; const taxAcc = r.result;
  r = await C.setupFreelanceProfile(s, ctx(), { taxAccountId: taxAcc }); s = r.state;
  r = await C.addInvoiceTemplate(s, ctx(), { client: 'Cliente', cents: expected, invoiceDay: 10, collectDays: 5, accountId: acc, reserveCents: reserve }); s = r.state;
  const tpl = r.result;
  const rc = s.receivables.find((x) => x.templateKey?.startsWith(tpl + ':') && x.expectedDate >= '2026-06-01');
  return { s, acc, taxAcc, tpl, rc, fund: s.settings.taxProfile.fundId };
}
async function receive(s, id, cents, { close = false, date = TODAY } = {}) {
  ({ state: s } = await C.receiveReceivable(s, ctx(), { id, cents, date, close }));
  return s;
}
const plan = (s, acc, cents, id) => proposeAllocation(s, { accountId: acc, cents, today: TODAY, professional: true, receivable: s.receivables.find((x) => x.id === id) });
const apply = async (s, p) => (await C.applyAllocationPlan(s, ctx(), p.items)).state;

test('riserva FISSA di default: incasso completo come previsto → riserva piena, il resto è disponibile', async () => {
  let { s, acc, rc } = await setup();
  s = await receive(s, rc.id, 120000);
  const p = plan(s, acc, 120000, rc.id);
  assert.equal(p.taxInfo.mode, 'full'); assert.equal(p.items[0].cents, 30000); assert.equal(p.remainderCents, 90000);
  assert.equal(s.receivables.find((r) => r.id === rc.id).status, 'received');
});
test('incasso PARZIALE: riserva proporzionale a quanto ricevuto, con traccia di previsto / accantonato / residuo', async () => {
  let { s, acc, rc, fund } = await setup();
  s = await receive(s, rc.id, 60000);                                           // metà
  assert.equal(s.receivables.find((r) => r.id === rc.id).status, 'partial');
  let p = plan(s, acc, 60000, rc.id);
  assert.equal(p.taxInfo.mode, 'partial'); assert.equal(p.items[0].cents, 15000); // 300 × 600/1.200
  assert.equal(p.items[0].receivableId, rc.id);
  assert.equal(p.taxInfo.planned, 30000); assert.equal(p.taxInfo.remaining, 30000); assert.equal(p.taxInfo.remainingAfter, 15000);
  s = await apply(s, p);
  let prog = reserveProgress(s, s.receivables.find((r) => r.id === rc.id));
  assert.deepEqual(prog, { planned: 30000, done: 15000, remaining: 15000 });   // traccia complessiva
  // secondo incasso: completa la fattura → la riserva fissa si completa senza superare il totale previsto
  s = await receive(s, rc.id, 60000);
  assert.equal(s.receivables.find((r) => r.id === rc.id).status, 'received');
  p = plan(s, acc, 60000, rc.id);
  assert.equal(p.taxInfo.mode, 'full'); assert.equal(p.items[0].cents, 15000);
  s = await apply(s, p);
  prog = reserveProgress(s, s.receivables.find((r) => r.id === rc.id));
  assert.deepEqual(prog, { planned: 30000, done: 30000, remaining: 0 });
  assert.equal(snapshot(s).funds[fund].available, 30000);                       // = la riserva fissa, né più né meno
  assert.equal((await runIntegrityChecks(s)).ok, true); assert.deepEqual(validateState(s), []);
});
test('incasso parziale in rate disuguali: l\'ultima rata chiude esattamente la riserva prevista (nessun centesimo perso)', async () => {
  let { s, acc, rc } = await setup();
  for (const c of [33333, 41111]) { s = await receive(s, rc.id, c); s = await apply(s, plan(s, acc, c, rc.id)); }
  s = await receive(s, rc.id, 120000 - 33333 - 41111);
  const p = plan(s, acc, 120000 - 33333 - 41111, rc.id); s = await apply(s, p);
  assert.equal(reserveProgress(s, s.receivables.find((r) => r.id === rc.id)).done, 30000);
});
test('importo DEFINITIVO diverso (chiusura con meno): riserva fissa predefinita, alternative proporzionale e teorica a scelta', async () => {
  let { s, acc, rc } = await setup();
  s = await receive(s, rc.id, 80000, { close: true });                           // fattura chiusa a 800 € invece di 1.200
  const r = s.receivables.find((x) => x.id === rc.id);
  assert.equal(r.status, 'received');
  const p = plan(s, acc, 80000, rc.id);
  assert.equal(p.taxInfo.mode, 'definitive_diff'); assert.equal(p.taxInfo.differsFromExpected, true);
  assert.equal(p.items[0].cents, 30000);                                          // default: riserva fissa
  assert.equal(p.taxInfo.fixed, 30000);
  assert.equal(p.taxInfo.propFinal, 20000);                                       // 300 × 800/1.200
  assert.equal(p.taxInfo.theoFinal, suggestedSetAside(80000, s.settings.taxProfile).setAside);
});
test('importo definitivo MAGGIORE del previsto: segnalato, riserva fissa di default', async () => {
  let { s, acc, rc } = await setup();
  s = await receive(s, rc.id, 130000);
  const p = plan(s, acc, 130000, rc.id);
  assert.equal(p.taxInfo.mode, 'definitive_diff'); assert.equal(p.items[0].cents, 30000); assert.equal(p.taxInfo.propFinal, 32500);
});
test('chiudere una fattura parziale con quanto incassato la rende definitiva (senza nuovo incasso)', async () => {
  let { s, rc } = await setup();
  s = await receive(s, rc.id, 60000);
  ({ state: s } = await C.closeReceivable(s, ctx(), rc.id, 'il cliente ha ridotto la fattura'));
  assert.equal(s.receivables.find((r) => r.id === rc.id).status, 'received');
  await expectError(C.closeReceivable(s, ctx(), rc.id), 'non_parziale');
  await expectError(C.receiveReceivable(s, ctx(), { id: rc.id, cents: 1000 }), 'non_atteso');
});
test('modifica dell\'importo definitivo di UNA fattura: a scelta riserva fissa / proporzionale / teorica; la regola futura non cambia', async () => {
  const base = await setup();
  const tplBefore = JSON.stringify(base.s.invoiceTemplates);
  const apply1 = async (mode) => (await C.updateReceivable(base.s, ctx(), base.rc.id, { expectedCents: 130000, reserveMode: mode })).state;
  const keep = await apply1('keep'), prop = await apply1('proportional'), theo = await apply1('theoretical');
  const res = (st) => st.receivables.find((r) => r.id === base.rc.id);
  assert.equal(res(keep).reserveCents, 30000);
  assert.equal(res(prop).reserveCents, 32500);
  assert.equal(res(theo).reserveCents, suggestedSetAside(130000, base.s.settings.taxProfile).setAside);
  for (const st of [keep, prop, theo]) {
    assert.equal(res(st).expectedCents, 130000);
    assert.equal(JSON.stringify(st.invoiceTemplates), tplBefore);               // regola ricorrente INTATTA
    const other = st.receivables.filter((r) => r.templateKey && r.id !== base.rc.id && r.status === 'expected');
    assert.ok(other.every((r) => r.expectedCents === 120000 && r.reserveCents === 30000)); // gli altri mesi non cambiano
  }
  assert.ok(keep.audit.at(-1).note.includes('Importo definitivo cambiato'));      // tracciato
  await expectError(C.updateReceivable(base.s, ctx(), base.rc.id, { expectedCents: 130000, reserveMode: 'boh' }), 'modo');
});
test('default senza scelta = riserva fissa mantenuta', async () => {
  const { s, rc } = await setup();
  const out = (await C.updateReceivable(s, ctx(), rc.id, { expectedCents: 100000 })).state;
  assert.equal(out.receivables.find((r) => r.id === rc.id).reserveCents, 30000);
});
test('riserva fissa non può superare il nuovo importo; fattura parziale non si riduce sotto l\'incassato', async () => {
  let { s, rc } = await setup();
  const low = (await C.updateReceivable(s, ctx(), rc.id, { expectedCents: 20000 })).state;
  assert.equal(low.receivables.find((r) => r.id === rc.id).reserveCents, 20000);   // limitata al nuovo importo
  s = await receive(s, rc.id, 60000);
  await expectError(C.updateReceivable(s, ctx(), rc.id, { expectedCents: 60000 }), 'sotto_incassato');
});
test('modificare la fattura ricorrente aggiorna solo gli incassi ANCORA attesi, mai quelli già incassati', async () => {
  let { s, rc, tpl } = await setup();
  s = await receive(s, rc.id, 60000);                                              // parziale
  ({ state: s } = await C.updateInvoiceTemplate(s, ctx(), tpl, { cents: 150000, reserveCents: 37500 }));
  const r = s.receivables.find((x) => x.id === rc.id);
  assert.equal(r.expectedCents, 120000); assert.equal(r.reserveCents, 30000);       // già incassata in parte: non toccata
});
test('compenso STRAORDINARIO (senza regola): riserva suggerita dal profilo fiscale, modificabile', async () => {
  let { s, acc } = await setup();
  const r = await C.addReceivable(s, ctx(), { client: 'Una tantum', expectedCents: 80000, expectedDate: TODAY, accountId: acc }); s = r.state;
  s = await receive(s, r.result, 80000);
  const p = plan(s, acc, 80000, r.result);
  assert.equal(p.taxInfo.mode, 'theoretical');
  assert.equal(p.items[0].cents, suggestedSetAside(80000, s.settings.taxProfile).setAside);
  assert.equal(p.items.length, 1);
  s = await apply(s, { items: [{ ...p.items[0], cents: p.items[0].cents + 1000 }] });  // modificabile
  assert.equal(snapshot(s).funds[s.settings.taxProfile.fundId].available, p.items[0].cents + 1000);
});
test('previsione: di un incasso parziale conta solo il residuo, ed è comunque non disponibile', async () => {
  let { s, rc } = await setup();
  s = await receive(s, rc.id, 60000);
  const f = forecast(s, TODAY, 90);
  const ev = f.events.find((e) => e.kind === 'receivable' && e.label === 'Cliente' && e.total === 60000);
  assert.ok(ev && ev.prudent === false);
  assert.ok(!f.points.some((p, i) => i === 0 && p.total !== snapshot(s).total));
});
test('annullare un incasso parziale lo riporta correttamente (atteso / ancora parziale)', async () => {
  let { s, rc } = await setup();
  s = await receive(s, rc.id, 50000); const t1 = s.transactions.at(-1).id;
  s = await receive(s, rc.id, 30000); const t2 = s.transactions.at(-1).id;
  ({ state: s } = await C.voidTransaction(s, ctx(), t2, 'errore'));
  let r = s.receivables.find((x) => x.id === rc.id); assert.equal(r.status, 'partial'); assert.equal(r.receivedCents, 50000);
  ({ state: s } = await C.voidTransaction(s, ctx(), t1, 'errore'));
  r = s.receivables.find((x) => x.id === rc.id); assert.equal(r.status, 'expected'); assert.equal(r.receivedCents, null);
  assert.equal((await runIntegrityChecks(s)).ok, true);
});
