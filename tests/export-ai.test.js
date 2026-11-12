// Esportazione per analisi esterna: fedele, di sola lettura, senza ricalcoli né dati sensibili.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../src/core/commands.js';
import { snapshot, fundNeed } from '../src/core/derive.js';
import { forecast } from '../src/core/forecast.js';
import { buildAiExport, aiExportJson, AI_EXPORT_SCHEMA } from '../src/core/export-ai.js';
import { buildDemoState } from '../src/core/demo.js';
import { createEmptyState } from '../src/core/state.js';
import { ctx, TODAY } from './helpers.js';

const PROFILE = JSON.parse(readFileSync(new URL('./fixtures/profilo-esempio.json', import.meta.url), 'utf8'));
const OPTS = { today: TODAY, nowIso: '2026-06-15T10:00:00.000Z', appVersion: 'test' };

async function world() {
  let s = (await C.applyProfile(createEmptyState(ctx()), ctx(), PROFILE)).state;
  const ids = Object.fromEntries(s.accounts.map((a) => [a.name, a.id]));
  s = (await C.updateBalances(s, ctx(), [{ accountId: ids['Banca Accrediti'], balanceCents: 300000 }, { accountId: ids['Banca Spese'], balanceCents: 80000 }, { accountId: ids['Broker Tasse'], balanceCents: 120000 }, { accountId: ids['Broker PAC'], balanceCents: 50000 }])).state;
  s = (await C.addReceivable(s, ctx(), { client: 'Cliente Uno', description: 'Fattura giugno', expectedCents: 140000, expectedDate: '2026-06-27', accountId: ids['Banca Accrediti'], reserveCents: 35000 })).state;
  s = (await C.addReceivable(s, ctx(), { client: 'Cliente Uno', description: 'Fattura luglio', expectedCents: 140000, expectedDate: '2026-06-27', accountId: ids['Banca Accrediti'], reserveCents: 35000 })).state;   // stesso cliente, stessa data
  s = (await C.addReceivable(s, ctx(), { client: 'Ritardatario', expectedCents: 30000, expectedDate: '2026-06-01', accountId: ids['Banca Accrediti'] })).state;
  return { s, ids };
}
const walk = (o, f, path = '') => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, f, `${path}.${k}`), f(k, v, path); };

test('schema, data/ora, versione e struttura delle sezioni', async () => {
  const { s } = await world();
  const x = buildAiExport(s, OPTS);
  assert.deepEqual([x.schema.name, x.schema.version], [AI_EXPORT_SCHEMA.name, AI_EXPORT_SCHEMA.version]);
  assert.equal(x.export.exportedAt, OPTS.nowIso); assert.equal(x.export.asOfDate, TODAY);
  for (const k of x.schema.sections) assert.ok(k in x, `sezione ${k}`);
  assert.doesNotThrow(() => JSON.parse(aiExportJson(s, OPTS)));
});

test('nessun ricalcolo: totali, saldi e proiezioni coincidono ESATTAMENTE con le funzioni dell\'app', async () => {
  const { s } = await world();
  const x = buildAiExport(s, OPTS), sn = snapshot(s), fc = forecast(s, TODAY);
  assert.equal(x.currentSituation.totals.liquidCents, sn.liquid); assert.equal(x.currentSituation.totals.freeCents, sn.free);
  assert.equal(x.currentSituation.totals.reservedCents, sn.reserved); assert.equal(x.currentSituation.totals.investedCents, sn.invested);
  for (const a of x.currentSituation.accounts.filter((q) => q.balanceStatus !== 'unknown_to_be_updated')) { assert.equal(a.balanceCents, sn.balances[a.id]); if (a.countsAsLiquidity) assert.equal(a.freeCents, sn.freeByAccount[a.id]); }
  assert.equal(x.projections.dailyPoints.length, fc.points.length);
  fc.points.forEach((p, i) => { const q = x.projections.dailyPoints[i]; assert.deepEqual([q.date, q.liquidPrudentCents, q.freePrudentCents, q.liquidWithExpectedCents, q.freeWithExpectedCents], [p.date, p.total, p.free, p.totalWithExpected, p.freeWithExpected]); });
  assert.equal(x.projections.minimumFree.cents, fc.minFree); assert.equal(x.projections.events.length, fc.events.length);
});

test('di sola lettura: lo stato non cambia', async () => {
  const { s } = await world();
  const before = JSON.stringify(s);
  buildAiExport(s, OPTS); aiExportJson(s, OPTS);
  assert.equal(JSON.stringify(s), before);
});

test('importi in centesimi interi, date ISO, nessun dato sensibile, nessun logo', async () => {
  const { s } = await world();
  const x = buildAiExport(s, OPTS);
  walk(x, (k, v) => { if (/Cents$/.test(k) && v != null && typeof v === 'number') assert.ok(Number.isInteger(v), `${k} deve essere intero`); });
  walk(x, (k, v) => { if (/(Date|^date|^from$|^to$|^weekStart|^weekEnd)$/.test(k) && typeof v === 'string') assert.match(v, /^\d{4}-\d{2}-\d{2}$/, `${k}: ${v}`); });
  assert.match(x.export.exportedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  const json = aiExportJson(s, OPTS);
  assert.ok(!/password|iban|secret|privateKey|wrapped|"logo"|data:image/i.test(json.replace(/schema/g, '').replace(/IBAN, numeri di conto, password e chiavi di cifratura/g, '')), 'nessun dato sensibile');
  assert.ok(!('audit' in x));
});

test('identificativi unici e stabili: ogni movimento/trasferimento/allocazione compare una volta sola', async () => {
  const { s } = await world();
  const x = buildAiExport(s, OPTS), y = buildAiExport(s, OPTS);
  for (const k of ['transactions', 'transfers', 'allocations']) {
    const ids = x.movements[k].map((m) => m.id); assert.equal(new Set(ids).size, ids.length, k);
    assert.deepEqual(ids, state_ids(s, k)); assert.equal(ids.length, s[k].length);
  }
  assert.deepEqual(x, y);                                                           // deterministico
  assert.deepEqual(x.fundsAndGoals.funds.map((f) => f.id), s.funds.map((f) => f.id));
});
const state_ids = (s, k) => s[k].map((m) => m.id);

test('saldi sconosciuti: null (non 0), totali segnalati come parziali, elenco "da confermare"', async () => {
  const s = (await C.applyProfile(createEmptyState(ctx()), ctx(), PROFILE)).state;   // conti "Da aggiornare"
  const x = buildAiExport(s, OPTS);
  const unknown = x.currentSituation.accounts.filter((a) => a.balanceStatus === 'unknown_to_be_updated');
  assert.ok(unknown.length > 0); unknown.forEach((a) => { assert.equal(a.balanceCents, null); assert.equal(a.freeCents, null); });
  assert.equal(x.currentSituation.totals.partial, true);
  assert.ok(x.dataQuality.unconfirmedOrMissing.some((u) => u.type === 'account_balance_unknown'));
  assert.ok(x.dataQuality.unconfirmedOrMissing.some((u) => u.type === 'planned_item_to_confirm_as_active' || u.type === 'planned_item_date_to_confirm'));
  assert.ok(x.dataQuality.notAvailable.length >= 2);
});

test('incassi: più incassi dello stesso cliente restano distinti; lordo, riserva, netto da dati esistenti; riferimenti delle proiezioni', async () => {
  const { s } = await world();
  const x = buildAiExport(s, OPTS);
  const uno = x.receivables.items.filter((r) => r.client === 'Cliente Uno');
  assert.equal(uno.length, 2); assert.notEqual(uno[0].id, uno[1].id); assert.deepEqual(uno.map((r) => r.description).sort(), ['Fattura giugno', 'Fattura luglio']);
  const r = uno[0];
  assert.equal(r.grossExpectedCents, 140000); assert.equal(r.taxReserve.configuredCents, 35000); assert.equal(r.status, 'expected');
  assert.equal(r.projection.freeAfterReserveCents, 105000);                         // lo stesso valore che usa la previsione
  const late = x.receivables.items.find((q) => q.client === 'Ritardatario');
  assert.equal(late.overdue, true); assert.equal(late.projection.available, false);
  const evs = x.projections.events.filter((e) => e.kind === 'receivable' && !e.projectedFromRecurringInvoice);
  const amb = evs.filter((e) => e.label === 'Cliente Uno'); assert.equal(amb.length, 2);
  amb.forEach((e) => { assert.equal(e.reference.match, 'ambiguous'); assert.equal(e.reference.candidateIds.length, 2); });   // non si inventa: due candidati
  assert.ok(x.projections.events.filter((e) => e.kind === 'planned').every((e) => e.reference.plannedId));
});

test('spese e fondi: copertura delle voci programmate, reintegri, conti dove stanno le somme', async () => {
  let { s, ids } = await world();
  s = (await C.addPlanned(s, ctx(), { name: 'Abbonamento X', kind: 'subscription', cents: 2500, dueDate: '2026-06-20', accountId: ids['Banca Spese'], fundMode: 'new', recurrence: 'monthly' })).state;
  const p = s.planned.find((q) => q.name === 'Abbonamento X');
  s = (await C.assignToFund(s, ctx(), p.fundId, 2500, '', ids['Banca Spese'])).state;
  const x = buildAiExport(s, OPTS);
  const e = x.expenses.plannedItems.find((q) => q.id === p.id);
  assert.equal(e.isRecurring, true); assert.equal(e.coverage.state, 'covered_on_payment_account'); assert.equal(e.coverage.stillToFundCents, 0);
  const noFund = x.expenses.plannedItems.find((q) => q.coverage && q.coverage.state === 'no_fund');
  assert.ok(noFund, 'voci senza fondo segnalate'); assert.equal(noFund.coverage.stillToFundCents, noFund.amountCents);
  const f = x.fundsAndGoals.funds.find((q) => q.id === p.fundId);
  assert.equal(f.allocatedAvailableCents, 2500); assert.deepEqual(f.locations, [{ accountId: ids['Banca Spese'], cents: 2500, isReferenceAccount: true }]);
  const goal = x.fundsAndGoals.funds.find((q) => q.kind === 'goal' && q.goal.targetCents);
  assert.equal(goal.stillNeededCents, fundNeed(s, s.funds.find((q) => q.id === goal.id), snapshot(s)));   // lo stesso valore dell'app
});

test('con dati dimostrativi estesi: genera senza errori, registro unico e JSON valido', async () => {
  const s = await buildDemoState(ctx());
  const json = aiExportJson(s, OPTS);
  const x = JSON.parse(json);
  assert.equal(x.export.containsDemoData, true); assert.equal(x.movements.transactions.length, s.transactions.length);
  assert.ok(json.length > 1000);
});

test('modulo di sola lettura: non importa comandi, archiviazione né cifratura', () => {
  const src = readFileSync(new URL('../src/core/export-ai.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const i of imports) assert.ok(!/commands|storage|crypto|vault|backup/.test(i), `import non ammesso: ${i}`);
  assert.ok(!/\bfetch\(|localStorage|XMLHttpRequest/.test(src));
});
