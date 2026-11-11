// Prova end-to-end in un vero browser (Chromium via Playwright). Uso: node scripts/e2e.mjs [cartella-screenshot]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = process.argv[2] ?? '/tmp/fp-shots';
mkdirSync(OUT, { recursive: true });
const PW = 'frase di prova per i test';
const server = spawn('node', ['scripts/serve.mjs', '8099'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const URL_ = 'http://127.0.0.1:8099/';
const errors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true, locale: 'it-IT', hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const external = [];
page.on('request', (r) => { if (!r.url().startsWith(URL_)) external.push(r.url()); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const location_hash = (u) => new URL(u).hash;
const step = (m) => console.log('•', m);

await page.goto(URL_);
await page.waitForSelector('form[data-form=setup]');
await shot('01-setup');
step('creazione archivio con dati demo');
await page.fill('input[name=pw]', PW); await page.fill('input[name=pw2]', PW); await page.check('input[name=ack]');
await page.click('button[type=submit]');
await page.waitForSelector('.hero', { timeout: 20000 });
await page.waitForTimeout(600);
await shot('02-overview');
const heroText = await page.textContent('.hero');
assert.match(heroText, /Saldo totale/); assert.match(heroText, /Liquidità libera/);

for (const [tab, name] of [['moves', '03-movimenti'], ['funds', '04-fondi'], ['income', '05-incassi'], ['plan', '06-pianificazione']]) {
  await page.click(`.tab[data-nav=${tab}]`); await page.waitForTimeout(450); await shot(name);
}
step('nuova uscita da movimenti');
await page.click('.tab[data-nav=moves]'); await page.click('.fab');
await page.waitForSelector('.sheet'); await shot('07-nuovo-movimento');
await page.fill('input[name=amount]', '23,50'); await page.fill('input[name=note]', 'Cena <b>test</b>');
await page.click('.sheet button[type=submit]');
await page.waitForSelector('.sheet', { state: 'detached' });
const list = await page.textContent('.screen');
assert.match(list, /Cena <b>test<\/b>/); // l'HTML inserito viene mostrato come testo, non interpretato
assert.equal(await page.locator('.screen b:has-text("test")').count(), 0);
step('trasferimento: non cambia il saldo totale');
const total = async () => page.textContent('.hero .big');
await page.click('.tab[data-nav=overview]'); const before = await total();
await page.click('.tab[data-nav=moves]'); await page.click('.fab');
await page.check('input[value=transfer]', { force: true });
await page.fill('input[name=amount]', '50'); await page.selectOption('select[name=from]', { index: 0 }); await page.selectOption('select[name=to]', { index: 1 });
await page.click('.sheet button[type=submit]'); await page.waitForSelector('.sheet', { state: 'detached' });
await page.click('.tab[data-nav=overview]'); assert.equal(await total(), before);

step('incasso ricevuto → proposta di allocazione');
await page.click('.tab[data-nav=income]');
await page.click('button[data-action=receive] >> nth=0');
await page.waitForSelector('.sheet'); await shot('08-incasso');
await page.click('.sheet button[type=submit]');
await page.waitForSelector('.sheet:has-text("Come usi questo incasso")', { timeout: 5000 }); await page.waitForTimeout(300); await shot('09-allocazione');
await page.click('.sheet button[type=submit]'); await page.waitForSelector('.sheet', { state: 'detached' });

step('controlli di quadratura');
await page.click('.tab[data-nav=overview]'); await page.click('button[data-nav=settings]'); await page.waitForTimeout(300); await shot('10-impostazioni');
await page.click('button[data-nav="settings/integrity"]'); await page.waitForTimeout(500); await shot('11-quadratura');
assert.equal(await page.locator('.alert.high').count(), 0, 'nessun errore di quadratura atteso');

step('cifratura: nessun dato in chiaro in IndexedDB');
const dump = await page.evaluate(() => new Promise((res) => { const rq = indexedDB.open('fp-vault'); rq.onsuccess = () => { const db = rq.result; const out = {}; let n = 0; for (const s of ['meta', 'data']) { const r = db.transaction(s).objectStore(s); const all = r.getAll(), keys = r.getAllKeys(); all.onsuccess = () => { keys.onsuccess = () => { out[s] = Object.fromEntries(keys.result.map((k, i) => [k, all.result[i]])); if (++n === 2) res(JSON.stringify(out)); }; }; } }; }));
for (const needle of ['Conto principale', 'Gamma SpA', 'Affitto', 'transactions', 'Cena', PW]) assert.ok(!dump.includes(needle), `in chiaro: ${needle}`);
const ls = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
assert.equal(ls.replace(/[{}"]/g, ''), '', 'nessun dato in localStorage/sessionStorage/cookie');

step('backup cifrato, verifica e ripristino');
await page.click('button[data-nav="settings/backup"]').catch(async () => { await page.click('button[data-nav=settings]'); await page.click('button[data-nav="settings/backup"]'); });
await page.click('button[data-action=export-backup]'); await page.waitForSelector('.sheet');
await page.fill('input[name=pw]', 'password backup lunga'); await page.fill('input[name=pw2]', 'password backup lunga');
await page.click('.sheet button[type=submit]');
await page.waitForSelector('.sheet:has-text("Backup pronto e verificato")', { timeout: 30000 }); await shot('12-backup');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button[data-action=download-backup]')]);
const path = `${OUT}/backup.fpbak`; await dl.saveAs(path);
const bk = readFileSync(path, 'utf8');
assert.ok(!bk.includes('Gamma') && !bk.includes('transactions'), 'backup non cifrato!');
await page.click('.sheet button:has-text("Chiudi")');

step('blocco manuale e sblocco con password errata/corretta');
await page.click('.back'); await page.click('button[data-action=lock]').catch(async () => { await page.click('.back'); await page.click('button[data-action=lock]'); });
await page.waitForSelector('form[data-form=unlock]'); await shot('13-blocco');
assert.equal(await page.locator('.hero').count(), 0, 'dati ancora nel DOM dopo il blocco');
assert.ok(!(await page.content()).includes('Gamma SpA'), 'dati residui nel DOM dopo il blocco');
await page.fill('input[name=pw]', 'sbagliata sbagliata'); await page.click('button[type=submit]');
await page.waitForSelector('.form-error:not(:empty)');
await page.fill('input[name=pw]', PW); await page.click('button[type=submit]');
await page.waitForSelector('.screen', { timeout: 20000 }).catch(async (e) => { console.log('ERRORE UI:', (await page.textContent('body')).slice(0, 600), location_hash(await page.url()), errors); await shot('ERR'); throw e; });

step('persistenza dopo ricarica: l\'app riparte bloccata');
await page.reload(); await page.waitForSelector('form[data-form=unlock]');
await page.fill('input[name=pw]', PW); await page.click('button[type=submit]');
await page.waitForSelector('.screen', { timeout: 20000 });
assert.match(await page.textContent('.screen'), /Impostazioni/); // riparte dalla schermata in cui era

step('service worker attivo e app avviabile offline');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForTimeout(800);
await ctx.setOffline(true);
await page.reload(); await page.waitForSelector('form[data-form=unlock]', { timeout: 10000 });
await ctx.setOffline(false);

step('ripristino su archivio nuovo (altro contesto)');
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'it-IT' });
const p2 = await ctx2.newPage(); p2.on('pageerror', (e) => errors.push('pageerror2: ' + e.message));
await p2.goto(URL_); await p2.waitForSelector('form[data-form=setup]');
await p2.click('button[data-action=open-restore-setup]'); await p2.waitForSelector('.sheet');
await p2.setInputFiles('input[name=file]', path); await p2.fill('input[name=bpw]', 'password backup lunga');
await p2.fill('.sheet input[name=pw]', 'nuova password app 123'); await p2.fill('.sheet input[name=pw2]', 'nuova password app 123');
await p2.click('.sheet button[type=submit]');
await p2.waitForSelector('.hero', { timeout: 30000 }).catch(async (e) => { console.log('ERR RESTORE:', await p2.textContent('.sheet .form-error').catch(() => '(sheet chiuso)'), (await p2.textContent('body')).slice(0, 300)); throw e; });
assert.match(await p2.textContent('.hero'), /€/);
// password di backup errata
const ctx3 = await browser.newContext(); const p3 = await ctx3.newPage();
await p3.goto(URL_); await p3.waitForSelector('form[data-form=setup]'); await p3.click('button[data-action=open-restore-setup]');
await p3.setInputFiles('input[name=file]', path); await p3.fill('input[name=bpw]', 'password sbagliata!!'); await p3.fill('.sheet input[name=pw]', 'nuova password app 123'); await p3.fill('.sheet input[name=pw2]', 'nuova password app 123');
await p3.click('.sheet button[type=submit]'); await p3.waitForSelector('.sheet .form-error:not(:empty)');
assert.match(await p3.textContent('.sheet .form-error'), /errata|danneggiato/);

step('SCENARIO AUTONOMO: archivio vuoto → configurazione guidata → profilo forfettario');
const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true, locale: 'it-IT', hasTouch: true, isMobile: true });
const q = await ctx4.newPage();
await q.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
q.on('pageerror', (e) => errors.push('pageerror4: ' + e.message)); q.on('console', (m) => { if (m.type() === 'error') errors.push('console4: ' + m.text()); });
q.on('request', (r) => { if (!r.url().startsWith(URL_) && !r.url().startsWith('data:')) external.push(r.url()); });
const qshot = (n) => q.screenshot({ path: `${OUT}/${n}.png` });
await q.goto(URL_); await q.waitForSelector('form[data-form=setup]');
await q.fill('input[name=pw]', PW); await q.fill('input[name=pw2]', PW); await q.check('input[name=ack]'); await q.check('input[value=empty]', { force: true });
await q.click('button[type=submit]');
await q.waitForSelector('.sheet:has-text("Configurazione guidata")', { timeout: 20000 }); await q.waitForTimeout(400); await qshot('20-onboarding');
for (const [k, bal] of [['revolut', '250'], ['trade_republic', '1200'], ['isybank', '800'], ['bbva', '0'], ['buddybank', '15']]) { await q.check(`input[name=b_${k}]`, { force: true }); await q.fill(`input[name=s_${k}]`, bal); }
await q.click('.sheet button[type=submit]');
await q.waitForSelector('.sheet:has-text("Profilo lavoratore autonomo")', { timeout: 10000 });
await q.selectOption('.sheet select[name=account]', { label: 'Trade Republic' }); await q.fill('.sheet input[name=weekly]', '220');
await q.click('.sheet button[type=submit]'); await q.waitForSelector('.sheet', { state: 'detached' });
await q.waitForSelector('.acct'); await q.waitForTimeout(500); await qshot('21-mappa-soldi');
assert.equal(await q.locator('.acct').count(), 5);
assert.match(await q.textContent('.screen'), /Tasse e contributi/);

step('fattura ricorrente 27 del mese, incasso 12 giorni dopo');
await q.click('.tab[data-nav=income]'); await q.click('button[data-action=new-template]'); await q.waitForSelector('.sheet');
await q.fill('.sheet input[name=client]', 'Cliente Alfa'); await q.fill('.sheet input[name=amount]', '1200'); await q.selectOption('.sheet select[name=account]', { label: 'Isybank' });
await q.click('.sheet button[type=submit]'); await q.waitForSelector('.sheet', { state: 'detached' });
await q.waitForSelector('button[data-action=receive]'); await qshot('22-incassi');
assert.ok((await q.locator('button[data-action=receive]').count()) >= 2, 'incassi attesi generati');

step('incasso: "Incassata ✓" → tasse stimate e vero trasferimento verso Trade Republic');
await q.click('button[data-action=receive] >> nth=0'); await q.waitForSelector('.sheet');
await q.click('.sheet button[type=submit]');
await q.waitForSelector('.sheet:has-text("Come usi questo incasso")', { timeout: 8000 }); await q.waitForTimeout(300); await qshot('23-allocazione-tasse');
const allocText = await q.textContent('.sheet');
assert.match(allocText, /INPS 244,02/); assert.match(allocText, /poi da trasferire a Trade Republic/); assert.match(allocText, /virtuale/);
await q.click('.sheet button[type=submit]'); await q.waitForSelector('.sheet', { state: 'detached' });
await q.click('.tab[data-nav=moves]'); await q.waitForTimeout(300);
assert.doesNotMatch(await q.textContent('.screen'), /trasferimento per fondo/, 'nessun bonifico registrato da una semplice allocazione');
step('bonifico: registrato SOLO dopo la conferma esplicita');
await q.click('.tab[data-nav=overview]'); await q.waitForSelector('button[data-action=confirm-transfer]'); await qshot('27-bonifici-da-confermare');
await q.click('button[data-action=confirm-transfer]'); await q.waitForSelector('.sheet');
await q.click('.sheet button[type=submit]'); await q.waitForSelector('.sheet', { state: 'detached' });
assert.equal(await q.locator('button[data-action=confirm-transfer]').count(), 0);
await q.click('.tab[data-nav=moves]'); await q.waitForTimeout(300);
assert.match(await q.textContent('.screen'), /trasferimento per fondo/);

step('abbonamento ricorrente + PAC + calendario');
await q.click('.tab[data-nav=plan]'); await q.click('button[data-action=new-planned]'); await q.waitForSelector('.sheet');
await q.fill('.sheet input[name=name]', 'Abbonamento Claude'); await q.fill('.sheet input[name=amount]', '25');
await q.click('.sheet button[type=submit]'); await q.waitForSelector('.sheet', { state: 'detached' });
await q.click('button[data-action=new-planned]'); await q.waitForSelector('.sheet');
await q.fill('.sheet input[name=name]', 'PAC'); await q.selectOption('.sheet select[name=kind]', 'investment'); await q.fill('.sheet input[name=amount]', '100');
assert.equal(await q.inputValue('.sheet select[name=recurrence]'), 'monthly');
await q.click('.sheet button[type=submit]'); await q.waitForSelector('.sheet', { state: 'detached' }); await qshot('24-pianificazione');
assert.match(await q.textContent('.screen'), /PAC/);
await q.click('.tab[data-nav=overview]'); await q.click('button[data-nav=settings]'); await q.click('button[data-nav="settings/calendar"]');
await q.click('button[data-action=export-ics]'); await q.waitForSelector('.sheet');
const [icsDl] = await Promise.all([q.waitForEvent('download'), q.click('.sheet button[type=submit]')]);
await icsDl.saveAs(`${OUT}/scadenze.ics`);
const ics = readFileSync(`${OUT}/scadenze.ics`, 'utf8');
assert.match(ics, /BEGIN:VCALENDAR/); assert.match(ics, /RRULE:FREQ=MONTHLY/); assert.match(ics, /Abbonamento Claude/); assert.match(ics, /TRIGGER:/);

step('logo caricato dalla galleria');
await q.click('.sheet button:has-text("Annulla")').catch(() => {});
await q.goto(URL_ + '#/overview').catch(() => {}); await q.waitForTimeout(300);
if (await q.locator('form[data-form=unlock]').count()) { await q.fill('input[name=pw]', PW); await q.click('button[type=submit]'); await q.waitForSelector('.screen'); }
await q.click('button[data-action=edit-account] >> nth=0'); await q.waitForSelector('.sheet');
await q.setInputFiles('.sheet input[name=logoFile]', 'icons/icon-192.png'); await q.waitForSelector('.sheet .tile img', { timeout: 5000 });
await q.click('.sheet button[type=submit]'); await q.waitForSelector('.sheet', { state: 'detached' });
assert.ok(await q.locator('.acct .tile img').count() >= 1, 'logo mostrato');

step('analisi guadagni vs costi');
await q.click('button[data-nav=analysis]'); await q.waitForSelector('.kpi'); await q.waitForTimeout(400); await qshot('25-analisi');
await q.click('.tab[data-nav=overview]'); await q.waitForTimeout(300); await qshot('26-panoramica-autonomo');
await q.evaluate(() => { location.hash = '#/settings/tax'; }); await q.waitForSelector('text=Quattro numeri'); await q.waitForTimeout(300); await qshot('28-tasse-annuale');
await q.evaluate(() => { location.hash = '#/overview'; });
const csp4 = await q.evaluate(() => window.__csp); console.log('CSP (scenario autonomo):', csp4.length, csp4);
assert.equal(csp4.length, 0);

step('SICUREZZA: la password non resta nel DOM dopo lo sblocco; la cache contiene solo file dell\'app');
const sec = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'it-IT' });
const w = await sec.newPage(); w.on('pageerror', (e) => errors.push('pageerror5: ' + e.message));
await w.goto(URL_); await w.waitForSelector('form[data-form=setup]');
await w.fill('input[name=pw]', PW); await w.fill('input[name=pw2]', PW); await w.check('input[name=ack]');
await w.click('button[type=submit]'); await w.waitForSelector('.hero', { timeout: 20000 });
assert.equal(await w.locator('input[type=password]').count(), 0, 'campo password ancora nel DOM');
assert.ok(!(await w.content()).includes(PW), 'password presente nel DOM');
await w.evaluate(() => navigator.serviceWorker.ready); await w.waitForTimeout(600);
const cached = await w.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; });
assert.ok(cached.length > 30 && cached.every((p) => /^\/($|index\.html|manifest|sw\.js|src\/|icons\/)/.test(p)), 'la cache contiene altro che file dell\'app: ' + cached.filter((p) => !/^\/($|index\.html|manifest|sw\.js|src\/|icons\/)/.test(p)));

step('SICUREZZA: blocco in background');
await w.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
assert.equal(await w.locator('#cover.on').count(), 1, 'copertura schermo non attivata');
const realNow = Date.now.bind(Date);
await w.evaluate((t) => { const base = Date.now(); Date.now = () => base + t; Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }, 120000);
await w.waitForSelector('form[data-form=unlock]', { timeout: 5000 });
assert.equal(await w.locator('.hero').count(), 0); assert.ok(!(await w.content()).includes('Conto principale'), 'dati nel DOM dopo il blocco in background');
void realNow;

step('SICUREZZA: il browser cancella TUTTI i dati → l\'app riparte pulita e si recupera dal backup');
await w.evaluate(() => new Promise((res) => { const rq = indexedDB.deleteDatabase('fp-vault'); rq.onsuccess = rq.onerror = rq.onblocked = () => res(); }));
await w.reload(); await w.waitForSelector('form[data-form=setup]', { timeout: 10000 }); // nessun crash: schermata di benvenuto
await w.click('button[data-action=open-restore-setup]'); await w.waitForSelector('.sheet');
await w.setInputFiles('input[name=file]', path); await w.fill('.sheet input[name=bpw]', 'password backup lunga');
await w.fill('.sheet input[name=pw]', 'ripristino password 123'); await w.fill('.sheet input[name=pw2]', 'ripristino password 123');
await w.click('.sheet button[type=submit]'); await w.waitForSelector('.hero', { timeout: 30000 });
assert.match(await w.textContent('.hero'), /€/);

step('SICUREZZA: cancellazione PARZIALE (restano le chiavi ma spariscono i dati) → errore chiaro, nessun dato inventato, ripristino possibile');
await w.evaluate(() => new Promise((res) => { const rq = indexedDB.open('fp-vault'); rq.onsuccess = () => { const tx = rq.result.transaction('data', 'readwrite'); tx.objectStore('data').clear(); tx.oncomplete = () => res(); }; }));
await w.reload(); await w.waitForSelector('form[data-form=unlock]');
await w.fill('input[name=pw]', 'ripristino password 123'); await w.click('button[type=submit]');
await w.waitForSelector('.form-error:not(:empty)'); assert.match(await w.textContent('.form-error'), /danneggiat|backup/i);
assert.equal(await w.locator('.hero').count(), 0);
await w.click('button[data-action=open-restore-setup]'); await w.waitForSelector('.sheet');
await w.setInputFiles('input[name=file]', path); await w.fill('.sheet input[name=bpw]', 'password backup lunga');
await w.fill('.sheet input[name=pw]', 'terza password lunga 456'); await w.fill('.sheet input[name=pw2]', 'terza password lunga 456');
await w.click('.sheet button[type=submit]'); await w.waitForSelector('.hero', { timeout: 30000 });

step('SICUREZZA: cancellazione parziale inversa (spariscono le chiavi, restano i dati orfani) → nuovo archivio senza residui');
await w.evaluate(() => new Promise((res) => { const rq = indexedDB.open('fp-vault'); rq.onsuccess = () => { const tx = rq.result.transaction('meta', 'readwrite'); tx.objectStore('meta').clear(); tx.oncomplete = () => res(); }; }));
await w.reload(); await w.waitForSelector('form[data-form=setup]');
await w.fill('input[name=pw]', PW); await w.fill('input[name=pw2]', PW); await w.check('input[name=ack]'); await w.check('input[value=empty]', { force: true });
await w.click('button[type=submit]'); await w.waitForSelector('.sheet:has-text("Configurazione guidata"), .hero', { timeout: 20000 });
const keys = await w.evaluate(() => new Promise((res) => { const rq = indexedDB.open('fp-vault'); rq.onsuccess = () => { const r = rq.result.transaction('data').objectStore('data').getAllKeys(); r.onsuccess = () => res(r.result); }; }));
assert.deepEqual(keys, ['slot1'], 'residui di dati orfani dopo la ricreazione: ' + keys);

step('SICUREZZA: blocco per INATTIVITÀ (timer reale di 30 s)');
await w.click('.sheet button:has-text("Annulla")'); await w.waitForSelector('.sheet', { state: 'detached' });
await w.click('button[data-nav=settings]'); await w.click('button[data-nav="settings/security"]'); await w.click('button[data-action=edit-lock]'); await w.waitForSelector('.sheet');
await w.selectOption('.sheet select[name=idle]', '30'); await w.click('.sheet button[type=submit]'); await w.waitForSelector('.sheet', { state: 'detached' });
await w.waitForTimeout(32000);
await w.waitForSelector('form[data-form=unlock]', { timeout: 3000 });
assert.ok(!(await w.content()).includes('Impostazioni'), 'contenuto ancora nel DOM dopo il blocco per inattività');

step('PROFILO PERSONALE: primo accesso già configurato (file di profilo, dati di esempio)');
const ctx6 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'it-IT', hasTouch: true, isMobile: true });
const g = await ctx6.newPage();
await g.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
g.on('pageerror', (e) => errors.push('pageerror6: ' + e.message)); g.on('console', (m) => { if (m.type() === 'error') errors.push('console6: ' + m.text()); });
g.on('request', (r) => { if (!r.url().startsWith(URL_) && !r.url().startsWith('data:')) external.push(r.url()); });
const gshot = (n) => g.screenshot({ path: `${OUT}/${n}.png` });
await g.goto(URL_); await g.waitForSelector('form[data-form=setup]');
await g.fill('input[name=pw]', PW); await g.fill('input[name=pw2]', PW); await g.check('input[name=ack]');
await g.check('input[value=profile]', { force: true });
await g.setInputFiles('input[name=profileFile]', 'tests/fixtures/profilo-esempio.json');
await g.click('button[type=submit]'); await g.waitForSelector('.hero', { timeout: 20000 }); await g.waitForTimeout(500); await gshot('30-profilo-primo-accesso');
const ov = await g.textContent('.screen');
assert.match(ov, /Da aggiornare/); assert.match(ov, /Totale parziale: 4 conti da aggiornare/);
assert.match(ov, /Accredito dei compensi/); assert.doesNotMatch(ov, /Nessun problema di liquidità/, 'con saldi mancanti non si può dichiarare "nessun problema"');
assert.equal(await g.locator('button[data-action=set-balance]').count() >= 4, true);
step('profilo: nessun movimento, nessun fondo finanziato, saldi "da aggiornare" (non zero)');
await g.click('.tab[data-nav=moves]'); await g.waitForTimeout(300);
assert.match(await g.textContent('.screen'), /Nessun movimento|0 movimenti/);
await g.click('.tab[data-nav=funds]'); await g.waitForTimeout(400); await gshot('31-fondi-profilo');
const fz = await g.textContent('.screen');
assert.match(fz, /Non ancora finanziato/); assert.match(fz, /obiettivo da definire/); assert.match(fz, /provvisorio/);
assert.equal(await g.locator('.fund-child').count() >= 1, true, 'sotto-fondo sotto il padre');
assert.match(fz, /100,00–150,00|100,00.150,00/);
step('profilo: pagina "Stato dei dati" (configurato · previsto · da confermare)');
await g.click('.tab[data-nav=overview]'); await g.click('button[data-nav=settings]'); await g.click('button[data-nav="settings/status"]'); await g.waitForTimeout(400); await gshot('32-stato-dati');
const sd = await g.textContent('.screen');
assert.match(sd, /Dati configurati/); assert.match(sd, /Movimenti previsti/); assert.match(sd, /Movimenti effettivi da confermare/); assert.match(sd, /Saldo da aggiornare/);
step('imposta un saldo "da aggiornare"');
await g.click('.screen button[data-action=set-balance] >> nth=0'); await g.waitForSelector('.sheet');
await g.fill('.sheet input[name=amount]', '500'); await g.click('.sheet button[type=submit]'); await g.waitForSelector('.sheet', { state: 'detached' });
step('scadenze: voce "da confermare come attiva" → conferma esplicita');
await g.evaluate(() => { location.hash = '#/plan'; }); await g.waitForSelector('text=da confermare come attiva'); await gshot('33-pianificazione-profilo');
assert.match(await g.textContent('.screen'), /data da confermare/);
await g.click('button[data-action=confirm-planned]'); await g.waitForSelector('.sheet'); await g.click('.sheet button[type=submit]'); await g.waitForSelector('.sheet', { state: 'detached' });
assert.doesNotMatch(await g.textContent('.screen'), /da confermare come attiva/);
step('incasso PARZIALE: riserva proporzionale con traccia; poi importo definitivo con scelta');
await g.evaluate(() => { location.hash = '#/income'; });
await g.waitForSelector('button[data-action=receive]'); await gshot('34-incassi-profilo');
assert.match(await g.textContent('.screen'), /riserva fissa 300,00/i);
await g.click('button[data-action=receive] >> nth=0'); await g.waitForSelector('.sheet');
await g.fill('.sheet input[name=amount]', '300'); await g.click('.sheet button[type=submit]');
await g.waitForSelector('.sheet:has-text("Incasso parziale")', { timeout: 8000 }); await g.waitForTimeout(300); await gshot('35-parziale-riserva');
const pt = await g.textContent('.sheet');
assert.match(pt, /Incasso parziale/); assert.match(pt, /75,00/); assert.match(pt, /già accantonata 0,00/); assert.match(pt, /restano 225,00/);
await g.click('.sheet button[type=submit]'); await g.waitForSelector('.sheet', { state: 'detached' });
await g.waitForSelector('text=parziale'); const tr = await g.textContent('.screen');
assert.match(tr, /Incassati 300,00\s€ di 1\.200,00\s€/); assert.match(tr, /accantonata 75,00\s€/);
await g.click('button[data-action=receivable] >> nth=0'); await g.waitForSelector('.sheet');
await g.fill('.sheet input[name=amount]', '1300'); await g.dispatchEvent('.sheet input[name=amount]', 'change');
await g.waitForSelector('.sheet .amount-note.on'); await gshot('36-importo-cambiato');
await g.click('.sheet label:has(input[value=proportional]) span'); await g.click('.sheet button[type=submit]'); await g.waitForSelector('.sheet', { state: 'detached' });
step('fisco: quattro numeri separati e aliquote "da verificare"');
await g.evaluate(() => { location.hash = '#/settings/tax'; }); await g.waitForSelector('text=Quattro numeri'); await g.waitForTimeout(300); await gshot('37-tasse-quattro-numeri');
const tx4 = await g.textContent('.screen');
assert.match(tx4, /Stima fiscale/); assert.match(tx4, /Accantonamento personale/); assert.match(tx4, /Somme effettivamente trasferite/); assert.match(tx4, /Debiti fiscali effettivamente pagati/); assert.match(tx4, /da verificare per il/);
const cspP = await g.evaluate(() => window.__csp); assert.equal(cspP.length, 0);

const csp = await page.evaluate(() => window.__csp);
console.log('\nViolazioni CSP:', csp.length, csp);
console.log('Richieste verso l\'esterno:', external.length, external);
console.log('Errori console/pagina:', errors.length, errors);
await browser.close(); server.kill();
assert.equal(csp.length, 0); assert.equal(external.length, 0); assert.equal(errors.length, 0);
console.log('\nE2E OK — screenshot in', OUT);
