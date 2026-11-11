import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, KDF_ITERATIONS, checkPasswordStrength } from '../src/crypto/vault.js';
import { MemoryStorage } from '../src/storage/adapters.js';
import { createBackup, verifyBackup } from '../src/crypto/backup.js';
import { buildDemoState } from '../src/core/demo.js';
import * as C from '../src/core/commands.js';
import { ctx, expectError } from './helpers.js';
import { toB64, fromB64 } from '../src/crypto/b64.js';

const PW = 'correct horse battery staple';
const FAST = { iterations: 1000 }; // solo nei test, per velocità: il valore reale è verificato a parte
const secretState = async () => {
  let s = await buildDemoState(ctx());
  ({ state: s } = await C.addAccount(s, ctx(), { name: 'CONTO-SEGRETISSIMO-XYZ', openingCents: 987654321 }));
  return s;
};
const mk = () => { const storage = new MemoryStorage(); return { storage, vault: new Vault(storage, FAST) }; };

test('i parametri di produzione sono robusti: PBKDF2-SHA256 ≥ 600.000 iterazioni', () => {
  assert.ok(KDF_ITERATIONS >= 600_000);
  assert.equal(new Vault(new MemoryStorage()).iterations, KDF_ITERATIONS);
});
test('vault: round trip crea → blocca → sblocca restituisce lo stesso stato', async () => {
  const { vault } = mk(); const st = await secretState();
  await vault.create(PW, st); vault.lock();
  assert.equal(vault.unlocked, false);
  const { state } = await vault.unlock(PW);
  assert.deepEqual(state, st); assert.equal(vault.unlocked, true);
});
test('vault: NESSUN dato finanziario né nome in chiaro nello storage (nemmeno in base64)', async () => {
  const { storage, vault } = mk(); const st = await secretState();
  await vault.create(PW, st);
  await vault.save({ ...st, extra: 'ALTRO-SEGRETO-QWE' });
  const dump = storage.dump();
  for (const needle of ['CONTO-SEGRETISSIMO-XYZ', '987654321', 'ALTRO-SEGRETO-QWE', 'Accantonamento imposte', 'openingCents', 'transactions', PW]) {
    assert.ok(!dump.includes(needle), `trovato in chiaro: ${needle}`);
    assert.ok(!dump.includes(toB64(new TextEncoder().encode(needle))), `trovato in base64: ${needle}`);
  }
});
test('vault: password errata rifiutata; nessuna chiave in memoria dopo il rifiuto', async () => {
  const { vault } = mk(); await vault.create(PW, await secretState()); vault.lock();
  await expectError(vault.unlock('password sbagliata!'), 'password');
  assert.equal(vault.unlocked, false);
});
test('vault: la chiave di sessione NON è estraibile', async () => {
  const { vault } = mk(); await vault.create(PW, await secretState());
  assert.equal(vault.dekExtractable, false);
  vault.lock();
  await vault.unlock(PW);
  assert.equal(vault.dekExtractable, false);
});
test('vault: lock() elimina la chiave: salvare è impossibile', async () => {
  const { vault } = mk(); await vault.create(PW, await secretState()); vault.lock();
  await expectError(vault.save({}), 'bloccato');
});
test('vault: ogni salvataggio usa un IV diverso e un salt/IV non riutilizzati', async () => {
  const { storage, vault } = mk(); const st = await secretState();
  await vault.create(PW, st);
  const ivs = new Set();
  for (let i = 0; i < 20; i++) { await vault.save(st); ivs.add((await storage.get('data', `slot${vault.revision % 2}`)).iv); }
  assert.equal(ivs.size, 20);
});
test('vault: ciphertext manomesso → rilevato (GCM); recupero dallo slot precedente se valido', async () => {
  const { storage, vault } = mk(); const st = await secretState();
  await vault.create(PW, st);
  const st2 = { ...st, marker: 'v2' }; await vault.save(st2); vault.lock();
  const slot = `slot${2 % 2}`; // rev 2
  const rec = await storage.get('data', slot);
  const ct = fromB64(rec.ct); ct[10] ^= 0x01; rec.ct = toB64(ct);
  await storage.put('data', slot, rec);
  const out = await vault.unlock(PW);
  assert.equal(out.recovered, true); assert.deepEqual(out.state, st); // tornati all'ultimo salvataggio integro (rev 1)
});
test('vault: tutti gli slot corrotti → errore esplicito, mai dati parziali', async () => {
  const { storage, vault } = mk(); await vault.create(PW, await secretState()); await vault.save(await secretState()); vault.lock();
  for (const s of ['slot0', 'slot1']) { const r = await storage.get('data', s); const c = fromB64(r.ct); c[0] ^= 0xff; r.ct = toB64(c); await storage.put('data', s, r); }
  await expectError(vault.unlock(PW), 'dati_illeggibili');
});
test('vault: AAD impedisce di scambiare blob tra slot/revisioni (replay di uno slot sull\'altro)', async () => {
  const { storage, vault } = mk(); const st = await secretState();
  await vault.create(PW, st); await vault.save({ ...st, marker: 'nuovo' }); vault.lock();
  const s0 = await storage.get('data', 'slot0'), s1 = await storage.get('data', 'slot1');
  // dichiara che il contenuto della rev 1 è la rev 3 → l'AAD non coincide
  await storage.put('data', 'slot0', { ...s1, rev: 3 }); await storage.put('data', 'slot1', { ...s0, rev: 1 });
  const out = await vault.unlock(PW).catch((e) => e);
  assert.ok(out instanceof Error && out.code === 'dati_illeggibili');
});
test('vault: manomettere i parametri KDF (downgrade iterazioni) fa fallire lo sblocco', async () => {
  const { storage, vault } = mk(); await vault.create(PW, await secretState()); vault.lock();
  const meta = await storage.get('meta', 'vault'); meta.kdf.iterations = 1; await storage.put('meta', 'vault', meta);
  await expectError(vault.unlock(PW), 'password');
});
test('vault: cambio password – la vecchia smette di funzionare, i dati restano', async () => {
  const { vault } = mk(); const st = await secretState();
  await vault.create(PW, st);
  await expectError(vault.changePassword('sbagliata sbagliata', 'nuova password lunga 1'), 'password');
  await vault.changePassword(PW, 'nuova password lunga 1'); vault.lock();
  await expectError(vault.unlock(PW), 'password');
  assert.deepEqual((await vault.unlock('nuova password lunga 1')).state, st);
});
test('vault: i tentativi errati ripetuti introducono un ritardo', async () => {
  let t = 1_000_000; const storage = new MemoryStorage(); const vault = new Vault(storage, { ...FAST, now: () => t });
  await vault.create(PW, await secretState()); vault.lock();
  for (let i = 0; i < 4; i++) await expectError(vault.unlock('errata errata errata'), 'password');
  await expectError(vault.unlock(PW), 'throttled');
  t += 60_000;
  assert.ok((await vault.unlock(PW)).state);
});
test('vault: migrazione automatica a più iterazioni quando si sblocca', async () => {
  const storage = new MemoryStorage(); const weak = new Vault(storage, { iterations: 1000 });
  await weak.create(PW, await secretState()); weak.lock();
  const strong = new Vault(storage, { iterations: 2000 });
  await strong.unlock(PW);
  assert.equal((await storage.get('meta', 'vault')).kdf.iterations, 2000);
  strong.lock(); assert.ok((await strong.unlock(PW)).state);
});
test('vault: snapshot pre-ripristino cifrato e recuperabile', async () => {
  const { storage, vault } = mk(); const st = await secretState(); await vault.create(PW, st);
  await vault.saveSnapshot('pre-restore', st);
  assert.ok(!storage.dump().includes('CONTO-SEGRETISSIMO-XYZ'));
  assert.deepEqual((await vault.loadSnapshot('pre-restore')).state, st);
});
test('password: regole minime', () => {
  assert.equal(checkPasswordStrength('corta').ok, false);
  assert.equal(checkPasswordStrength('aaaaaaaaaaaaaaaa').ok, false);
  assert.equal(checkPasswordStrength('123456789012345').ok, false);
  assert.equal(checkPasswordStrength('una frase lunga e facile').ok, true);
});

// ───────────────────────────── Backup ─────────────────────────────
test('backup: round trip, riepilogo e quadratura verificati', async () => {
  const st = await secretState();
  const b = await createBackup(st, PW, FAST);
  assert.ok(b.filename.endsWith('.fpbak'));
  const v = await verifyBackup(b.text, PW);
  assert.deepEqual(v.state, st); assert.equal(v.summaryMatches, true); assert.equal(v.integrity.ok, true);
  assert.equal(v.summary.counts.accounts, st.accounts.length);
});
test('backup: file senza testo in chiaro', async () => {
  const b = await createBackup(await secretState(), PW, FAST);
  for (const n of ['CONTO-SEGRETISSIMO-XYZ', '987654321', 'transactions', 'Accantonamento']) assert.ok(!b.text.includes(n), n);
});
test('backup: password errata → rifiuto indistinguibile dalla manomissione', async () => {
  const b = await createBackup(await secretState(), PW, FAST);
  await expectError(verifyBackup(b.text, 'altra password lunga'), 'backup_password');
});
test('backup: qualsiasi bit alterato (ciphertext, iv, header) viene rilevato', async () => {
  const b = await createBackup(await secretState(), PW, FAST);
  const env = JSON.parse(b.text);
  const flip = (k) => { const x = structuredClone(env); const bytes = fromB64(x[k]); bytes[bytes.length >> 1] ^= 1; x[k] = toB64(bytes); return JSON.stringify(x); };
  await expectError(verifyBackup(flip('ct'), PW), 'backup_password');
  await expectError(verifyBackup(flip('iv'), PW), 'backup_password');
  const h = structuredClone(env); h.createdAt = '2000-01-01T00:00:00.000Z';
  await expectError(verifyBackup(JSON.stringify(h), PW), 'backup_password'); // header autenticato come AAD
  const k = structuredClone(env); k.kdf.iterations = 999;
  await expectError(verifyBackup(JSON.stringify(k), PW), 'backup_password');
});
test('backup: file non valido / formato errato / troncato', async () => {
  await expectError(verifyBackup('non json', PW), 'backup_formato');
  await expectError(verifyBackup('{"format":"altro"}', PW), 'backup_formato');
  const b = await createBackup(await secretState(), PW, FAST);
  await expectError(verifyBackup(b.text.slice(0, b.text.length - 40), PW), 'backup_formato');
  const v = JSON.parse(b.text); v.v = 99;
  await expectError(verifyBackup(JSON.stringify(v), PW), 'backup_versione');
  const d = JSON.parse(b.text); d.kdf.iterations = 1e9;
  await expectError(verifyBackup(JSON.stringify(d), PW), 'backup_formato');
});
test('backup: stato con dati incoerenti viene rifiutato anche se la cifratura è valida', async () => {
  const st = await secretState();
  const b = await createBackup(st, PW, FAST);
  // costruiamo un backup valido crittograficamente ma con stato corrotto
  const bad = structuredClone(st); bad.transactions.push({ ...bad.transactions[0], id: bad.transactions[0].id });
  await expectError(createBackup(bad, PW, FAST), 'stato_non_valido');
  void b;
});
test('backup + ripristino: lo stato ripristinato è identico e supera i controlli', async () => {
  const st = await secretState();
  const { vault } = mk();
  await vault.create(PW, st);
  const b = await createBackup(st, 'password di backup diversa', FAST);
  const v = await verifyBackup(b.text, 'password di backup diversa');
  const { state: restored } = await C.finalizeRestore(v.state, ctx(), 'Ripristino da backup');
  await vault.save(restored); vault.lock();
  const { state } = await vault.unlock(PW);
  assert.equal(state.accounts.length, st.accounts.length);
  assert.equal(state.audit.at(-1).action, 'restore');
});
