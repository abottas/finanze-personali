import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { verifyAuditChain } from '../src/core/audit.js';
import { validateState } from '../src/core/validate.js';
import { buildDemoState } from '../src/core/demo.js';
import { snapshot } from '../src/core/derive.js';
import { forecast } from '../src/core/forecast.js';
import { base, ctx, TODAY } from './helpers.js';

async function withHistory() {
  let { s, a1, a2 } = await base();
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a1, cents: -500, kind: 'expense', categoryId: 'cat_food', date: '2026-06-01' }));
  ({ state: s } = await C.addTransfer(s, ctx(), { fromAccountId: a1, toAccountId: a2, cents: 1000, date: '2026-06-02' }));
  return { s, a1, a2 };
}
test('catena di hash: stato integro verificato', async () => {
  const { s } = await withHistory();
  assert.deepEqual(await verifyAuditChain(s.audit), { ok: true, brokenAt: null });
});
test('catena di hash: modifica, rimozione e riordino di voci vengono rilevati', async () => {
  const { s } = await withHistory();
  const mutated = structuredClone(s.audit); mutated[2].after.cents = -1;
  assert.equal((await verifyAuditChain(mutated)).ok, false);
  const removed = structuredClone(s.audit); removed.splice(2, 1);
  assert.equal((await verifyAuditChain(removed)).ok, false);
  const swapped = structuredClone(s.audit); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.equal((await verifyAuditChain(swapped)).ok, false);
});
test('controlli di quadratura: stato sano → ok', async () => {
  const { s } = await withHistory();
  const r = await runIntegrityChecks(s);
  assert.equal(r.ok, true, JSON.stringify(r.items.filter((i) => i.severity !== 'ok')));
});
test('controlli di quadratura: rilevano corruzioni iniettate', async () => {
  const { s, a1 } = await withHistory();
  const corrupt = (fn) => { const c = structuredClone(s); fn(c); return runIntegrityChecks(c); };
  assert.equal((await corrupt((c) => { c.transactions[0].cents = -5.5; })).ok, false); // float
  assert.equal((await corrupt((c) => { c.transactions[0].accountId = 'fantasma'; })).ok, false); // riferimento orfano
  assert.equal((await corrupt((c) => { c.transfers[0].toAccountId = c.transfers[0].fromAccountId; })).ok, false); // trasferimento su se stesso
  assert.equal((await corrupt((c) => { c.audit[1].note = 'manomesso'; })).ok, false); // storico alterato
  assert.equal((await corrupt((c) => { c.transactions.push({ ...c.transactions[0] }); })).ok, false); // id duplicato
  assert.equal((await corrupt((c) => { c.transfers[0].cents = -1000; })).ok, false);
  void a1;
});
test('sovra-vincolo (somme vincolate > saldo) è segnalato come avviso', async () => {
  let { s, a1 } = await base();
  let r = await C.addFund(s, ctx(), { name: 'F', kind: 'reserve', accountId: a1 }); s = r.state;
  ({ state: s } = await C.assignToFund(s, ctx(), r.result, 100000));
  ({ state: s } = await C.addTransaction(s, ctx(), { accountId: a1, cents: -30000, kind: 'expense', categoryId: 'cat_food', date: '2026-06-10' })); // spesa reale: il libero diventa negativo
  const chk = await runIntegrityChecks(s);
  assert.equal(chk.items.find((i) => i.id === 'vincoli_entro_saldo').severity, 'warn');
  assert.ok(forecast(s, TODAY, 30).issues.some((i) => i.kind === 'account_overcommitted'));
});
test('dati demo: validi, quadrati e senza dati reali', async () => {
  const st = await buildDemoState(ctx());
  assert.deepEqual(validateState(st), []);
  const chk = await runIntegrityChecks(st);
  assert.equal(chk.ok, true, JSON.stringify(chk.items.filter((i) => i.severity === 'error')));
  assert.ok(st.meta.demo);
  assert.ok(st.accounts.every((a) => /demo/i.test(a.name)));
  assert.ok(snapshot(st).free > 0);
  const f = forecast(st, TODAY, 90);
  assert.ok(f.issues.some((i) => i.kind === 'receivable_overdue')); // la demo mostra un incasso in ritardo
});
test('dati demo: pulizia riporta a stato vuoto mantenendo lo storico', async () => {
  let st = await buildDemoState(ctx());
  ({ state: st } = await C.clearDemoData(st, ctx()));
  assert.equal(st.accounts.length, 0); assert.equal(st.meta.demo, false);
  assert.equal((await runIntegrityChecks(st)).ok, true);
  assert.ok(st.audit.some((e) => e.action === 'clear_demo'));
});
