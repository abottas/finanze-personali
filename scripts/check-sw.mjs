// Verifica che ogni file necessario all'app sia nella cache offline del service worker (e viceversa).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
export function checkServiceWorker() {
  const problems = [];
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const listed = new Set([...sw.matchAll(/^\s*'([^']+)',?\s*$/gm)].map((m) => m[1]).filter((x) => x !== './'));
  const needed = new Set(['index.html', 'manifest.webmanifest', 'sw.js']);
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) if (!/^(https?:|data:)/.test(m[1])) needed.add(m[1]);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const i of manifest.icons) needed.add(i.src);
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return; seen.add(file); needed.add(file);
    const abs = join(ROOT, file);
    if (!existsSync(abs)) { problems.push(`file mancante: ${file}`); return; }
    if (!file.endsWith('.js')) return;
    const src = readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) walk(relative(ROOT, join(dirname(abs), m[1])));
  };
  for (const f of [...needed]) if (f.endsWith('.js')) walk(f);
  for (const f of needed) { if (!listed.has(f)) problems.push(`non in cache offline: ${f}`); if (!existsSync(join(ROOT, f))) problems.push(`file mancante: ${f}`); }
  for (const f of listed) if (!needed.has(f)) problems.push(`in cache ma non usato: ${f}`);
  return { problems, listed: [...listed], needed: [...needed] };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { problems, listed } = checkServiceWorker();
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`OK: ${listed.length} file nella cache offline, tutti coerenti.`);
}
