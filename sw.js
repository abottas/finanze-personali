// Service worker: solo cache dell'app shell (codice statico). NESSUN dato finanziario transita da qui.
// Strategia: cache-first versionata. Un nuovo SW resta "in attesa" e subentra quando l'app viene chiusa:
// non cambia mai il codice sotto i piedi mentre l'archivio è sbloccato.
const VERSION = 'fp-v0.12.1';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'src/styles/app.css',
  'src/app/main.js',
  'src/app/actions.js',
  'src/app/views.js',
  'src/app/ui.js',
  'src/app/html.js',
  'src/app/icons.js',
  'src/app/charts.js',
  'src/core/errors.js',
  'src/core/money.js',
  'src/core/dates.js',
  'src/core/canonical.js',
  'src/core/audit.js',
  'src/core/state.js',
  'src/core/validate.js',
  'src/core/derive.js',
  'src/core/commands.js',
  'src/core/budget.js',
  'src/core/allocation.js',
  'src/core/forecast.js',
  'src/core/integrity.js',
  'src/core/demo.js',
  'src/core/palette.js',
  'src/core/tax.js',
  'src/core/analytics.js',
  'src/core/reports.js',
  'src/core/csv.js',
  'src/core/ics.js',
  'src/core/profile.js',
  'src/crypto/b64.js',
  'src/crypto/hash.js',
  'src/crypto/vault.js',
  'src/crypto/backup.js',
  'src/storage/adapters.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // mai toccare altro traffico
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
    return fetch(req); // non si salva in cache nulla di imprevisto
  })());
});
