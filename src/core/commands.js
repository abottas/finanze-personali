// Unico punto di mutazione dello stato. Ogni comando:
//   1. lavora su una COPIA dello stato (l'originale non viene mai toccato);
//   2. verifica le regole contabili e gli invarianti duri (validateState);
//   3. aggiunge voci allo storico a catena di hash;
//   4. restituisce { state, result }. Se qualcosa fallisce, lancia AppError e nulla cambia.
import { AppError, req } from './errors.js';
import { assertCents, formatEuro, isCents, mulRatio } from './money.js';
import { suggestedSetAside } from './tax.js';
import { isDate, addMonths, addDays, diffDays } from './dates.js';
import { COLOR_KEYS, BANKS } from './palette.js';
import { snapshot, balanceOf } from './derive.js';
import { validateState } from './validate.js';
import { appendAudit } from './audit.js';
import { validateProfile } from './profile.js';

async function mutate(state, ctx, fn) {
  const next = structuredClone(state);
  const logs = [];
  // Le voci dello storico contengono COPIE congelate: mai riferimenti a oggetti dello stato,
  // altrimenti una modifica successiva altererebbe retroattivamente la storia (e la catena di hash).
  const log = (action, entity, entityId, before, after, note = '') =>
    logs.push({ action, entity, entityId, before: before == null ? null : structuredClone(before), after: after == null ? null : structuredClone(after), note });
  const result = await fn(next, log);
  const problems = validateState(next);
  if (problems.length) throw new AppError('stato_non_valido', `Operazione rifiutata: ${problems[0]}`);
  for (const l of logs) await appendAudit(next, l, ctx);
  return { state: next, result };
}

const find = (arr, id, what) => {
  const x = arr.find((e) => e.id === id);
  if (!x) throw new AppError('non_trovato', `${what} non trovato`);
  return x;
};
const clean = (s, max = 80) => String(s ?? '').trim().slice(0, max);
const cleanNote = (s) => clean(s, 500);
const needName = (s) => { const n = clean(s); req(n.length >= 1, 'nome_mancante', 'Inserisci un nome'); return n; };
const needReason = (s) => { const r = clean(s, 300); req(r.length >= 3, 'motivo_mancante', 'Indica il motivo (almeno 3 caratteri)'); return r; };
const copy = (o) => structuredClone(o);

// ───────────────────────────── Conti ─────────────────────────────
const look = (o) => ({ color: o.color && COLOR_KEYS.includes(o.color) ? o.color : null, emoji: o.emoji ? String(o.emoji).slice(0, 12) : null });
export function addAccount(state, ctx, { name, type = 'checking', openingCents = 0, openingDate = ctx.today, bank = null, color = null, emoji = null, logo = null, role = null, balanceUnknown = false, origin = null }) {
  return mutate(state, ctx, (s, log) => {
    const a = { id: ctx.newId(), name: needName(name), type, openingCents: assertCents(openingCents, 'Saldo iniziale'), openingDate, archived: false, createdAt: ctx.nowIso, bank: bank && BANKS[bank] ? bank : null, ...look({ color, emoji }), logo: logo || null, role: role ? clean(role, 80) : null, balanceUnknown: !!balanceUnknown, origin };
    req(isDate(openingDate), 'data_non_valida', 'Data non valida');
    s.accounts.push(a);
    log('create', 'account', a.id, null, a);
    return a.id;
  });
}
export function updateAccount(state, ctx, id, { name, type, bank, color, emoji, logo, role }) {
  return mutate(state, ctx, (s, log) => {
    const a = find(s.accounts, id, 'Conto');
    const before = copy(a);
    if (name !== undefined) a.name = needName(name);
    if (type !== undefined) a.type = type;
    if (bank !== undefined) a.bank = bank && BANKS[bank] ? bank : null;
    if (color !== undefined) a.color = color && COLOR_KEYS.includes(color) ? color : null;
    if (emoji !== undefined) a.emoji = emoji ? String(emoji).slice(0, 12) : null;
    if (logo !== undefined) a.logo = logo || null;
    if (role !== undefined) a.role = role ? clean(role, 80) : null;
    log('update', 'account', id, before, copy(a));
  });
}
export function archiveAccount(state, ctx, id) {
  return mutate(state, ctx, (s, log) => {
    const a = find(s.accounts, id, 'Conto');
    const snap = snapshot(s);
    req(snap.balances[id] === 0, 'saldo_non_zero', 'Si può archiviare solo un conto con saldo zero');
    req(!s.funds.some((f) => f.accountId === id && !f.archived), 'fondi_attivi', 'Il conto ha fondi attivi');
    const before = copy(a);
    a.archived = true;
    log('archive', 'account', id, before, copy(a));
  });
}

// ─────────────────────────── Movimenti ───────────────────────────
function checkTxFields(s, ctx, t, snapExcludingId = null) {
  const acc = find(s.accounts, t.accountId, 'Conto');
  req(!acc.archived, 'conto_archiviato', 'Il conto è archiviato');
  req(isDate(t.date), 'data_non_valida', 'Data non valida');
  req(t.date <= ctx.today, 'data_futura', 'I movimenti effettivi non possono avere data futura (usa Incassi o Pianificazione per il futuro)');
  req(t.date >= acc.openingDate, 'data_prima_apertura', 'La data precede il saldo iniziale del conto');
  assertCents(t.cents);
  req(t.cents !== 0, 'importo_zero', 'L\'importo non può essere zero');
  if (t.kind === 'income') req(t.cents > 0, 'segno', 'Un\'entrata deve essere positiva');
  if (t.kind === 'expense' || t.kind === 'investment') req(t.cents < 0, 'segno', 'Un\'uscita deve essere negativa');
  if (t.categoryId != null) find(s.categories, t.categoryId, 'Categoria');
  if (t.fundId != null) {
    const f = find(s.funds, t.fundId, 'Fondo');
    req(t.kind === 'expense', 'fondo_solo_uscite', 'Solo le uscite possono attingere a un fondo');
    const snap = snapExcludingId ?? snapshot(s);
    const avail = snap.funds[f.id].byAccount[t.accountId] ?? 0;   // la spesa esce da QUESTO conto: serve riserva qui
    req(-t.cents <= avail, 'fondo_insufficiente', `Il fondo "${f.name}" ha solo ${formatEuro(avail)} riservati su ${acc.name}`);
  }
}

export function addTransaction(state, ctx, { accountId, date = ctx.today, cents, kind, categoryId = null, fundId = null, note = '', receivableId = null, plannedId = null }) {
  return mutate(state, ctx, (s, log) => {
    req(['income', 'expense', 'investment', 'adjustment'].includes(kind), 'tipo', 'Tipo di movimento non valido');
    const t = { id: ctx.newId(), accountId, date, cents, kind, categoryId, fundId, receivableId, plannedId, note: cleanNote(note), status: 'posted', voidReason: null, createdAt: ctx.nowIso, updatedAt: ctx.nowIso };
    checkTxFields(s, ctx, t);
    s.transactions.push(t);
    log('create', 'transaction', t.id, null, t);
    return t.id;
  });
}

export function updateTransaction(state, ctx, id, patch) {
  return mutate(state, ctx, (s, log) => {
    const t = find(s.transactions, id, 'Movimento');
    req(t.status === 'posted', 'annullato', 'Il movimento è annullato e non modificabile');
    const before = copy(t);
    const allowed = ['accountId', 'date', 'cents', 'categoryId', 'fundId', 'note'];
    for (const k of Object.keys(patch)) {
      req(allowed.includes(k), 'campo_non_modificabile', `Campo non modificabile: ${k}`);
    }
    // Per verificare la disponibilità del fondo escludiamo il movimento stesso.
    t.status = 'void';
    const snapWithout = snapshot(s);
    t.status = 'posted';
    Object.assign(t, patch);
    if (patch.note !== undefined) t.note = cleanNote(patch.note);
    t.updatedAt = ctx.nowIso;
    checkTxFields(s, ctx, t, snapWithout);
    if (t.receivableId) {
      const r = find(s.receivables, t.receivableId, 'Incasso');
      r.receivedCents = t.cents; r.receivedDate = t.date; r.accountId = t.accountId;
    }
    log('update', 'transaction', id, before, copy(t));
  });
}

/** Le correzioni non cancellano: il movimento resta nello storico come "annullato" con motivo. */
export function voidTransaction(state, ctx, id, reason) {
  return mutate(state, ctx, (s, log) => {
    const t = find(s.transactions, id, 'Movimento');
    req(t.status === 'posted', 'annullato', 'Movimento già annullato');
    const before = copy(t);
    t.status = 'void';
    t.voidReason = needReason(reason);
    t.updatedAt = ctx.nowIso;
    log('void', 'transaction', id, before, copy(t), t.voidReason);
    if (t.receivableId) {
      const r = s.receivables.find((x) => x.id === t.receivableId);
      if (r && (r.status === 'received' || r.status === 'partial')) {
        const rb = copy(r);
        const rest = s.transactions.filter((x) => x.receivableId === r.id && x.status === 'posted' && x.id !== t.id);
        const got = rest.reduce((a, x) => a + x.cents, 0);
        if (!rest.length) { r.status = 'expected'; r.receivedTxId = null; r.receivedCents = null; r.receivedDate = null; }
        else { r.status = got >= r.expectedCents ? 'received' : 'partial'; r.receivedCents = got; r.receivedTxId = rest.at(-1).id; r.receivedDate = rest.at(-1).date; }
        log('reopen', 'receivable', r.id, rb, copy(r), 'Movimento di incasso annullato');
      }
    }
    if (t.plannedId) {
      const p = s.planned.find((x) => x.id === t.plannedId);
      if (p && p.status === 'done') {
        const pb = copy(p);
        p.status = 'planned';
        const f = p.fundId && s.funds.find((x) => x.id === p.fundId);
        if (f && f.archived && f.plannedId === p.id) f.archived = false;
        log('reopen', 'planned', p.id, pb, copy(p), 'Movimento di acquisto annullato');
      }
    }
  });
}

// ───────────────────────── Trasferimenti ─────────────────────────
// Un trasferimento NON è un'entrata né un'uscita: vive in una collezione separata e sposta solo denaro tra conti.
export function addTransfer(state, ctx, { fromAccountId, toAccountId, cents, date = ctx.today, note = '', purpose = null }) {
  return mutate(state, ctx, (s, log) => {
    const a = find(s.accounts, fromAccountId, 'Conto di origine');
    const b = find(s.accounts, toAccountId, 'Conto di destinazione');
    req(a.id !== b.id, 'stesso_conto', 'Origine e destinazione devono essere diverse');
    req(!a.archived && !b.archived, 'conto_archiviato', 'Un conto è archiviato');
    assertCents(cents);
    req(cents > 0, 'importo', 'L\'importo deve essere positivo');
    req(isDate(date) && date <= ctx.today, 'data_non_valida', 'Data non valida o futura');
    req(date >= a.openingDate && date >= b.openingDate, 'data_prima_apertura', 'La data precede il saldo iniziale di un conto');
    const t = { id: ctx.newId(), fromAccountId, toAccountId, cents, date, note: cleanNote(note), purpose: ['fund', 'saving'].includes(purpose) ? purpose : null, fundId: null, status: 'posted', voidReason: null, createdAt: ctx.nowIso };
    s.transfers.push(t);
    log('create', 'transfer', t.id, null, t);
    return t.id;
  });
}
export function voidTransfer(state, ctx, id, reason) {
  return mutate(state, ctx, (s, log) => {
    const t = find(s.transfers, id, 'Trasferimento');
    req(t.status === 'posted', 'annullato', 'Trasferimento già annullato');
    const before = copy(t);
    t.status = 'void';
    t.voidReason = needReason(reason);
    log('void', 'transfer', id, before, copy(t), t.voidReason);
  });
}

// ───────────────────── Fondi virtuali e allocazioni ─────────────────────
// Le allocazioni NON muovono denaro in banca: sono vincoli contabili interni a un conto.
const DEF_FUND_LOOK = { tax: ['amber', '🧾'], goal: ['indigo', '⭐'], planned: ['purple', '🛍️'], reserve: ['gray', '💰'] };
export function addFund(state, ctx, { name, kind = 'reserve', accountId, goal = null, color = null, icon = null, parentId = null, provisional = false, origin = null }) {
  return mutate(state, ctx, (s, log) => {
    req(['goal', 'tax', 'reserve'].includes(kind), 'tipo_fondo', 'Tipo di fondo non valido');
    const acc = find(s.accounts, accountId, 'Conto');
    req(!acc.archived, 'conto_archiviato', 'Il conto è archiviato');
    const f = { id: ctx.newId(), name: needName(name), kind, accountId, goal: kind === 'goal' ? (goal ? { minCents: null, ...goal } : null) : null, plannedId: null, archived: false, createdAt: ctx.nowIso, parentId, provisional: !!provisional, origin, color: color && COLOR_KEYS.includes(color) ? color : DEF_FUND_LOOK[kind][0], icon: icon ? String(icon).slice(0, 12) : DEF_FUND_LOOK[kind][1] };
    s.funds.push(f);
    log('create', 'fund', f.id, null, f);
    return f.id;
  });
}
export function updateFund(state, ctx, id, { name, goal, color, icon }) {
  return mutate(state, ctx, (s, log) => {
    const f = find(s.funds, id, 'Fondo');
    const before = copy(f);
    if (name !== undefined) f.name = needName(name);
    if (color !== undefined && COLOR_KEYS.includes(color)) f.color = color;
    if (icon !== undefined && icon) f.icon = String(icon).slice(0, 12);
    if (goal !== undefined) { req(f.kind === 'goal', 'non_obiettivo', 'Solo gli obiettivi hanno un importo target'); f.goal = goal; }
    log('update', 'fund', id, before, copy(f));
  });
}

function pushAllocation(s, ctx, fundId, cents, kind, note, moveId = null, accountId = null, receivableId = null) {
  const f = s.funds.find((x) => x.id === fundId);
  const al = { id: ctx.newId(), fundId, accountId: accountId ?? f.accountId, cents, date: ctx.today, kind, moveId, note: cleanNote(note), createdAt: ctx.nowIso, receivableId };
  s.allocations.push(al);
  return al;
}
const reserveAt = (s, fundId, accountId) => snapshot(s).funds[fundId].byAccount[accountId] ?? 0;
/** Rilascia al denaro libero tutta la riserva del fondo, conto per conto. */
function releaseAll(s, ctx, f, log, note) {
  const by = snapshot(s).funds[f.id].byAccount;
  for (const [acc, c] of Object.entries(by)) {
    if (c <= 0) continue;
    const al = pushAllocation(s, ctx, f.id, -c, 'release', note, null, acc);
    log('release', 'allocation', al.id, null, al, `Rilasciati ${formatEuro(c)} da "${f.name}" (${note})`);
  }
}
const accName = (s, id) => s.accounts.find((a) => a.id === id)?.name ?? '—';

/**
 * Assegna denaro LIBERO di un conto a un fondo. È un vincolo VIRTUALE: non muove nulla in banca.
 * `accountId` = conto che contiene il denaro (di default il conto di riferimento del fondo).
 */
export function assignToFund(state, ctx, fundId, cents, note = '', accountId = null) {
  return mutate(state, ctx, (s, log) => {
    const f = find(s.funds, fundId, 'Fondo');
    req(!f.archived, 'fondo_archiviato', 'Il fondo è archiviato');
    const acc = find(s.accounts, accountId ?? f.accountId, 'Conto');
    assertCents(cents);
    req(cents > 0, 'importo', 'L\'importo deve essere positivo');
    const free = snapshot(s).freeByAccount[acc.id];
    req(cents <= free, 'libero_insufficiente', `Denaro libero insufficiente su ${acc.name}: disponibili ${formatEuro(free)}`);
    const al = pushAllocation(s, ctx, fundId, cents, 'assign', note, null, acc.id);
    log('allocate', 'allocation', al.id, null, al, `Assegnati ${formatEuro(cents)} a "${f.name}" su ${acc.name} (movimento virtuale, nessun bonifico)`);
  });
}
export function releaseFromFund(state, ctx, fundId, cents, note = '', accountId = null) {
  return mutate(state, ctx, (s, log) => {
    const f = find(s.funds, fundId, 'Fondo');
    assertCents(cents);
    req(cents > 0, 'importo', 'L\'importo deve essere positivo');
    const by = snapshot(s).funds[fundId].byAccount;
    // Senza conto indicato: preferisce il conto di riferimento, poi quello con più riserva.
    const acc = accountId ?? ((by[f.accountId] ?? 0) >= cents ? f.accountId : Object.entries(by).sort((x, y) => y[1] - x[1])[0]?.[0]);
    const avail = acc ? (by[acc] ?? 0) : 0;
    req(cents <= avail, 'disponibile_insufficiente', `Su quel conto il fondo ha riservato solo ${formatEuro(avail)}`);
    const al = pushAllocation(s, ctx, fundId, -cents, 'release', note, null, acc);
    log('release', 'allocation', al.id, null, al, `Rilasciati ${formatEuro(cents)} da "${f.name}" al denaro libero di ${accName(s, acc)}`);
  });
}
/** Sposta riserva da un fondo a un altro SULLO STESSO CONTO (virtuale). */
export function moveBetweenFunds(state, ctx, fromFundId, toFundId, cents, note = '', accountId = null) {
  return mutate(state, ctx, (s, log) => {
    const a = find(s.funds, fromFundId, 'Fondo di origine');
    const b = find(s.funds, toFundId, 'Fondo di destinazione');
    req(a.id !== b.id, 'stesso_fondo', 'Scegli due fondi diversi');
    req(!b.archived, 'fondo_archiviato', 'Il fondo di destinazione è archiviato');
    assertCents(cents);
    req(cents > 0, 'importo', 'L\'importo deve essere positivo');
    const by = snapshot(s).funds[a.id].byAccount;
    const acc = accountId ?? ((by[a.accountId] ?? 0) >= cents ? a.accountId : Object.entries(by).sort((x, y) => y[1] - x[1])[0]?.[0]);
    const avail = acc ? (by[acc] ?? 0) : 0;
    req(cents <= avail, 'disponibile_insufficiente', `Nel fondo di origine, su quel conto, sono riservati solo ${formatEuro(avail)}`);
    const moveId = ctx.newId();
    const o = pushAllocation(s, ctx, a.id, -cents, 'move', note, moveId, acc);
    const i = pushAllocation(s, ctx, b.id, cents, 'move', note, moveId, acc);
    log('move', 'allocation', moveId, o, i, `Spostati ${formatEuro(cents)} da "${a.name}" a "${b.name}" su ${accName(s, acc)}`);
  });
}
/**
 * Applica in blocco (atomico) un piano di allocazione: o tutto o niente.
 * Ogni voce è {fundId, cents, accountId}: assegna denaro libero di `accountId` al fondo.
 * NON crea mai trasferimenti bancari: se il fondo "abita" su un altro conto, il bonifico resta da confermare.
 */
export function applyAllocationPlan(state, ctx, items, note = 'Allocazione suggerita') {
  return mutate(state, ctx, (s, log) => {
    req(Array.isArray(items), 'piano', 'Piano non valido');
    for (const it of items) {
      if (!it.cents) continue;
      const f = find(s.funds, it.fundId, 'Fondo');
      req(!f.archived, 'fondo_archiviato', `Il fondo "${f.name}" è archiviato`);
      assertCents(it.cents);
      req(it.cents > 0, 'importo', 'Importo non valido nel piano');
      const acc = find(s.accounts, it.accountId ?? it.fromAccountId ?? f.accountId, 'Conto');
      const free = snapshot(s).freeByAccount[acc.id];
      req(it.cents <= free, 'libero_insufficiente', `Denaro libero insufficiente su ${acc.name} per "${f.name}": disponibili ${formatEuro(free)}`);
      if (it.receivableId) find(s.receivables, it.receivableId, 'Incasso');
      const al = pushAllocation(s, ctx, f.id, it.cents, 'assign', note, null, acc.id, it.receivableId ?? null);
      log('allocate', 'allocation', al.id, null, al, `Assegnati ${formatEuro(it.cents)} a "${f.name}" su ${acc.name} (virtuale${acc.id !== f.accountId ? `: bonifico verso ${accName(s, f.accountId)} da confermare` : ''})`);
    }
  });
}
/**
 * L'utente CONFERMA di aver eseguito il bonifico in banca: solo ora nasce il trasferimento reale
 * (collezione `transfers`, scopo "fondo") e la riserva segue il denaro sul conto di destinazione.
 */
export function confirmFundTransfer(state, ctx, { fundId, fromAccountId, toAccountId, cents, date = ctx.today }) {
  return mutate(state, ctx, (s, log) => {
    const f = find(s.funds, fundId, 'Fondo');
    const from = find(s.accounts, fromAccountId, 'Conto di origine');
    const to = find(s.accounts, toAccountId, 'Conto di destinazione');
    req(from.id !== to.id, 'stesso_conto', 'Origine e destinazione devono essere diverse');
    assertCents(cents);
    req(cents > 0, 'importo', 'L\'importo deve essere positivo');
    req(isDate(date) && date <= ctx.today, 'data_non_valida', 'Data non valida o futura');
    req(date >= from.openingDate && date >= to.openingDate, 'data_prima_apertura', 'La data precede il saldo iniziale di un conto');
    const reserved = reserveAt(s, f.id, from.id);
    req(cents <= reserved, 'riserva_insufficiente', `Su ${from.name} il fondo "${f.name}" ha riservato solo ${formatEuro(reserved)}`);
    const tr = { id: ctx.newId(), fromAccountId: from.id, toAccountId: to.id, cents, date, note: `Bonifico per "${f.name}"`, purpose: 'fund', fundId: f.id, status: 'posted', voidReason: null, createdAt: ctx.nowIso };
    s.transfers.push(tr);
    log('create', 'transfer', tr.id, null, tr, `Bonifico CONFERMATO dall'utente: ${from.name} → ${to.name}`);
    const moveId = ctx.newId();
    const o = pushAllocation(s, ctx, f.id, -cents, 'move', `Bonifico verso ${to.name}`, moveId, from.id);
    const i = pushAllocation(s, ctx, f.id, cents, 'move', `Bonifico da ${from.name}`, moveId, to.id);
    log('move', 'allocation', moveId, o, i, `La riserva di "${f.name}" segue il denaro su ${to.name}`);
    return tr.id;
  });
}
export function closeFund(state, ctx, id) {
  return mutate(state, ctx, (s, log) => {
    const f = find(s.funds, id, 'Fondo');
    const p = f.plannedId && s.planned.find((x) => x.id === f.plannedId);
    req(!(p && p.status === 'planned'), 'fondo_collegato', 'Il fondo è collegato a un acquisto programmato attivo');
    req(!s.settings.taxRules.some((r) => r.fundId === id), 'fondo_in_regola', 'Il fondo è usato da una regola fiscale');
    req(s.settings.taxProfile.fundId !== id, 'fondo_in_regola', 'Il fondo è usato dal profilo fiscale');
    releaseAll(s, ctx, f, log, 'chiusura fondo');
    const before = copy(f);
    f.archived = true;
    log('archive', 'fund', id, before, copy(f));
  });
}
/** Cambia il conto di riferimento del fondo e, con un bonifico confermato, sposta tutta la riserva esistente. */
export function relocateFund(state, ctx, id, newAccountId) {
  return mutate(state, ctx, (s, log) => {
    const f = find(s.funds, id, 'Fondo');
    const to = find(s.accounts, newAccountId, 'Conto di destinazione');
    req(f.accountId !== to.id && !to.archived, 'conto', 'Scegli un conto diverso e attivo');
    for (const [acc, c] of Object.entries(snapshot(s).funds[id].byAccount)) {
      if (acc === to.id || c <= 0) continue;
      const from = find(s.accounts, acc, 'Conto di origine');
      req(ctx.today >= to.openingDate && ctx.today >= from.openingDate, 'data_prima_apertura', 'Un conto non era ancora aperto');
      const tr = { id: ctx.newId(), fromAccountId: acc, toAccountId: to.id, cents: c, date: ctx.today, note: `Spostamento fondo "${f.name}"`, purpose: 'fund', fundId: f.id, status: 'posted', voidReason: null, createdAt: ctx.nowIso };
      s.transfers.push(tr);
      log('create', 'transfer', tr.id, null, tr, 'Bonifico confermato dall\'utente collegato allo spostamento del fondo');
      const moveId = ctx.newId();
      pushAllocation(s, ctx, f.id, -c, 'move', 'Spostamento fondo', moveId, acc);
      pushAllocation(s, ctx, f.id, c, 'move', 'Spostamento fondo', moveId, to.id);
    }
    const before = copy(f);
    f.accountId = to.id;
    log('relocate', 'fund', id, before, copy(f));
  });
}

// ───────────────────────── Incassi professionali ─────────────────────────
export function addReceivable(state, ctx, { client, description = '', expectedCents, expectedDate, accountId, reserveCents = null }) {
  return mutate(state, ctx, (s, log) => {
    find(s.accounts, accountId, 'Conto');
    assertCents(expectedCents);
    req(expectedCents > 0, 'importo', 'L\'importo atteso deve essere positivo');
    req(isDate(expectedDate), 'data_non_valida', 'Data non valida');
    const r = { id: ctx.newId(), client: needName(client), description: clean(description, 200), expectedCents, expectedDate, accountId, status: 'expected', receivedTxId: null, receivedCents: null, receivedDate: null, cancelReason: null, createdAt: ctx.nowIso, templateKey: null, invoiceDate: null, reserveCents: reserveCents ?? null };
    s.receivables.push(r);
    log('create', 'receivable', r.id, null, r);
    return r.id;
  });
}
/**
 * Modifica di un incasso atteso/parziale. Se cambia l'IMPORTO DEFINITIVO della fattura e c'è una riserva fissa,
 * `reserveMode` decide: 'keep' (mantiene la riserva fissa, predefinito) · 'proportional' (stessa percentuale sul nuovo
 * importo) · 'theoretical' (stima del profilo fiscale). Cambia SOLO questa fattura: la regola futura del cliente
 * (fattura ricorrente) non viene mai modificata da qui.
 */
export function updateReceivable(state, ctx, id, patch) {
  return mutate(state, ctx, (s, log) => {
    const r = find(s.receivables, id, 'Incasso');
    req(r.status === 'expected' || r.status === 'partial', 'non_modificabile', 'Si possono modificare solo gli incassi ancora attesi o parziali');
    const before = copy(r);
    const oldExpected = r.expectedCents;
    if (patch.client !== undefined) r.client = needName(patch.client);
    if (patch.description !== undefined) r.description = clean(patch.description, 200);
    if (patch.expectedDate !== undefined) r.expectedDate = patch.expectedDate;
    if (patch.accountId !== undefined && r.status === 'expected') r.accountId = patch.accountId;
    if (patch.expectedCents !== undefined && patch.expectedCents !== oldExpected) {
      assertCents(patch.expectedCents);
      req(patch.expectedCents > 0, 'importo', 'L\'importo deve essere positivo');
      if (r.status === 'partial') req(patch.expectedCents > (r.receivedCents ?? 0), 'sotto_incassato', 'Il nuovo importo non supera quanto già incassato: usa "Chiudi con quanto incassato"');
      r.expectedCents = patch.expectedCents;
      if (patch.reserveCents === undefined && r.reserveCents != null) {
        const mode = patch.reserveMode ?? 'keep';
        req(['keep', 'proportional', 'theoretical'].includes(mode), 'modo', 'Scelta non valida per la riserva');
        if (mode === 'proportional') r.reserveCents = mulRatio(r.reserveCents, patch.expectedCents, oldExpected);
        else if (mode === 'theoretical') {
          const tp = s.settings.taxProfile;
          r.reserveCents = tp.enabled ? suggestedSetAside(patch.expectedCents, tp).setAside : mulRatio(r.reserveCents, patch.expectedCents, oldExpected);
        }
        r.reserveCents = Math.min(r.reserveCents, r.expectedCents);
      }
    }
    if (patch.reserveCents !== undefined) r.reserveCents = patch.reserveCents;
    log('update', 'receivable', id, before, copy(r), r.expectedCents !== oldExpected ? `Importo definitivo cambiato da ${formatEuro(oldExpected)} a ${formatEuro(r.expectedCents)}; riserva ${r.reserveCents == null ? 'non impostata' : formatEuro(r.reserveCents)} (${patch.reserveMode ?? 'keep'})` : '');
  });
}
export function cancelReceivable(state, ctx, id, reason) {
  return mutate(state, ctx, (s, log) => {
    const r = find(s.receivables, id, 'Incasso');
    req(r.status === 'expected', 'non_modificabile', 'Solo un incasso senza pagamenti può essere annullato (se è parziale usa "Chiudi con quanto incassato")');
    const before = copy(r);
    r.status = 'cancelled';
    r.cancelReason = needReason(reason);
    log('cancel', 'receivable', id, before, copy(r), r.cancelReason);
  });
}
/**
 * Registra un incasso (anche PARZIALE) con l'importo EFFETTIVO. Resta "parziale" finché il totale incassato
 * non raggiunge il previsto o finché non lo chiudi (`close`: saldo definitivo anche se inferiore).
 */
export function receiveReceivable(state, ctx, { id, date = ctx.today, cents, accountId, close = false }) {
  return mutate(state, ctx, (s, log) => {
    const r = find(s.receivables, id, 'Incasso');
    req(r.status === 'expected' || r.status === 'partial', 'non_atteso', 'L\'incasso è già chiuso o annullato');
    const accId = accountId ?? r.accountId;
    const prior = r.receivedCents ?? 0;
    const t = { id: ctx.newId(), accountId: accId, date, cents, kind: 'income', categoryId: 'cat_pro', fundId: null, receivableId: r.id, plannedId: null, note: cleanNote(`${r.client}${r.description ? ' — ' + r.description : ''}`), status: 'posted', voidReason: null, createdAt: ctx.nowIso, updatedAt: ctx.nowIso };
    checkTxFields(s, ctx, t);
    s.transactions.push(t);
    const before = copy(r);
    const total = prior + cents;
    r.status = close || total >= r.expectedCents ? 'received' : 'partial';
    r.receivedTxId = t.id; r.receivedCents = total; r.receivedDate = date;
    log('create', 'transaction', t.id, null, t, r.status === 'partial' ? 'Incasso professionale PARZIALE' : 'Incasso professionale ricevuto');
    const diff = total - r.expectedCents;
    log('receive', 'receivable', id, before, copy(r), r.status === 'partial' ? `Incassati ${formatEuro(total)} di ${formatEuro(r.expectedCents)}: restano ${formatEuro(r.expectedCents - total)}` : diff === 0 ? 'Importo come previsto' : `Importo definitivo diverso dal previsto: ${formatEuro(diff, { plus: true })}`);
    return t.id;
  });
}
/** Chiude una fattura parziale con quanto effettivamente incassato (importo definitivo inferiore). */
export function closeReceivable(state, ctx, id, note = '') {
  return mutate(state, ctx, (s, log) => {
    const r = find(s.receivables, id, 'Incasso');
    req(r.status === 'partial', 'non_parziale', 'Solo un incasso parziale può essere chiuso così');
    const before = copy(r);
    r.status = 'received';
    log('close', 'receivable', id, before, copy(r), `Chiusa con ${formatEuro(r.receivedCents)} su ${formatEuro(r.expectedCents)} previsti${note ? ': ' + clean(note, 200) : ''}`);
  });
}

// ───────────────────── Acquisti programmati / spese straordinarie ─────────────────────
export function addPlanned(state, ctx, { name, kind = 'purchase', cents, dueDate, priority = 2, accountId, fundMode = 'new', fundId = null, recurrence = 'none', categoryId = 'cat_other', autoPay = false, remindDays = 2, confirm = null, origin = null }) {
  return mutate(state, ctx, (s, log) => {
    find(s.accounts, accountId, 'Conto');
    assertCents(cents);
    req(cents > 0, 'importo', 'L\'importo deve essere positivo');
    req(isDate(dueDate), 'data_non_valida', 'Data non valida');
    const p = { id: ctx.newId(), name: needName(name), kind, cents, dueDate, anchorDay: Number(dueDate.slice(8)), priority, accountId, fundId: null, recurrence, status: 'planned', createdAt: ctx.nowIso, categoryId, autoPay: !!autoPay, remindDays, confirm, origin };
    if (fundMode === 'new') {
      const f = { id: ctx.newId(), name: `Per: ${p.name}`.slice(0, 80), kind: 'planned', accountId, goal: null, plannedId: p.id, archived: false, createdAt: ctx.nowIso, color: 'purple', icon: '🛍️', parentId: null, provisional: false, origin: null };
      s.funds.push(f);
      p.fundId = f.id;
      log('create', 'fund', f.id, null, f, 'Fondo creato automaticamente per l\'acquisto programmato');
    } else if (fundMode === 'existing') {
      const f = find(s.funds, fundId, 'Fondo');
      req(f.accountId === accountId, 'fondo_altro_conto', 'Il fondo appartiene a un altro conto');
      p.fundId = f.id;
    }
    s.planned.push(p);
    log('create', 'planned', p.id, null, p);
    return p.id;
  });
}
export function updatePlanned(state, ctx, id, patch) {
  return mutate(state, ctx, (s, log) => {
    const p = find(s.planned, id, 'Acquisto');
    req(p.status === 'planned', 'non_modificabile', 'Acquisto non più attivo');
    const before = copy(p);
    if (patch.name !== undefined) p.name = needName(patch.name);
    if (patch.cents !== undefined) p.cents = assertCents(patch.cents);
    if (patch.dueDate !== undefined) { p.dueDate = patch.dueDate; p.anchorDay = Number(patch.dueDate.slice(8)); if (p.confirm === 'date') p.confirm = null; }
    if (patch.priority !== undefined) p.priority = patch.priority;
    if (patch.categoryId !== undefined) p.categoryId = patch.categoryId;
    if (patch.autoPay !== undefined) p.autoPay = !!patch.autoPay;
    if (patch.remindDays !== undefined) p.remindDays = patch.remindDays;
    if (patch.recurrence !== undefined) p.recurrence = patch.recurrence;
    log('update', 'planned', id, before, copy(p));
  });
}
export function cancelPlanned(state, ctx, id, reason) {
  return mutate(state, ctx, (s, log) => {
    const p = find(s.planned, id, 'Acquisto');
    req(p.status === 'planned', 'non_modificabile', 'Acquisto non più attivo');
    const before = copy(p);
    p.status = 'cancelled';
    log('cancel', 'planned', id, before, copy(p), needReason(reason));
    const f = p.fundId && s.funds.find((x) => x.id === p.fundId);
    if (f && f.plannedId === p.id && !f.archived) {
      releaseAll(s, ctx, f, log, 'acquisto annullato');
      const fb = copy(f);
      f.archived = true;
      log('archive', 'fund', f.id, fb, copy(f));
    }
  });
}
const MONTHS_STEP = { monthly: 1, quarterly: 3, yearly: 12 };
export function completePlanned(state, ctx, { id, date = ctx.today, cents, accountId, categoryId = null, useFund = true }) {
  return mutate(state, ctx, (s, log) => {
    const p = find(s.planned, id, 'Acquisto');
    req(p.status === 'planned', 'non_modificabile', 'Acquisto non più attivo');
    const amount = cents ?? p.cents;
    assertCents(amount);
    req(amount > 0, 'importo', 'Importo non valido');
    const isInvest = p.kind === 'investment';          // un PAC è un investimento, non una spesa di consumo
    const f = !isInvest && useFund && p.fundId ? s.funds.find((x) => x.id === p.fundId) : null;
    const t = { id: ctx.newId(), accountId: accountId ?? p.accountId, date, cents: -amount, kind: isInvest ? 'investment' : 'expense', categoryId: categoryId ?? p.categoryId ?? (isInvest ? 'cat_invest' : 'cat_other'), fundId: f ? f.id : null, receivableId: null, plannedId: p.id, note: cleanNote(p.name), status: 'posted', voidReason: null, createdAt: ctx.nowIso, updatedAt: ctx.nowIso };
    checkTxFields(s, ctx, t);
    s.transactions.push(t);
    log('create', 'transaction', t.id, null, t, `Acquisto programmato eseguito: ${p.name}`);
    const before = copy(p);
    if (p.recurrence === 'none') {
      p.status = 'done';
      if (f && f.plannedId === p.id) {
        releaseAll(s, ctx, f, log, 'acquisto concluso: residuo rilasciato');
        const fb = copy(f);
        f.archived = true;
        log('archive', 'fund', f.id, fb, copy(f));
      }
    } else {
      p.dueDate = p.recurrence === 'weekly' ? addDays(p.dueDate, 7) : addMonths(p.dueDate, MONTHS_STEP[p.recurrence], p.anchorDay);
    }
    log('complete', 'planned', id, before, copy(p));
    return t.id;
  });
}

// ───────────────────────── Impostazioni ─────────────────────────
export function updateSettings(state, ctx, patch) {
  return mutate(state, ctx, (s, log) => {
    const before = copy(s.settings);
    for (const [k, v] of Object.entries(patch)) {
      req(k in s.settings && k !== 'budget' && k !== 'taxRules', 'impostazione', `Impostazione sconosciuta: ${k}`);
      s.settings[k] = v;
    }
    log('update', 'settings', 'settings', before, copy(s.settings));
  });
}
export function updateBudget(state, ctx, { weeklyCents, startDate, carryOver, carryDeficit }) {
  return mutate(state, ctx, (s, log) => {
    const before = copy(s.settings.budget);
    const b = s.settings.budget;
    if (weeklyCents !== undefined) b.weeklyCents = assertCents(weeklyCents);
    if (startDate !== undefined) b.startDate = startDate;
    if (carryOver !== undefined) b.carryOver = !!carryOver;
    if (carryDeficit !== undefined) b.carryDeficit = !!carryDeficit;
    log('update', 'budget', 'budget', before, copy(b));
  });
}
export function setTaxRules(state, ctx, rules) {
  return mutate(state, ctx, (s, log) => {
    const before = copy(s.settings.taxRules);
    s.settings.taxRules = rules.map((r) => {
      const f = find(s.funds, r.fundId, 'Fondo fiscale');
      req(!f.archived, 'fondo_archiviato', 'Il fondo fiscale è archiviato');
      req(Number.isInteger(r.bp) && r.bp >= 0 && r.bp <= 10000, 'aliquota', 'Aliquota non valida');
      return { id: r.id ?? ctx.newId(), name: needName(r.name), bp: r.bp, fundId: r.fundId };
    });
    log('update', 'tax_rules', 'tax_rules', before, copy(s.settings.taxRules));
  });
}
export function addCategory(state, ctx, { name, kind = 'expense', inBudget = true, icon = '🏷️', color = 'gray', parentId = null }) {
  return mutate(state, ctx, (s, log) => {
    req(['expense', 'income'].includes(kind), 'tipo', 'Tipo non valido');
    const c = { id: ctx.newId(), name: needName(name), kind, inBudget: !!inBudget, icon: String(icon || '🏷️').slice(0, 12), color: COLOR_KEYS.includes(color) ? color : 'gray', parentId };
    s.categories.push(c);
    log('create', 'category', c.id, null, c);
    return c.id;
  });
}
export function updateCategory(state, ctx, id, { name, inBudget, icon, color }) {
  return mutate(state, ctx, (s, log) => {
    const c = find(s.categories, id, 'Categoria');
    req(c.kind !== 'adjustment', 'categoria', 'Categoria di sistema non modificabile');
    const before = copy(c);
    if (name !== undefined) c.name = needName(name);
    if (inBudget !== undefined) c.inBudget = !!inBudget;
    if (icon) c.icon = String(icon).slice(0, 12);
    if (color && COLOR_KEYS.includes(color)) c.color = color;
    log('update', 'category', id, before, copy(c));
  });
}

// ───────────────────────── Profilo fiscale (autonomo forfettario) ─────────────────────────
export function setTaxProfile(state, ctx, patch) {
  return mutate(state, ctx, (s, log) => {
    const before = copy(s.settings.taxProfile);
    const tp = s.settings.taxProfile;
    for (const k of ['enabled', 'coefficientBp', 'inpsBp', 'taxBp', 'roundStepCents', 'fundId']) if (patch[k] !== undefined) tp[k] = patch[k];
    if (tp.enabled) { const f = find(s.funds, tp.fundId, 'Fondo per le tasse'); req(!f.archived, 'fondo_archiviato', 'Il fondo per le tasse è archiviato'); }
    log('update', 'tax_profile', 'tax_profile', before, copy(tp), tp.enabled ? 'Profilo fiscale attivo' : 'Profilo fiscale disattivato');
  });
}
/** Configurazione guidata: fondo tasse sul conto scelto + profilo fiscale attivo + budget settimanale. */
export function setupFreelanceProfile(state, ctx, { taxAccountId, weeklyBudgetCents = 0 }) {
  return mutate(state, ctx, (s, log) => {
    find(s.accounts, taxAccountId, 'Conto');
    const f = { id: ctx.newId(), name: 'Tasse e contributi', kind: 'tax', accountId: taxAccountId, goal: null, plannedId: null, archived: false, createdAt: ctx.nowIso, color: 'amber', icon: '🧾', parentId: null, provisional: false, origin: null };
    s.funds.push(f);
    log('create', 'fund', f.id, null, f);
    const before = copy(s.settings.taxProfile);
    s.settings.taxProfile = { ...s.settings.taxProfile, enabled: true, fundId: f.id };
    log('update', 'tax_profile', 'tax_profile', before, copy(s.settings.taxProfile), 'Profilo forfettario / Gestione Separata attivato');
    if (weeklyBudgetCents > 0) {
      const bb = copy(s.settings.budget);
      s.settings.budget.weeklyCents = assertCents(weeklyBudgetCents);
      s.settings.budget.startDate = ctx.today;
      log('update', 'budget', 'budget', bb, copy(s.settings.budget));
    }
    return f.id;
  });
}

// ───────────────────────── Fatture ricorrenti ─────────────────────────
export function addInvoiceTemplate(state, ctx, { client, cents, invoiceDay = 27, collectDays = 12, accountId, reserveCents = null, review = false, note = '', origin = null }) {
  return mutate(state, ctx, (s, log) => {
    find(s.accounts, accountId, 'Conto');
    assertCents(cents); req(cents > 0, 'importo', 'Importo non valido');
    req(Number.isInteger(invoiceDay) && invoiceDay >= 1 && invoiceDay <= 28, 'giorno', 'Il giorno di fatturazione deve essere tra 1 e 28');
    req(Number.isInteger(collectDays) && collectDays >= 0 && collectDays <= 180, 'giorni', 'Giorni di incasso non validi');
    const t = { id: ctx.newId(), client: needName(client), cents, invoiceDay, collectDays, accountId, reserveCents: reserveCents ?? null, active: true, createdAt: ctx.nowIso, review: !!review, note: clean(note, 300), origin };
    s.invoiceTemplates.push(t);
    log('create', 'invoice_template', t.id, null, t);
    materialize(s, ctx, log);
    return t.id;
  });
}
export function updateInvoiceTemplate(state, ctx, id, patch) {
  return mutate(state, ctx, (s, log) => {
    const t = find(s.invoiceTemplates, id, 'Fattura ricorrente');
    const before = copy(t);
    for (const k of ['client', 'cents', 'invoiceDay', 'collectDays', 'accountId', 'active', 'reserveCents', 'review']) if (patch[k] !== undefined) t[k] = k === 'client' ? needName(patch[k]) : patch[k];
    log('update', 'invoice_template', id, before, copy(t));
    // Le future fatture ATTESE non ancora incassate adottano i nuovi valori.
    for (const r of s.receivables) {
      if (r.templateKey?.startsWith(id + ':') && r.status === 'expected') {
        const rb = copy(r); r.expectedCents = t.cents; r.accountId = t.accountId; r.client = t.client; r.reserveCents = t.reserveCents;
        log('update', 'receivable', r.id, rb, copy(r), 'Aggiornato dalla fattura ricorrente');
      }
    }
    if (t.active) materialize(s, ctx, log);
  });
}
function materialize(s, ctx, log) {
  const made = [];
  for (const t of s.invoiceTemplates) {
    if (t.active === false) continue;
    for (let i = -1; i <= 2; i++) {
      const monthStart = addMonths(ctx.today.slice(0, 7) + '-01', i);
      const ym = monthStart.slice(0, 7);
      const key = `${t.id}:${ym}`;
      if (s.receivables.some((r) => r.templateKey === key)) continue;
      const day = Math.min(t.invoiceDay, new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5), 0)).getUTCDate());
      const invoiceDate = `${ym}-${String(day).padStart(2, '0')}`;
      const expectedDate = addDays(invoiceDate, t.collectDays);
      if (expectedDate < addDays(ctx.today, -20)) continue;      // niente storico retroattivo
      if (t.createdAt.slice(0, 7) > ym) continue;
      const r = { id: ctx.newId(), client: t.client, description: `Fattura del ${invoiceDate.slice(8)}/${ym.slice(5)}`, expectedCents: t.cents, expectedDate, accountId: t.accountId, status: 'expected', receivedTxId: null, receivedCents: null, receivedDate: null, cancelReason: null, createdAt: ctx.nowIso, templateKey: key, invoiceDate, reserveCents: t.reserveCents ?? null };
      s.receivables.push(r);
      log('create', 'receivable', r.id, null, r, 'Generato dalla fattura ricorrente');
      made.push(r.id);
    }
  }
  return made;
}
/** Idempotente: crea gli incassi attesi dei prossimi mesi per ogni fattura ricorrente. Da chiamare all'avvio. */
export function materializeInvoices(state, ctx) {
  return mutate(state, ctx, (s, log) => materialize(s, ctx, log).length);
}


// ───────────────────────── Voci da confermare, saldi da aggiornare ─────────────────────────
/** Conferma (o scarta) una voce configurata ma "da confermare come attiva". */
export function confirmPlanned(state, ctx, id, active) {
  return mutate(state, ctx, (s, log) => {
    const p = find(s.planned, id, 'Scadenza');
    req(p.confirm === 'active', 'nessuna_conferma', 'La voce non è in attesa di conferma');
    const before = copy(p);
    if (active) { p.confirm = null; log('confirm', 'planned', id, before, copy(p), 'Confermata come attiva'); }
    else { p.status = 'cancelled'; log('cancel', 'planned', id, before, copy(p), 'Non attiva'); }
  });
}
/**
 * Imposta il saldo di un conto il cui saldo era "da aggiornare". Calibra il saldo iniziale in modo che il saldo
 * di oggi coincida con quello dichiarato, senza toccare i movimenti già registrati.
 */
export function setAccountBalance(state, ctx, accountId, targetCents) {
  return mutate(state, ctx, (s, log) => {
    const a = find(s.accounts, accountId, 'Conto');
    req(a.balanceUnknown, 'saldo_noto', 'Il saldo di questo conto è già noto: usa la quadratura con la banca per eventuali differenze');
    assertCents(targetCents);
    const before = copy(a);
    const movements = balanceOf(s, a.id, ctx.today) - a.openingCents;
    a.openingCents = targetCents - movements;
    assertCents(a.openingCents, 'Saldo iniziale');
    a.balanceUnknown = false;
    log('set_balance', 'account', a.id, before, copy(a), `Saldo dichiarato dall'utente: ${formatEuro(targetCents)}`);
  });
}
export function verifyTaxRates(state, ctx, year) {
  return mutate(state, ctx, (s, log) => {
    req(Number.isInteger(year), 'anno', 'Anno non valido');
    const before = copy(s.settings.taxProfile);
    s.settings.taxProfile.verifiedYear = year;
    log('update', 'tax_profile', 'tax_profile', before, copy(s.settings.taxProfile), `Aliquote verificate dall'utente per il ${year}`);
  });
}

// ───────────────────────── Profilo personale iniziale ─────────────────────────
/**
 * Costruisce in UN'unica operazione atomica la configurazione iniziale descritta da un file di profilo.
 * Non registra movimenti, non finanzia fondi, non inventa saldi (i conti restano "da aggiornare").
 * Si applica solo a un archivio senza conti: dopo, tutto si modifica dall'app senza perdere lo storico.
 */
export function applyProfile(state, ctx, profile) {
  return mutate(state, ctx, (s, log) => {
    const problems = validateProfile(profile);
    req(problems.length === 0, 'profilo_non_valido', 'Profilo non valido: ' + problems[0]);
    req(s.accounts.length === 0 && s.funds.length === 0, 'archivio_non_vuoto', 'Il profilo si applica solo a un archivio senza conti');
    const accId = {}, fundId = {};
    for (const a of profile.accounts) {
      const preset = BANKS[a.bank];
      const acc = { id: ctx.newId(), name: needName(a.name), type: a.type ?? preset?.type ?? 'checking', openingCents: a.openingCents ?? 0, openingDate: ctx.today, archived: false, createdAt: ctx.nowIso, bank: a.bank ?? null, color: a.color ?? null, emoji: a.emoji ?? null, logo: null, role: a.role ? clean(a.role, 80) : null, balanceUnknown: a.openingCents == null, origin: 'profile' };
      s.accounts.push(acc); accId[a.key] = acc.id;
      log('create', 'account', acc.id, null, acc, 'Dal profilo personale' + (acc.balanceUnknown ? ' · saldo da aggiornare' : ''));
    }
    // I fondi madre prima dei figli
    const order = [...profile.funds ?? []].sort((x, y) => (x.parentKey ? 1 : 0) - (y.parentKey ? 1 : 0));
    for (const f of order) {
      const look = { tax: ['amber', '🧾'], goal: ['indigo', '⭐'], reserve: ['gray', '💰'] }[f.kind];
      const g = f.kind === 'goal' ? { targetCents: f.goal?.targetCents ?? null, minCents: f.goal?.minCents ?? null, priority: f.goal?.priority ?? 2, deadline: f.goal?.deadline ?? null } : null;
      const fund = { id: ctx.newId(), name: needName(f.name), kind: f.kind, accountId: accId[f.accountKey], goal: g, plannedId: null, archived: false, createdAt: ctx.nowIso, color: f.color && COLOR_KEYS.includes(f.color) ? f.color : look[0], icon: f.icon ? String(f.icon).slice(0, 12) : look[1], parentId: f.parentKey ? fundId[f.parentKey] : null, provisional: !!f.provisional, origin: 'profile' };
      s.funds.push(fund); fundId[f.key] = fund.id;
      log('create', 'fund', fund.id, null, fund, 'Dal profilo personale · non finanziato');
    }
    if (profile.taxProfile) {
      const before = copy(s.settings.taxProfile);
      const t = profile.taxProfile;
      s.settings.taxProfile = { ...s.settings.taxProfile, enabled: true, coefficientBp: t.coefficientBp, inpsBp: t.inpsBp, taxBp: t.taxBp, roundStepCents: t.roundStepCents ?? 1000, fundId: fundId[t.fundKey], verifiedYear: null };
      log('update', 'tax_profile', 'tax_profile', before, copy(s.settings.taxProfile), 'Dal profilo personale · aliquote da verificare');
    }
    if (profile.budget?.weeklyCents > 0) {
      const bb = copy(s.settings.budget);
      s.settings.budget = { ...s.settings.budget, weeklyCents: profile.budget.weeklyCents, startDate: ctx.today };
      log('update', 'budget', 'budget', bb, copy(s.settings.budget));
    }
    for (const t of profile.invoiceTemplates ?? []) {
      const tpl = { id: ctx.newId(), client: needName(t.client), cents: t.cents, invoiceDay: t.invoiceDay, collectDays: t.collectDays, accountId: accId[t.accountKey], reserveCents: t.reserveCents ?? null, active: true, createdAt: ctx.nowIso, review: !!t.review, note: clean(t.note, 300), origin: 'profile' };
      s.invoiceTemplates.push(tpl);
      log('create', 'invoice_template', tpl.id, null, tpl, 'Dal profilo personale · configurazione di pianificazione, non una fattura emessa');
    }
    materialize(s, ctx, log);
    for (const x of profile.planned ?? []) {
      // Senza giorno noto la data NON si inventa: si usa un segnaposto e la voce resta "da confermare".
      const day = x.dueDay ?? 1;
      const base = x.dueDay ? (ctx.today.slice(8) <= String(day).padStart(2, '0') ? ctx.today.slice(0, 7) : addMonths(ctx.today.slice(0, 7) + '-01', 1).slice(0, 7)) : addMonths(ctx.today.slice(0, 7) + '-01', 1).slice(0, 7);
      const dueDate = `${base}-${String(day).padStart(2, '0')}`;
      const p = { id: ctx.newId(), name: needName(x.name), kind: x.kind, cents: x.cents, dueDate, anchorDay: day, priority: 2, accountId: accId[x.accountKey], fundId: null, recurrence: x.recurrence, status: 'planned', createdAt: ctx.nowIso, categoryId: x.categoryId ?? (x.kind === 'investment' ? 'cat_invest' : 'cat_other'), autoPay: !!x.autoPay, remindDays: 2, confirm: x.confirm ?? (x.dueDay ? null : 'date'), origin: 'profile' };
      find(s.categories, p.categoryId, 'Categoria');
      s.planned.push(p);
      log('create', 'planned', p.id, null, p, 'Dal profilo personale · NON segnata come pagata' + (p.confirm ? ` · da confermare (${p.confirm === 'date' ? 'data' : 'attiva'})` : ''));
    }
    log('apply_profile', 'meta', 'meta', null, null, `Profilo personale applicato: ${s.accounts.length} conti, ${s.funds.length} fondi, ${s.invoiceTemplates.length} fatture ricorrenti, ${s.planned.length} scadenze. Nessun movimento registrato.`);
  });
}

// ───────────────────────── Quadratura con la banca ─────────────────────────
export function addReconciliation(state, ctx, { accountId, date = ctx.today, bankCents }) {
  return mutate(state, ctx, (s, log) => {
    find(s.accounts, accountId, 'Conto');
    req(isDate(date) && date <= ctx.today, 'data_non_valida', 'Data non valida o futura');
    assertCents(bankCents);
    const r = { id: ctx.newId(), accountId, date, bankCents, resolvedTxId: null, createdAt: ctx.nowIso };
    s.reconciliations.push(r);
    log('create', 'reconciliation', r.id, null, r, `Saldo dichiarato dalla banca: ${formatEuro(bankCents)}`);
    return r.id;
  });
}
/** Chiude una differenza con una rettifica esplicita e tracciata (mai modificando i movimenti). */
export function resolveReconciliation(state, ctx, id) {
  return mutate(state, ctx, (s, log) => {
    const r = find(s.reconciliations, id, 'Quadratura');
    req(!r.resolvedTxId, 'gia_risolta', 'Quadratura già risolta');
    const diff = r.bankCents - balanceOf(s, r.accountId, r.date);
    req(diff !== 0, 'nessuna_differenza', 'Nessuna differenza da rettificare');
    req(isCents(diff), 'importo', 'Differenza non valida');
    const t = { id: ctx.newId(), accountId: r.accountId, date: r.date, cents: diff, kind: 'adjustment', categoryId: 'cat_adj', fundId: null, receivableId: null, plannedId: null, note: 'Rettifica di quadratura con saldo bancario', status: 'posted', voidReason: null, createdAt: ctx.nowIso, updatedAt: ctx.nowIso };
    s.transactions.push(t);
    const before = copy(r);
    r.resolvedTxId = t.id;
    log('create', 'transaction', t.id, null, t, `Rettifica di ${formatEuro(diff, { plus: true })}`);
    log('resolve', 'reconciliation', id, before, copy(r));
  });
}

// ───────────────────────── Backup / ripristino ─────────────────────────
export function markBackup(state, ctx) {
  return mutate(state, ctx, (s, log) => {
    s.meta.lastBackupAt = ctx.nowIso;
    s.meta.lastBackupSeq = s.audit.length + 1;
    log('backup', 'meta', 'meta', null, { at: ctx.nowIso }, 'Backup cifrato esportato');
  });
}
export function finalizeRestore(restored, ctx, note) {
  return mutate(restored, ctx, (s, log) => {
    log('restore', 'meta', 'meta', null, { at: ctx.nowIso }, note);
  });
}
export function clearDemoData(state, ctx) {
  // Riparte da uno stato vuoto mantenendo lo storico come prova dell'operazione.
  return mutate(state, ctx, (s, log) => {
    req(s.meta.demo, 'non_demo', 'I dati non sono dimostrativi');
    const keep = s.audit;
    const fresh = {
      ...s, accounts: [], transactions: [], transfers: [], funds: [], allocations: [], receivables: [], planned: [], reconciliations: [],
      meta: { ...s.meta, demo: false },
      invoiceTemplates: [],
      settings: { ...s.settings, taxRules: [], taxProfile: { ...s.settings.taxProfile, enabled: false, fundId: null }, budget: { ...s.settings.budget, weeklyCents: 0, startDate: ctx.today } },
      audit: keep,
    };
    Object.keys(s).forEach((k) => delete s[k]);
    Object.assign(s, fresh);
    log('clear_demo', 'meta', 'meta', null, null, 'Dati dimostrativi eliminati');
  });
}

export const _internal = { diffDays };
