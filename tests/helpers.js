import { createEmptyState, makeCtx } from '../src/core/state.js';
import * as C from '../src/core/commands.js';

export const TODAY = '2026-06-15';
let counter = 0;
export const ctx = (over = {}) => makeCtx({ nowIso: '2026-06-15T10:00:00.000Z', today: TODAY, newId: () => `id${++counter}`, ...over });

/** Applica un comando e restituisce { state, result } (stato precedente intatto). */
export async function run(state, fn, ...args) {
  return fn(state, ctx(), ...args);
}
export async function base() {
  let s = createEmptyState(ctx());
  let r = await C.addAccount(s, ctx(), { name: 'Principale', openingCents: 100000, openingDate: '2026-01-01' });
  s = r.state; const a1 = r.result;
  r = await C.addAccount(s, ctx(), { name: 'Risparmio', type: 'savings', openingCents: 50000, openingDate: '2026-01-01' });
  s = r.state; const a2 = r.result;
  return { s, a1, a2 };
}
export async function expectError(promise, code) {
  try { await promise; } catch (e) {
    if (code && e.code !== code) throw new Error(`atteso codice ${code}, ricevuto ${e.code}: ${e.message}`);
    return e;
  }
  throw new Error('atteso errore, ma l\'operazione è riuscita');
}
