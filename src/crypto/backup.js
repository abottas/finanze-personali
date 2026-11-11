// Backup cifrato portabile (.fpbak). Indipendente dall'archivio: ha un proprio salt e una propria chiave
// derivata dalla password scelta al momento dell'esportazione.
//
// File = JSON { format, v, createdAt, app, kdf, iv, ct }  — l'header è autenticato come AAD (non modificabile).
// Contenuto cifrato = { state, stateSha256, summary }. Il ripristino verifica: tag GCM → hash → schema → quadratura.
import { toB64, fromB64 } from './b64.js';
import { sha256Hex } from './hash.js';
import { canonicalJson } from '../core/canonical.js';
import { AppError } from '../core/errors.js';
import { validateState } from '../core/validate.js';
import { migrateState } from '../core/state.js';
import { runIntegrityChecks } from '../core/integrity.js';
import { snapshot } from '../core/derive.js';
import { normalizePassword, KDF_ITERATIONS } from './vault.js';

export const BACKUP_FORMAT = 'FP-BACKUP';
export const BACKUP_VERSION = 1;
const MAX_BYTES = 64 * 1024 * 1024;
const te = new TextEncoder();
const td = new TextDecoder();

async function deriveKey(password, kdf) {
  const base = await crypto.subtle.importKey('raw', normalizePassword(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: kdf.hash, salt: fromB64(kdf.salt), iterations: kdf.iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const headerAad = (h) => te.encode('FP1|backup|' + canonicalJson({ format: h.format, v: h.v, createdAt: h.createdAt, app: h.app, kdf: h.kdf }));

export function summarize(state) {
  const snap = snapshot(state);
  return {
    counts: {
      accounts: state.accounts.length, transactions: state.transactions.length, transfers: state.transfers.length,
      funds: state.funds.length, allocations: state.allocations.length, receivables: state.receivables.length,
      planned: state.planned.length, audit: state.audit.length,
    },
    totalCents: snap.total, reservedCents: snap.reserved, freeCents: snap.free, auditSeq: state.audit.length,
    lastAuditHash: state.audit.length ? state.audit[state.audit.length - 1].hash : null,
    demo: !!state.meta.demo,
  };
}

export async function createBackup(state, password, { iterations = KDF_ITERATIONS, now = new Date(), appVersion = '0.5.0' } = {}) {
  const problems = validateState(state);
  if (problems.length) throw new AppError('stato_non_valido', 'Impossibile creare il backup: dati non validi (' + problems[0] + ')');
  const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(crypto.getRandomValues(new Uint8Array(16))) };
  const header = { format: BACKUP_FORMAT, v: BACKUP_VERSION, createdAt: now.toISOString(), app: `finanze-personali/${appVersion}`, kdf };
  const key = await deriveKey(password, kdf);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = { state, stateSha256: await sha256Hex(canonicalJson(state)), summary: summarize(state) };
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerAad(header) }, key, te.encode(JSON.stringify(payload))));
  const text = JSON.stringify({ ...header, iv: toB64(iv), ct: toB64(ct) });
  const stamp = now.toISOString().slice(0, 10);
  return { text, filename: `finanze-backup-${stamp}.fpbak`, summary: payload.summary };
}

function parseEnvelope(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw new AppError('backup_formato', 'File non valido o troppo grande');
  let env;
  try { env = JSON.parse(text); } catch { throw new AppError('backup_formato', 'Il file non è un backup valido'); }
  if (!env || env.format !== BACKUP_FORMAT) throw new AppError('backup_formato', 'Il file non è un backup di questa app');
  if (env.v !== BACKUP_VERSION) throw new AppError('backup_versione', `Versione di backup non supportata (${env.v})`);
  const k = env.kdf;
  if (!k || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || !Number.isInteger(k.iterations) || k.iterations < 1 || k.iterations > 20_000_000 || typeof k.salt !== 'string') {
    throw new AppError('backup_formato', 'Parametri di derivazione non validi');
  }
  if (typeof env.iv !== 'string' || typeof env.ct !== 'string' || typeof env.createdAt !== 'string') throw new AppError('backup_formato', 'File incompleto');
  return env;
}

/** Decifra e verifica un backup SENZA applicarlo. Ritorna { state, summary, createdAt, integrity }. */
export async function verifyBackup(text, password) {
  const env = parseEnvelope(text);
  let payload;
  try {
    const key = await deriveKey(password, env.kdf);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: headerAad(env) }, key, fromB64(env.ct));
    payload = JSON.parse(td.decode(pt));
  } catch {
    // Volutamente indistinguibile: password errata e file manomesso/corrotto.
    throw new AppError('backup_password', 'Password errata oppure file danneggiato o modificato');
  }
  if (!payload || typeof payload !== 'object' || !payload.state) throw new AppError('backup_contenuto', 'Contenuto del backup non valido');
  const hash = await sha256Hex(canonicalJson(payload.state));
  if (hash !== payload.stateSha256) throw new AppError('backup_hash', 'Verifica hash fallita: il contenuto non corrisponde');
  migrateState(payload.state); // backup di versioni precedenti: porta allo schema corrente DOPO aver verificato l'hash
  const problems = validateState(payload.state);
  if (problems.length) throw new AppError('backup_schema', 'Il backup contiene dati non validi: ' + problems[0]);
  const summary = summarize(payload.state);
  const sameSummary = canonicalJson(summary) === canonicalJson(payload.summary);
  const integrity = await runIntegrityChecks(payload.state);
  return { state: payload.state, summary, createdAt: env.createdAt, app: env.app, integrity, summaryMatches: sameSummary };
}
