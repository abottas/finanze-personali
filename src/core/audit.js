// Storico modifiche a catena di hash: ogni voce include l'hash della precedente.
// Rileva modifiche, cancellazioni o riordini in mezzo alla catena (non il troncamento in coda: vedi docs/SICUREZZA.md).
import { canonicalJson } from './canonical.js';
import { sha256Hex } from '../crypto/hash.js';

export const GENESIS = '0'.repeat(64);

export async function appendAudit(state, e, ctx) {
  const prev = state.audit.length ? state.audit[state.audit.length - 1] : null;
  const entry = {
    seq: (prev ? prev.seq : 0) + 1,
    id: ctx.newId(),
    ts: ctx.nowIso,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    note: e.note ?? '',
    prev: prev ? prev.hash : GENESIS,
  };
  entry.hash = await sha256Hex(canonicalJson(entry));
  state.audit.push(entry);
  return entry;
}

export async function verifyAuditChain(audit) {
  let prev = GENESIS;
  let seq = 0;
  for (let i = 0; i < audit.length; i++) {
    const { hash, ...rest } = audit[i];
    if (rest.seq !== ++seq || rest.prev !== prev) return { ok: false, brokenAt: i };
    if ((await sha256Hex(canonicalJson(rest))) !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true, brokenAt: null };
}
