// Genera il file di ESEMPIO dell'esportazione per ChatGPT con dati interamente INVENTATI (profilo neutro di prova).
// Uso: node scripts/make-sample-export.mjs [percorso-uscita]
import { readFileSync, writeFileSync } from 'node:fs';
import * as C from '../src/core/commands.js';
import { createEmptyState, makeCtx } from '../src/core/state.js';
import { aiExportJson } from '../src/core/export-ai.js';

const TODAY = '2026-11-12';
let n = 0;
const ctx = (over = {}) => makeCtx({ nowIso: `${TODAY}T10:30:00.000Z`, today: TODAY, newId: () => `id${String(++n).padStart(4, '0')}`, ...over });
const profile = JSON.parse(readFileSync(new URL('../tests/fixtures/profilo-esempio.json', import.meta.url), 'utf8'));

const at = (d) => ctx({ today: d, nowIso: `${d}T09:00:00.000Z` });
let s = (await C.applyProfile(createEmptyState(at('2026-11-01')), at('2026-11-01'), profile)).state;   // i conti nascono il 1° novembre
const acc = Object.fromEntries(s.accounts.map((a) => [a.name, a.id]));
s = (await C.updateBalances(s, at('2026-11-01'), [
  { accountId: acc['Banca Accrediti'], balanceCents: 214500 }, { accountId: acc['Banca Spese'], balanceCents: 61000 },
  { accountId: acc['Broker Tasse'], balanceCents: 98000 }, { accountId: acc['Broker PAC'], balanceCents: 40000 }, { accountId: acc['Banca Risparmio'], balanceCents: 150000 },
])).state;
// Incassi: uno ricevuto, due attesi (stesso cliente), uno in ritardo
let r = await C.addReceivable(s, at('2026-11-01'), { client: 'Cliente Alfa', description: 'Fattura ottobre', expectedCents: 120000, expectedDate: '2026-11-05', accountId: acc['Banca Accrediti'], reserveCents: 30000 }); s = r.state;
s = (await C.receiveReceivable(s, at('2026-11-06'), { id: r.result, date: '2026-11-06', cents: 120000, accountId: acc['Banca Accrediti'] })).state;
s = (await C.addReceivable(s, ctx(), { client: 'Cliente Beta', description: 'Fattura novembre', expectedCents: 140000, expectedDate: '2026-11-27', accountId: acc['Banca Accrediti'], reserveCents: 35000 })).state;
s = (await C.addReceivable(s, ctx(), { client: 'Cliente Beta', description: 'Fattura dicembre', expectedCents: 140000, expectedDate: '2026-12-27', accountId: acc['Banca Accrediti'], reserveCents: 35000 })).state;
s = (await C.addReceivable(s, ctx(), { client: 'Cliente Gamma', description: 'Saldo progetto', expectedCents: 45000, expectedDate: '2026-11-02', accountId: acc['Banca Accrediti'] })).state;
// Qualche movimento effettivo
const tx = async (account, d, cents, kind, categoryId, note) => { s = (await C.addTransaction(s, at(d), { accountId: account, date: d, cents, kind, categoryId, note })).state; };
await tx(acc['Banca Spese'], '2026-11-09', -4200, 'expense', 'cat_food', 'Spesa settimanale');
await tx(acc['Banca Spese'], '2026-11-10', -2500, 'expense', 'cat_subs', 'Abbonamento software');
await tx(acc['Banca Spese'], '2026-11-11', -1800, 'expense', 'cat_eat', 'Cena');
// Budget finanziato con 2 settimane in anticipo
s = (await C.setBudgetAdvance(s, ctx(), { weeks: 2, sourceAccountId: acc['Banca Accrediti'] })).state;
s = (await C.runBudgetFunding(s, ctx(), { force: true })).state;
// Scadenze finanziate in anticipo
s = (await C.setPlannedFunding(s, ctx(), { enabled: true, horizonDays: 45, sourceAccountId: acc['Banca Risparmio'] })).state;
s = (await C.runPlannedFunding(s, ctx(), { force: true })).state;
// Dati fiscali iniziali (primo anno)
s = (await C.setTaxOpening(s, ctx(), { year: 2026, untilDate: '2026-10-31', ricaviCents: 1200000, inpsPaidCents: 0, impostaPaidCents: 0 })).state;

const out = process.argv[2] ?? new URL('../docs/esempio-esportazione-chatgpt.json', import.meta.url).pathname;
writeFileSync(out, aiExportJson(s, { today: TODAY, nowIso: `${TODAY}T10:30:00.000Z`, appVersion: '0.14.0' }) + '\n');
console.log('scritto', out);
