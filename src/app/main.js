// Avvio, blocco/sblocco, sessione, router, delega eventi.
import { html, raw, esc } from './html.js';
import { I } from './icons.js';
import { createActions } from './actions.js';
import { viewOverview, viewMoves, viewFunds, viewIncome, viewPlan, viewSettings, viewAnalysis, viewSituation } from './views.js';
import { Vault, KDF_ITERATIONS, checkPasswordStrength, MIN_PASSWORD_LENGTH } from '../crypto/vault.js';
import { IdbStorage } from '../storage/adapters.js';
import { createEmptyState, makeCtx, migrateState } from '../core/state.js';
import { validateState } from '../core/validate.js';
import { buildDemoState } from '../core/demo.js';
import { validateProfile } from '../core/profile.js';
import { runIntegrityChecks } from '../core/integrity.js';
import { verifyBackup } from '../crypto/backup.js';
import { today as todayLocal } from '../core/dates.js';
import { AppError } from '../core/errors.js';
import * as C from '../core/commands.js';

const VERSION = '0.13.3';
const $ = (s) => document.querySelector(s);
const root = $('#app'), sheetRoot = $('#sheet-root'), toastEl = $('#toast'), cover = $('#cover');

const vault = new Vault(new IdbStorage('fp-vault'));
const app = {
  state: null, version: VERSION, kdfIterations: KDF_ITERATIONS, hide: false, integrity: null,
  today: todayLocal(), nowIso: new Date().toISOString(),
  ui: { moveFilter: '', moveAccount: '', showVoid: false, limit: 60, histLimit: 60, showExpected: false, allocAccount: null },
  pendingBackup: null, pendingRestore: null,
};
const TABS = [['overview', 'Panoramica', I.home], ['moves', 'Movimenti', I.moves], ['funds', 'Fondi', I.funds], ['income', 'Incassi', I.income], ['plan', 'Pianificazione', I.plan]];

// ───────────── Toast / Sheet ─────────────
let toastT;
function toast(msg, err = false) {
  toastEl.textContent = msg; toastEl.classList.toggle('err', err); toastEl.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), err ? 4200 : 2200);
}
let sheetSpec = null;
function closeSheet() {
  if (!sheetSpec) return;
  const spec = sheetSpec; sheetSpec = null;
  sheetRoot.innerHTML = ''; document.body.style.overflow = '';
  try { spec.onClose?.(); } catch { /* ignore */ }
}
function openSheet(spec) {
  closeSheet();
  sheetSpec = spec;
  const body = html`<div class="sheet-backdrop" data-action="close-sheet"></div>
    <form class="sheet" data-form="sheet" novalidate role="dialog" aria-modal="true" aria-label="${spec.title}" ${spec.kind ? raw(`data-kind="${esc(spec.kind)}"`) : ''}>
      <header><h3>${spec.title}</h3></header>
      <div class="body">${spec.body}<div class="form-error" role="alert"></div></div>
      <footer><button type="button" class="btn" data-action="close-sheet">${spec.cancel ?? 'Annulla'}</button>${spec.submit ? html`<button type="submit" class="btn ${spec.danger ? 'danger' : 'primary'}">${spec.submit}</button>` : ''}</footer>
    </form>`;
  sheetRoot.innerHTML = body.s;
  document.body.style.overflow = 'hidden';
  const form = sheetRoot.querySelector('form');
  form.querySelectorAll('input[data-sets]:checked').forEach((r) => { form.dataset[r.dataset.sets] = r.value; });
  hydrate(sheetRoot);
  const first = form.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select');
  if (first && !/iPhone|iPad/.test(navigator.userAgent)) first.focus();
}
async function submitSheet(form) {
  const spec = sheetSpec; if (!spec?.onSubmit) return closeSheet();
  const err = form.querySelector('.form-error');
  const btn = form.querySelector('button[type=submit]');
  err.textContent = '';
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const values = Object.fromEntries([...new FormData(form).entries()].filter(([, v]) => typeof v === 'string'));
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Attendi…';
  try {
    const r = await spec.onSubmit(values, form);
    if (r !== false && sheetSpec === spec) closeSheet();
  } catch (e) {
    err.textContent = userMessage(e);
    if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
}
function userMessage(e) {
  if (e instanceof AppError) return e.message;
  console.error(e);
  return 'Operazione non riuscita: nessuna modifica è stata applicata.';
}

// ───────────── Stato: commit atomico ─────────────
let queue = Promise.resolve();
function commit(fn) {
  const p = queue.then(async () => {
    if (!app.state) throw new AppError('bloccato', 'App bloccata');
    const out = await fn(app.state, makeCtx());
    await vault.save(out.state);            // se la scrittura fallisce lo stato in memoria NON cambia
    app.state = out.state;
    armIdle();
    refreshIntegrity();
    render();
    return out.result;
  });
  queue = p.catch(() => {});
  return p;
}
let integrityToken = 0;
async function refreshIntegrity(force = false) {
  if (!app.state) return;
  const tok = ++integrityToken;
  if (force) { app.integrity = null; render(); }
  const r = await runIntegrityChecks(app.state);
  if (tok === integrityToken && app.state) { app.integrity = r; render(); }
}

// ───────────── Sessione / blocco ─────────────
let idleT = null, lastActivity = Date.now(), hiddenAt = null;
function armIdle() {
  lastActivity = Date.now();
  clearTimeout(idleT);
  if (!app.state) return;
  idleT = setTimeout(() => lock('Bloccata per inattività'), app.state.settings.autoLockSec * 1000);
}
function lock(msg = '') {
  clearTimeout(idleT);
  vault.lock();
  app.state = null; app.integrity = null; app.pendingBackup = null; app.pendingRestore = null;
  sheetSpec = null; sheetRoot.innerHTML = ''; document.body.style.overflow = '';
  showUnlock(msg);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); if (app.state) cover.classList.add('on'); }
  else {
    cover.classList.remove('on');
    if (app.state) {
      const s = app.state.settings;
      if (hiddenAt && Date.now() - hiddenAt > s.hiddenLockSec * 1000) lock('Bloccata');
      else if (Date.now() - lastActivity > s.autoLockSec * 1000) lock('Bloccata per inattività');
      else armIdle();
    }
    hiddenAt = null;
  }
});
window.addEventListener('pagehide', () => { if (app.state) cover.classList.add('on'); });
window.addEventListener('pageshow', () => { if (document.visibilityState === 'visible') cover.classList.remove('on'); });
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'scroll']) window.addEventListener(ev, () => { if (app.state) { lastActivity = Date.now(); armIdle(); } }, { passive: true, capture: true });

async function wipe() {
  await vault.destroy();
  location.hash = ''; location.reload();
}

// ───────────── Schermate di accesso ─────────────
const lockHeader = (title, text) => html`<div class="logo">${I.logo}</div><h1>${title}</h1><p>${text}</p>`;
function showUnlock(msg = '') {
  root.innerHTML = html`<div class="lock-screen">${lockHeader('Finanze', 'I tuoi dati sono cifrati su questo dispositivo.')}
    ${msg ? html`<div class="alert">${I.lock}<span>${msg}</span></div>` : ''}
    <form data-form="unlock" novalidate>
      <label class="field"><span>Password</span><input type="password" name="pw" autocomplete="current-password" required autofocus></label>
      <div class="form-error" role="alert"></div>
      <button class="btn primary block" type="submit">Sblocca</button>
    </form>
    <button class="link-btn" data-action="open-restore-setup">Ripristina da backup…</button></div>`.s;
}
function showSetup(mode = 'new') {
  root.innerHTML = html`<div class="lock-screen">${lockHeader('Benvenuto', 'Crea la tua password. Tutto resta cifrato su questo iPhone: nessun account, nessun server.')}
    <form data-form="setup" data-start="demo" novalidate>
      <label class="field"><span>Password</span><input type="password" name="pw" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}"><small class="hint">Almeno ${MIN_PASSWORD_LENGTH} caratteri. Una frase di più parole è la scelta migliore.</small></label>
      <label class="field"><span>Ripeti password</span><input type="password" name="pw2" autocomplete="new-password" required></label>
      <div class="seg"><label><input type="radio" name="start" value="demo" checked data-sets="start"><span>Dati demo</span></label><label><input type="radio" name="start" value="profile" data-sets="start"><span>Mio profilo</span></label><label><input type="radio" name="start" value="empty" data-sets="start"><span>Vuoto</span></label></div>
      <div class="profile-pick"><label class="field"><span>File del profilo personale (.json)</span><input type="file" name="profileFile" accept=".json,application/json"><small class="hint">Contiene conti, regole e scadenze già configurati. Non c'è nel repository: l'hai ricevuto da Claude. Dopo l'importazione puoi cancellarlo.</small></label></div>
      <label class="check"><input type="checkbox" name="ack" required><span>Ho capito che <b>se dimentico la password i dati non sono recuperabili</b> (se non da un backup).</span></label>
      <div class="form-error" role="alert"></div>
      <button class="btn primary block" type="submit">Crea archivio cifrato</button>
    </form>
    <button class="link-btn" data-action="open-restore-setup">Ho già un backup: ripristina…</button></div>`.s;
}
function showBroken(problems) {
  root.innerHTML = html`<div class="lock-screen">${lockHeader('Dati non validi', 'L\'archivio si apre ma i dati non superano la validazione. Non è stato modificato nulla.')}
    <div class="form-error" role="alert">${problems.slice(0, 3).join(' · ')}</div>
    <button class="btn primary block" data-action="open-restore-setup">Ripristina da backup</button><button class="link-btn" data-action="lock">Blocca</button></div>`.s;
}

async function afterUnlock(state, { recovered = false } = {}) {
  migrateState(state);
  const problems = validateState(state);
  app.state = state;
  if (problems.length) { showBroken(problems); return; }
  armIdle(); refreshIntegrity();
  if (!location.hash) history.replaceState(null, '', '#/overview'); // senza evento hashchange: non chiude i fogli aperti
  render();
  // Genera gli incassi attesi delle fatture ricorrenti dei prossimi mesi (idempotente) e salva se serve.
  if (state.invoiceTemplates.some((t) => t.active !== false)) {
    try { const before = state.receivables.length; await commit(async (s, c) => { const r = await C.materializeInvoices(s, c); return r.state.receivables.length === before ? { state: s, result: 0 } : r; }); } catch (e) { console.error(e); }
  }
  // Budget finanziato: all'inizio di ogni settimana riserva il budget dal denaro libero del conto spese.
  if (state.settings.budget.fundId) {
    try {
      const r = await commit(async (s, c) => { const o = await C.runBudgetFunding(s, c); return o.result.skipped ? { state: s, result: o.result } : o; });
      if (r.funded > 0) toast(r.shortfall > 0 ? `Budget finanziato ${(r.funded / 100).toLocaleString('it-IT')} € · mancano ${(r.shortfall / 100).toLocaleString('it-IT')} €` : 'Budget della settimana finanziato');
    } catch (e) { console.error(e); }
  }
  // Scadenze finanziate in anticipo (una volta al giorno, all'apertura).
  if (state.settings.plannedFunding.enabled) {
    try {
      const r = await commit(async (s, c) => { const o = await C.runPlannedFunding(s, c); return o.result.skipped ? { state: s, result: o.result } : o; });
      const sh = r.shortfalls ?? [];
      if (sh.length) toast(`Scadenze non coperte: ${sh.map((x) => x.name).slice(0, 3).join(', ')}${sh.length > 3 ? '…' : ''}`, true);
      else if (r.funded > 0) toast('Scadenze finanziate in anticipo');
    } catch (e) { console.error(e); }
  }
  // Versamenti interni a scadenza (es. PAC dalla tasca Tasse alla tasca PAC) configurati come automatici.
  if (state.planned.some((p) => p.status === 'planned' && p.autoExecute && !p.confirm && p.dueDate <= app.today)) {
    try { const n = await commit(async (s, c) => { const r = await C.runAutoPlanned(s, c); return r.result ? r : { state: s, result: 0 }; }); if (n) toast(`${n} versament${n > 1 ? 'i' : 'o'} automatic${n > 1 ? 'i' : 'o'} eseguit${n > 1 ? 'i' : 'o'} (PAC)`); } catch (e) { console.error(e); }
  }
  // Archivio vuoto appena creato: propone la configurazione guidata.
  if (!state.meta.demo && state.accounts.length === 0 && !app.onboardingShown) { app.onboardingShown = true; actions.onboarding(); }
  if (state.accounts.some((a) => a.origin === 'profile' && a.balanceUnknown) && state.audit.length < 40) toast('Profilo caricato: imposta i saldi “da aggiornare”');
  if (recovered) toast('Dati recuperati dall\'ultimo salvataggio integro', true);
  try { await navigator.storage?.persist?.(); app.persisted = (await navigator.storage?.persisted?.()) ?? null; } catch { /* facoltativo */ }
}

// ───────────── Render ─────────────
function route() { const h = location.hash.replace(/^#\/?/, '') || 'overview'; const [a, ...b] = h.split('/'); return { name: a, sub: b.join('/') || null }; }
function hydrate(scope) { scope.querySelectorAll('[data-w]').forEach((el) => { el.style.width = el.dataset.w + '%'; }); }
function render() {
  if (!app.state) return;
  const d = new Date(); app.today = todayLocal(d); app.nowIso = d.toISOString();
  const r = route();
  let content, tabs = true;
  switch (r.name) {
    case 'moves': content = viewMoves(app); break;
    case 'funds': content = viewFunds(app); break;
    case 'income': content = viewIncome(app); break;
    case 'plan': content = viewPlan(app); break;
    case 'analysis': content = viewAnalysis(app); break;
    case 'situation': content = viewSituation(app); break;
    case 'settings': content = viewSettings(app, r.sub); tabs = false; break;
    default: content = viewOverview(app);
  }
  const scroll = window.scrollY;
  root.innerHTML = html`${content}${tabs ? html`<div class="tabbar"><nav aria-label="Sezioni">${TABS.map(([id, label, icon]) => html`<button class="tab" data-nav="${id}" ${(r.name || 'overview') === id || (id === 'plan' && r.name === 'situation') || (id === 'overview' && (r.name === 'analysis' || !TABS.some((t) => t[0] === r.name))) ? raw('aria-current="page"') : ''}>${icon}<span>${label}</span></button>`)}</nav></div>` : ''}`.s;
  hydrate(root);
  window.scrollTo(0, scroll);
}
function nav(path) {
  const target = '#/' + path;
  if (location.hash === target) { render(); return; }
  location.hash = target; window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { if (app.state) { closeSheet(); render(); } });

// ───────────── Azioni e delega eventi ─────────────
const api = { app, vault, kdfIterations: KDF_ITERATIONS, commit, toast, openSheet, closeSheet, nav, render, lock, wipe, refreshIntegrity, rearmIdle: armIdle };
const { actions, forms, changes } = createActions(api);
actions['close-sheet'] = () => closeSheet();

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-nav],[data-action],[data-fill]');
  if (!t) return;
  if (t.dataset.fill !== undefined) { const i = t.closest('form')?.querySelector('input[name=amount]'); if (i) i.value = t.dataset.fill; return; }
  if (t.dataset.nav) { e.preventDefault(); nav(t.dataset.nav); return; }
  const fn = actions[t.dataset.action];
  if (!fn) return;
  e.preventDefault();
  try { await fn(t, e); } catch (err) { toast(userMessage(err), true); }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('input[data-sets]')) { const f = el.closest('form'); if (f) f.dataset[el.dataset.sets] = el.value; }
  if (el.dataset.change && changes[el.dataset.change]) changes[el.dataset.change](el);
});
document.addEventListener('input', (e) => {   // aggiornamento "dal vivo" solo dove richiesto (data-live)
  const el = e.target;
  if (el.dataset?.live != null && el.dataset.change && changes[el.dataset.change]) changes[el.dataset.change](el);
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]'); if (!form) return;
  e.preventDefault();
  const name = form.dataset.form;
  if (name === 'sheet') return submitSheet(form);
  const err = form.querySelector('.form-error'); const btn = form.querySelector('button[type=submit]');
  if (err) err.textContent = '';
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const v = Object.fromEntries([...new FormData(form).entries()].filter(([, x]) => typeof x === 'string'));
  const label = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = 'Attendi…'; }
  try {
    if (name === 'unlock') {
      const { state, recovered } = await vault.unlock(v.pw);
      form.reset();
      await afterUnlock(state, { recovered });
    } else if (name === 'setup') {
      if (v.pw !== v.pw2) throw new AppError('pw', 'Le due password non coincidono');
      const ok = checkPasswordStrength(v.pw); if (!ok.ok) throw new AppError('pw', ok.message);
      const ctx = makeCtx();
      let state;
      if (v.start === 'profile') {
        const file = form.elements.profileFile.files[0];
        if (!file) throw new AppError('file', 'Seleziona il file del profilo');
        if (file.size > 2 * 1024 * 1024) throw new AppError('file', 'File troppo grande');
        let profile; try { profile = JSON.parse(await file.text()); } catch { throw new AppError('file', 'Il file non è un JSON valido'); }
        const problems = validateProfile(profile);
        if (problems.length) throw new AppError('profilo', 'Profilo non valido: ' + problems[0]);
        state = (await C.applyProfile(createEmptyState(ctx), ctx, profile)).state;
      } else state = v.start === 'demo' ? await buildDemoState(ctx) : createEmptyState(ctx);
      await vault.create(v.pw, state);
      form.reset();
      await afterUnlock(state);
    } else if (forms[name]) await forms[name](v, form);
  } catch (ex) {
    if (err) err.textContent = userMessage(ex);
    if (btn?.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
});

// Ripristino a archivio non ancora creato/sbloccato: crea un nuovo archivio dai dati del backup.
const baseOpenRestore = actions['open-restore-setup'];
actions['open-restore-setup'] = async () => {
  if (app.state) { baseOpenRestore(); return; }
  openSheet({
    title: 'Ripristina da backup', submit: 'Verifica e ripristina',
    body: html`<div class="note">Se esiste già un archivio su questo dispositivo, verrà <b>sostituito</b>. Imposta una password per l'app (può essere diversa da quella del backup).</div>
      <label class="field"><span>File di backup (.fpbak)</span><input type="file" name="file" accept=".fpbak,application/json,application/octet-stream" required></label>
      <label class="field"><span>Password del backup</span><input type="password" name="bpw" autocomplete="off" required></label>
      <label class="field"><span>Nuova password dell'app</span><input type="password" name="pw" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}"></label>
      <label class="field"><span>Ripeti password dell'app</span><input type="password" name="pw2" autocomplete="new-password" required></label>`,
    onSubmit: async (v, form) => {
      if (v.pw !== v.pw2) throw new AppError('pw', 'Le due password non coincidono');
      const ok = checkPasswordStrength(v.pw); if (!ok.ok) throw new AppError('pw', ok.message);
      const file = form.elements.file.files[0]; if (!file) throw new AppError('file', 'Seleziona un file');
      const res = await verifyBackup(await file.text(), v.bpw);
      if (!res.integrity.ok) throw new AppError('quadratura', 'Il backup presenta errori di quadratura: ripristino bloccato');
      const ctx = makeCtx();
      const { state } = await C.finalizeRestore(res.state, ctx, 'Ripristino da backup su nuovo archivio');
      await vault.destroy();
      await vault.create(v.pw, state);
      closeSheet();
      await afterUnlock(state);
      toast('Backup ripristinato');
    },
  });
};

// ───────────── Avvio ─────────────
async function boot() {
  if (!window.crypto?.subtle || !window.indexedDB) {
    root.innerHTML = html`<div class="lock-screen">${lockHeader('Browser non supportato', 'Servono Web Crypto e IndexedDB, disponibili solo in contesto sicuro (HTTPS).')}</div>`.s;
    return;
  }
  try { (await vault.exists()) ? showUnlock() : showSetup(); }
  catch (e) { console.error(e); root.innerHTML = html`<div class="lock-screen">${lockHeader('Archivio non accessibile', 'Impossibile aprire il database locale. In navigazione privata IndexedDB può essere limitato.')}</div>`.s; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
}
boot();
