// Controlli statici sul codice sorgente: l'app non deve poter contattare servizi esterni né salvare segreti nel posto sbagliato.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git' || n === 'tests' || n === 'scripts' || n === 'docs') continue;
    const p = join(dir, n);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const files = walk(ROOT).filter((f) => /\.(js|html|css|webmanifest)$/.test(f));
const read = (f) => readFileSync(f, 'utf8');

test('nessun accesso di rete dal codice applicativo', () => {
  const banned = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /EventSource/, /navigator\.serviceWorker\.(?!register|addEventListener|ready|controller)/];
  for (const f of files.filter((x) => x.endsWith('.js') && !x.endsWith('sw.js'))) {
    for (const re of banned) assert.ok(!re.test(read(f)), `${f} usa ${re}`);
  }
});
test('nessuna dipendenza esterna: nessun URL http(s) in html/js/css (a parte i namespace XML)', () => {
  for (const f of files) {
    const urls = (read(f).match(/https?:\/\/[^\s"'`)<>]+/g) ?? []).filter((u) => !/^https?:\/\/www\.w3\.org\//.test(u));
    assert.deepEqual(urls, [], `${f} contiene URL esterni: ${urls}`);
  }
});
test('nessun localStorage/sessionStorage/cookie/eval/Function dinamica', () => {
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const re of [/localStorage/, /sessionStorage/, /document\.cookie/, /\beval\s*\(/, /new\s+Function\s*\(/, /\.write\s*\(/]) assert.ok(!re.test(src), `${f} usa ${re}`);
  }
});
test('nessun handler inline né stile inline negli HTML (CSP rigorosa)', () => {
  const html = read(join(ROOT, 'index.html'));
  assert.ok(!/\son[a-z]+\s*=/i.test(html)); assert.ok(!/\sstyle\s*=/i.test(html));
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), 'script inline');
});
test('nessun attributo style inline nei template JS (bloccato dalla CSP)', () => {
  for (const f of files.filter((x) => x.includes('/src/app/') && x.endsWith('.js'))) {
    const src = read(f);
    assert.ok(!/\sstyle\s*=\s*["'\\]/.test(src) && !/setAttribute\(\s*['"]style/.test(src), `${f} usa style inline`);
  }
});
test('CSP: connect-src none, niente unsafe-inline/unsafe-eval', () => {
  const html = read(join(ROOT, 'index.html'));
  const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  assert.match(csp, /connect-src 'none'/); assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.match(csp, /img-src 'self' data:;/); // data: solo per i loghi PNG, validati dallo schema
  if (existsSync(join(ROOT, '_headers'))) assert.match(read(join(ROOT, '_headers')), /connect-src 'none'/);
});
test('ogni assegnazione a innerHTML usa html`` (escaping automatico), una stringa vuota o un valore già sicuro', () => {
  for (const f of files.filter((x) => x.includes('/src/app/') && x.endsWith('.js'))) {
    const src = read(f);
    for (const m of src.matchAll(/innerHTML\s*=\s*([^\n;]{0,40})/g)) {
      assert.match(m[1], /^(html`|''|body\.s\b)/, `${f}: innerHTML con valore non filtrato: ${m[1]}`);
    }
    assert.ok(!/insertAdjacentHTML|outerHTML\s*=/.test(src), `${f}: API HTML non filtrata`);
  }
});
test('nessun attributo style inline nei template JS (bloccato dalla CSP)', () => {
  for (const f of files.filter((x) => x.includes('/src/app/') && x.endsWith('.js'))) {
    const src = read(f);
    assert.ok(!/\sstyle\s*=\s*["'\\]/.test(src) && !/setAttribute\(\s*['"]style/.test(src), `${f} usa style inline`);
  }
});
test('CSP: connect-src none, niente unsafe-inline/unsafe-eval', () => {
  const html = read(join(ROOT, 'index.html'));
  const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  assert.match(csp, /connect-src 'none'/); assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.match(csp, /img-src 'self' data:;/); // data: solo per i loghi PNG, validati dallo schema
  if (existsSync(join(ROOT, '_headers'))) assert.match(read(join(ROOT, '_headers')), /connect-src 'none'/);
});
test('service worker: la cache offline copre esattamente i file necessari all\'app', async () => {
  const { checkServiceWorker } = await import('../scripts/check-sw.mjs');
  assert.deepEqual(checkServiceWorker().problems, []);
});
