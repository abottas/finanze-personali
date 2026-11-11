// Test a sequenze casuali: dopo OGNI operazione (riuscita o rifiutata) gli invarianti contabili devono reggere.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { snapshot } from '../src/core/derive.js';
import { runIntegrityChecks } from '../src/core/integrity.js';
import { base, ctx, TODAY } from './helpers.js';
import { addDays } from '../src/core/dates.js';

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

for (const seed of [1, 7, 42, 2024]) {
  test(`invarianti con operazioni casuali (seed ${seed})`, async () => {
    const r = rng(seed);
    let { s } = await base();
    const pick = (a) => a[Math.floor(r() * a.length)];
    const amt = () => 100 + Math.floor(r() * 90000);
    let ok = 0, rejected = 0;
    for (let i = 0; i < 150; i++) {
      const accs = s.accounts.map((a) => a.id);
      const funds = s.funds.filter((f) => !f.archived).map((f) => f.id);
      const txs = s.transactions.filter((t) => t.status === 'posted').map((t) => t.id);
      const date = addDays(TODAY, -Math.floor(r() * 100));
      const ops = [
        () => C.addTransaction(s, ctx(), { accountId: pick(accs), cents: -amt(), kind: 'expense', categoryId: 'cat_food', date, fundId: funds.length && r() < 0.3 ? pick(funds) : null }),
        () => C.addTransaction(s, ctx(), { accountId: pick(accs), cents: amt(), kind: 'income', categoryId: 'cat_pro', date }),
        () => C.addTransfer(s, ctx(), { fromAccountId: pick(accs), toAccountId: pick(accs), cents: amt(), date }),
        () => C.addFund(s, ctx(), { name: 'F' + i, kind: 'reserve', accountId: pick(accs) }),
        () => funds.length && C.assignToFund(s, ctx(), pick(funds), amt()),
        () => funds.length && C.releaseFromFund(s, ctx(), pick(funds), amt()),
        () => funds.length > 1 && C.moveBetweenFunds(s, ctx(), pick(funds), pick(funds), amt()),
        () => txs.length && C.voidTransaction(s, ctx(), pick(txs), 'test casuale'),
        () => txs.length && C.updateTransaction(s, ctx(), pick(txs), { cents: -amt() }),
        () => funds.length && C.relocateFund(s, ctx(), pick(funds), pick(accs)),
        () => C.addPlanned(s, ctx(), { name: 'P' + i, cents: amt(), dueDate: addDays(TODAY, Math.floor(r() * 60)), accountId: pick(accs) }),
      ];
      const op = pick(ops)();
      if (!op) continue;
      try { ({ state: s } = await op); ok++; } catch (e) { assert.equal(e.name, 'AppError', e.stack); rejected++; }

      // Invarianti dopo ogni passo
      const sn = snapshot(s);
      const opening = s.accounts.reduce((x, a) => x + a.openingCents, 0);
      const flows = s.transactions.filter((t) => t.status === 'posted').reduce((x, t) => x + t.cents, 0);
      assert.equal(sn.total, opening + flows, 'conservazione (i trasferimenti non creano denaro)');
      assert.equal(sn.reserved + sn.free, sn.total, 'libero + vincolato = totale');
      for (const f of s.funds) assert.ok(sn.funds[f.id].available >= 0, 'fondo mai negativo');
      for (const t of s.transactions) assert.ok(Number.isSafeInteger(t.cents));
      for (const t of s.transfers) assert.ok(Number.isSafeInteger(t.cents) && t.cents > 0);
    }
    assert.ok(ok > 30, `poche operazioni riuscite (${ok})`);
    const chk = await runIntegrityChecks(s);
    assert.equal(chk.errors, 0, JSON.stringify(chk.items.filter((x) => x.severity === 'error')));
  });
}
