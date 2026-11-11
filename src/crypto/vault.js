// Archivio cifrato locale.
//
//  password ──PBKDF2-HMAC-SHA256 (600k iter, salt 16B)──▶ KEK (AES-256-GCM, NON estraibile, solo wrap/unwrap)
//  DEK casuale 256 bit ──wrapKey(AES-GCM, KEK)──▶ salvata in IndexedDB (mai in chiaro)
//  stato (JSON) ──AES-256-GCM(DEK, IV casuale 96 bit, AAD = "FP1|data|<rev>")──▶ salvato in 2 slot alternati
//
//  • La password non viene mai salvata. Una password errata fa fallire l'unwrap della DEK (tag GCM).
//  • In sessione la DEK è un CryptoKey NON estraibile: lo script non può leggerne i byte.
//  • Cambiare password = ri-cifrare solo la DEK (non i dati).
//  • AAD lega ogni blob al proprio ruolo/revisione: non si possono scambiare blob tra slot o ruoli.
import { toB64, fromB64 } from './b64.js';
import { canonicalJson } from '../core/canonical.js';
import { AppError } from '../core/errors.js';

export const KDF_ITERATIONS = 600_000; // OWASP 2023 per PBKDF2-HMAC-SHA256
export const MIN_PASSWORD_LENGTH = 12;
const te = new TextEncoder();
const td = new TextDecoder();
const SLOTS = ['slot0', 'slot1'];

export function normalizePassword(p) { return te.encode(String(p).normalize('NFKC')); }

export function checkPasswordStrength(p) {
  const s = String(p);
  if (s.length < MIN_PASSWORD_LENGTH) return { ok: false, message: `Usa almeno ${MIN_PASSWORD_LENGTH} caratteri (meglio una frase di più parole)` };
  if (new Set(s).size < 5) return { ok: false, message: 'Password troppo ripetitiva' };
  if (/^\d+$/.test(s)) return { ok: false, message: 'Non usare solo numeri' };
  return { ok: true, message: '' };
}

async function deriveKek(password, kdf) {
  const base = await crypto.subtle.importKey('raw', normalizePassword(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: kdf.hash, salt: fromB64(kdf.salt), iterations: kdf.iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}
const wrapAad = (kdf) => te.encode('FP1|wrap|' + canonicalJson(kdf));
const dataAad = (slotRole, rev) => te.encode(`FP1|${slotRole}|${rev}`);

async function wrapDek(dek, kek, kdf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv, additionalData: wrapAad(kdf) }));
  return { iv: toB64(iv), ct: toB64(ct) };
}
function unwrapDek(wrap, kek, kdf, extractable) {
  return crypto.subtle.unwrapKey('raw', fromB64(wrap.ct), kek, { name: 'AES-GCM', iv: fromB64(wrap.iv), additionalData: wrapAad(kdf) },
    { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}
async function encryptJson(dek, obj, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, dek, te.encode(JSON.stringify(obj))));
  return { iv: toB64(iv), ct: toB64(ct) };
}
async function decryptJson(dek, rec, aad) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(rec.iv), additionalData: aad }, dek, fromB64(rec.ct));
  return JSON.parse(td.decode(pt));
}

export class Vault {
  #dek = null;
  #rev = 0;
  constructor(storage, { iterations = KDF_ITERATIONS, now = () => Date.now() } = {}) {
    this.storage = storage;
    this.iterations = iterations;
    this.now = now;
  }
  get unlocked() { return this.#dek !== null; }
  get revision() { return this.#rev; }
  /** Solo diagnostica/test: la chiave di sessione non deve essere estraibile. */
  get dekExtractable() { return this.#dek ? this.#dek.extractable : null; }

  async exists() { return !!(await this.storage.get('meta', 'vault')); }

  async create(password, initialState) {
    if (await this.exists()) throw new AppError('esiste', 'Esiste già un archivio');
    // Nessun residuo: se il browser ha cancellato solo una parte dei dati, non devono restare blob orfani di una chiave precedente.
    await this.storage.clearAll();
    const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: this.iterations, salt: toB64(crypto.getRandomValues(new Uint8Array(16))) };
    const kek = await deriveKek(password, kdf);
    const dekTmp = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const wrap = await wrapDek(dekTmp, kek, kdf);
    this.#dek = await unwrapDek(wrap, kek, kdf, false); // da qui in poi: non estraibile
    this.#rev = 1;
    const rec = await encryptJson(this.#dek, initialState, dataAad('data', 1));
    await this.storage.putMany([
      ['meta', 'vault', { v: 1, kdf, wrap, createdAt: new Date(this.now()).toISOString() }],
      ['data', SLOTS[1], { rev: 1, ...rec }],
    ]);
  }

  async #throttleCheck() {
    const t = await this.storage.get('meta', 'throttle');
    if (t && t.until > this.now()) {
      throw new AppError('throttled', `Troppi tentativi. Riprova tra ${Math.ceil((t.until - this.now()) / 1000)} secondi.`);
    }
    return t ?? { fails: 0, until: 0 };
  }
  async #recordFail(t) {
    const fails = t.fails + 1;
    const delay = fails < 4 ? 0 : Math.min(300, 2 ** (fails - 3)) * 1000; // cosmetico: la vera difesa è il KDF
    await this.storage.put('meta', 'throttle', { fails, until: this.now() + delay });
  }

  /** Ritorna { state, recovered }. Lancia AppError('password') se errata. */
  async unlock(password) {
    const meta = await this.storage.get('meta', 'vault');
    if (!meta) throw new AppError('nessun_archivio', 'Nessun archivio presente');
    const th = await this.#throttleCheck();
    let dek;
    try {
      const kek = await deriveKek(password, meta.kdf);
      dek = await unwrapDek(meta.wrap, kek, meta.kdf, false);
    } catch {
      await this.#recordFail(th);
      throw new AppError('password', 'Password errata');
    }
    if (th.fails) await this.storage.delete('meta', 'throttle');
    const slots = (await Promise.all(SLOTS.map((s) => this.storage.get('data', s)))).filter(Boolean).sort((a, b) => b.rev - a.rev);
    let result = null, newestFailed = false;
    for (const rec of slots) {
      try {
        const state = await decryptJson(dek, rec, dataAad('data', rec.rev));
        result = { state, rev: rec.rev };
        break;
      } catch { newestFailed = newestFailed || !result; }
    }
    if (!result) throw new AppError('dati_illeggibili', 'I dati cifrati risultano danneggiati. Ripristina da un backup.');
    this.#dek = dek;
    this.#rev = result.rev;
    // Migrazione KDF: se i parametri salvati sono più deboli di quelli attuali, ri-cifra la DEK.
    if (meta.kdf.iterations < this.iterations) { try { await this.#rewrap(password, password); } catch { /* non bloccante */ } }
    return { state: result.state, recovered: newestFailed };
  }

  lock() { this.#dek = null; this.#rev = 0; }

  /** Cifra e salva lo stato. Alterna due slot: l'ultimo salvataggio valido precedente resta disponibile. */
  async save(state) {
    if (!this.#dek) throw new AppError('bloccato', 'Archivio bloccato');
    const rev = this.#rev + 1;
    const rec = await encryptJson(this.#dek, state, dataAad('data', rev));
    await this.storage.put('data', SLOTS[rev % 2], { rev, ...rec });
    this.#rev = rev;
    return rev;
  }

  /** Snapshot cifrato separato (es. copia di sicurezza pre-ripristino). */
  async saveSnapshot(name, state) {
    if (!this.#dek) throw new AppError('bloccato', 'Archivio bloccato');
    const rec = await encryptJson(this.#dek, state, te.encode(`FP1|snap|${name}`));
    await this.storage.put('data', `snap:${name}`, { at: new Date(this.now()).toISOString(), ...rec });
  }
  async loadSnapshot(name) {
    if (!this.#dek) throw new AppError('bloccato', 'Archivio bloccato');
    const rec = await this.storage.get('data', `snap:${name}`);
    if (!rec) return null;
    return { at: rec.at, state: await decryptJson(this.#dek, rec, te.encode(`FP1|snap|${name}`)) };
  }

  async changePassword(oldPassword, newPassword) {
    if (!this.#dek) throw new AppError('bloccato', 'Archivio bloccato');
    await this.#rewrap(oldPassword, newPassword);
  }
  async #rewrap(oldPassword, newPassword) {
    const meta = await this.storage.get('meta', 'vault');
    let dekTmp;
    try { dekTmp = await unwrapDek(meta.wrap, await deriveKek(oldPassword, meta.kdf), meta.kdf, true); }
    catch { throw new AppError('password', 'Password attuale errata'); }
    const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: this.iterations, salt: toB64(crypto.getRandomValues(new Uint8Array(16))) };
    const kek = await deriveKek(newPassword, kdf);
    const wrap = await wrapDek(dekTmp, kek, kdf);
    await this.storage.put('meta', 'vault', { ...meta, kdf, wrap, passwordChangedAt: new Date(this.now()).toISOString() });
    this.#dek = await unwrapDek(wrap, kek, kdf, false);
  }

  /** Cancella tutto (archivio, snapshot, throttle). Irreversibile. */
  async destroy() { this.lock(); await this.storage.clearAll(); }
}
