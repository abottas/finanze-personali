// Genera le icone PNG da icons/icon.svg usando il Chromium/Playwright locale. Uso: node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const svg = readFileSync(new URL('../icons/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
for (const [name, size] of [['apple-touch-icon', 180], ['icon-192', 192], ['icon-512', 512], ['icon-maskable-512', 512]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await page.screenshot({ path: new URL(`../icons/${name}.png`, import.meta.url).pathname });
  await page.close();
}
await browser.close();
console.log('icone generate');
