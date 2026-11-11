// Controlli di quadratura (riesecuzione indipendente dei conti). Ritorna elenco di verifiche
// con severità: 'error' = incoerenza contabile, 'warn' = situazione da rivedere, 'ok' = verificato.
import { validateState } from './validate.js';
import { snapshot, balanceOf } from './derive.js';
import { verifyAuditChain } from './audit.js';
import { formatEuro } from './money.js';

export async function runIntegrityChecks(state, { today = null } = {}) {
  const items = [];
  const add = (id, label, severity, detail = '') => items.push({ id, label, severity, detail });

  const problems = validateState(state);
  add('struttura', 'Struttura dati e riferimenti', problems.length ? 'error' : 'ok', problems.slice(0, 5).join(' · '));
  if (problems.length) return finish(items); // inutile proseguire su dati strutturalmente invalidi

  const snap = snapshot(state);
  const posted = (a) => a.filter((x) => x.status === 'posted');

  // 1. Conservazione: i trasferimenti non creano né distruggono denaro.
  const opening = state.accounts.reduce((s, a) => s + a.openingCents, 0);
  const flows = posted(state.transactions).reduce((s, t) => s + t.cents, 0);
  // Netto dei trasferimenti sommato conto per conto: deve dare esattamente zero.
  const trNet = state.accounts.reduce((s, a) => s
    + posted(state.transfers).filter((t) => t.toAccountId === a.id).reduce((x, t) => x + t.cents, 0)
    - posted(state.transfers).filter((t) => t.fromAccountId === a.id).reduce((x, t) => x + t.cents, 0), 0);
  add('trasferimenti_neutri', 'I trasferimenti tra conti hanno effetto netto zero', trNet === 0 ? 'ok' : 'error', trNet === 0 ? '' : `Netto: ${formatEuro(trNet)}`);
  const expected = opening + flows + trNet;
  add('conservazione', 'Saldo totale = saldi iniziali + entrate − uscite (i trasferimenti si annullano)', snap.total === expected ? 'ok' : 'error',
    snap.total === expected ? '' : `Differenza: ${formatEuro(snap.total - expected)}`);

  // 2. Ricalcolo indipendente dei saldi (percorso diverso: balanceOf per conto).
  const mismatched = state.accounts.filter((a) => balanceOf(state, a.id) !== snap.balances[a.id]);
  add('saldi_ricalcolo', 'Saldi dei conti ricalcolati dai movimenti', mismatched.length ? 'error' : 'ok', mismatched.map((a) => a.name).join(', '));

  // 3. Fondi: nessun disponibile negativo; vincoli ≤ saldo per ogni conto (stesso importo mai in due posti).
  const negFunds = state.funds.filter((f) => snap.funds[f.id].available < 0);
  add('fondi_non_negativi', 'Nessun fondo con disponibile negativo', negFunds.length ? 'error' : 'ok', negFunds.map((f) => f.name).join(', '));
  const over = state.accounts.filter((a) => snap.freeByAccount[a.id] < 0);
  add('vincoli_entro_saldo', 'Somme vincolate entro il saldo di ciascun conto', over.length ? 'warn' : 'ok',
    over.map((a) => `${a.name}: libero ${formatEuro(snap.freeByAccount[a.id])}`).join(' · '));

  // 4. Spostamenti tra fondi bilanciati.
  const byMove = {};
  for (const al of state.allocations) if (al.moveId) byMove[al.moveId] = (byMove[al.moveId] ?? 0) + al.cents;
  const unbalanced = Object.entries(byMove).filter(([, v]) => v !== 0);
  add('spostamenti_fondi', 'Spostamenti tra fondi a somma zero', unbalanced.length ? 'error' : 'ok');

  // 5. Incassi ↔ movimenti: ogni movimento di incasso appartiene a un solo incasso, e lo stato è coerente
  //    con quanto realmente incassato (anche per gli incassi PARZIALI).
  const bad5 = [];
  for (const r of state.receivables) {
    const got = posted(state.transactions).filter((t) => t.receivableId === r.id).reduce((x, t) => x + t.cents, 0);
    if ((r.status === 'partial' || r.status === 'received') && got !== r.receivedCents) bad5.push(r.client);
    if (r.status === 'partial' && got >= r.expectedCents) bad5.push(r.client);
    if (r.status === 'expected' && got !== 0) bad5.push(r.client);
  }
  const orphan = posted(state.transactions).filter((t) => t.receivableId && !state.receivables.some((r) => r.id === t.receivableId && (r.status === 'partial' || r.status === 'received')));
  add('incassi_collegati', 'Incassi (anche parziali) coerenti con i movimenti incassati', bad5.length || orphan.length ? 'error' : 'ok', bad5.join(', '));

  // 6. Quadrature con la banca (ultima per conto).
  for (const a of state.accounts) {
    const recs = state.reconciliations.filter((r) => r.accountId === a.id).sort((x, y) => (x.date + x.createdAt < y.date + y.createdAt ? 1 : -1));
    const last = recs[0];
    if (!last) continue;
    const diff = last.bankCents - balanceOf(state, a.id, last.date);
    add(`quadratura_${a.id}`, `Quadratura con la banca — ${a.name} (${last.date})`, diff === 0 ? 'ok' : 'warn', diff === 0 ? '' : `Differenza ${formatEuro(diff, { plus: true })}: verifica i movimenti o registra una rettifica`);
  }

  // 7. Storico a catena di hash.
  const chain = await verifyAuditChain(state.audit);
  add('storico_hash', 'Integrità dello storico modifiche (catena di hash)', chain.ok ? 'ok' : 'error', chain.ok ? `${state.audit.length} voci` : `Catena interrotta alla voce ${chain.brokenAt + 1}`);

  // 8. Importi tutti interi (già garantito da validateState; esposto come controllo esplicito).
  add('centesimi_interi', 'Tutti gli importi sono centesimi interi', 'ok');
  void today;
  return finish(items);
}
function finish(items) {
  return { ok: !items.some((i) => i.severity === 'error'), errors: items.filter((i) => i.severity === 'error').length, warnings: items.filter((i) => i.severity === 'warn').length, items };
}
