// Azioni utente: fogli (sheet) con form, comandi sul ledger, backup/ripristino.
// Ogni modifica passa da api.commit(): comando validato → cifratura → salvataggio → render.
import { html, raw } from './html.js';
import { I } from './icons.js';
import { amt, field, moneyField, select, segmented, pill, empty, swatches, emojiPicker, accountTile, labeled, tile } from './ui.js';
import { BANKS, MAX_LOGO_CHARS } from '../core/palette.js';
import { buildIcs } from '../core/ics.js';
import { RECUR_LABEL } from './views.js';
import * as C from '../core/commands.js';
import { AppError } from '../core/errors.js';
import { parseEuro, formatEuro, toInputValue } from '../core/money.js';
import { snapshot, fundNeed, pendingTransfers } from '../core/derive.js';
import { proposeAllocation } from '../core/allocation.js';
import { buildDemoState } from '../core/demo.js';
import { formatDate, formatDateLong } from '../core/dates.js';
import { createBackup, verifyBackup } from '../crypto/backup.js';
import { checkPasswordStrength, MIN_PASSWORD_LENGTH } from '../crypto/vault.js';
import { runIntegrityChecks } from '../core/integrity.js';
import { estimateTaxes, grossForNet } from '../core/tax.js';
import { aiExportJson } from '../core/export-ai.js';
import { budgetStatus } from '../core/budget.js';
import { situationCsv, statsCsv, forecastSummaryCsv, forecastDetailCsv } from '../core/reports.js';

const ACC_TYPES = [['checking', 'Conto corrente'], ['savings', 'Risparmio'], ['cash', 'Contanti'], ['investment', 'Investimento (PAC) · non è liquidità'], ['other', 'Altro']];
const PRIORITY = [['1', 'Alta'], ['2', 'Media'], ['3', 'Bassa']];
const RECUR = [['none', 'Una tantum'], ['weekly', 'Ogni settimana'], ['monthly', 'Ogni mese'], ['quarterly', 'Ogni 3 mesi'], ['yearly', 'Ogni anno']];
const PKINDS = [['subscription', 'Abbonamento / spesa fissa'], ['renewal', 'Rinnovo / scadenza'], ['investment', 'Investimento (PAC)'], ['purchase', 'Acquisto'], ['extraordinary', 'Spesa straordinaria']];
const PKIND_DEF = { subscription: ['monthly', 'none', 'cat_subs'], renewal: ['yearly', 'none', 'cat_subs'], investment: ['monthly', 'none', 'cat_invest'], purchase: ['none', 'new', 'cat_shop'], extraordinary: ['none', 'new', 'cat_other'] };
const REMIND = [['0', 'Il giorno stesso'], ['1', '1 giorno prima'], ['2', '2 giorni prima'], ['3', '3 giorni prima'], ['7', '1 settimana prima']];
const bpOf = (v, label) => { const x = Number(String(v ?? '').trim().replace(',', '.')); if (!Number.isFinite(x) || x < 0 || x > 100 || Math.abs(x * 100 - Math.round(x * 100)) > 1e-9) throw new AppError('perc', `${label}: usa una percentuale tra 0 e 100 (max 2 decimali)`); return Math.round(x * 100); };
const pctStr = (bp) => String(bp / 100).replace('.', ',');

const money = (v, label = 'Importo', { zero = false } = {}) => {
  if (zero && String(v ?? '').trim() === '') return 0;   // campo facoltativo lasciato vuoto = 0
  const c = parseEuro(String(v ?? ''));
  if (c == null) throw new AppError('importo', `${label} non valido (usa ad es. 1.234,56)`);
  if (!zero && c <= 0) throw new AppError('importo', `${label} deve essere maggiore di zero`);
  return c;
};
const optDate = (v) => (v ? v : null);

export function createActions(api) {
  const { app } = api;
  const st = () => app.state;
  // I conti di investimento (tasca PAC) non sono liquidità: non compaiono dove servono denaro spendibile (spese, incassi, fondi).
  const accOpts = (all = false) => st().accounts.filter((a) => (all || !a.archived) && a.type !== 'investment').map((a) => [a.id, a.name]);
  const accOptsAny = () => st().accounts.filter((a) => !a.archived).map((a) => [a.id, a.name]);
  const investOpts = () => st().accounts.filter((a) => !a.archived && a.type === 'investment').map((a) => [a.id, a.name]);
  const catOpts = (kind) => st().categories.filter((c) => c.kind === kind).map((c) => [c.id, c.name]);
  void 0;
  const fundOpts = () => [['', 'Nessuno'], ...st().funds.filter((f) => !f.archived).map((f) => [f.id, `${f.name} · ${st().accounts.find((a) => a.id === f.accountId)?.name ?? ''}`])];
  const snap = () => snapshot(st());

  // ───────────── Conti ─────────────
  function accountSheet(a = null) {
    const bankOpts = [['', 'Altra / personalizzata'], ...Object.entries(BANKS).map(([k, v]) => [k, v.name])];
    api.openSheet({
      title: a ? 'Modifica conto' : 'Nuovo conto', submit: 'Salva',
      body: html`<label class="field"><span>Banca</span><select name="bank" data-change="account-bank">${bankOpts.map(([v, t]) => html`<option value="${v}" ${v === (a?.bank ?? '') ? raw('selected') : ''}>${t}</option>`)}</select><small class="hint">Imposta colore e sigla. Il logo ufficiale lo carichi dalla tua galleria.</small></label>
        ${field('name', 'Nome', { value: a?.name ?? '', attrs: 'required maxlength="80"' })}
        ${select('type', 'Tipo', ACC_TYPES, a?.type ?? 'checking')}
        ${field('role', 'Ruolo del conto', { value: a?.role ?? '', attrs: 'maxlength="80"', hint: 'Es. Accredito compensi, Spese quotidiane, Riserva fiscale…' })}
        ${a?.balanceUnknown ? html`<div class="alert">${I.warn}<span class="grow">Saldo <b>da aggiornare</b>.</span><button type="button" class="btn sm primary inline" data-action="set-balance" data-id="${a.id}">Imposta saldo</button></div>` : ''}
        ${a ? '' : html`${moneyField('opening', 'Saldo di oggi', null, { hint: 'Da qui in poi i saldi derivano solo dai movimenti. Lascia vuoto se non lo conosci: resterà "da aggiornare".', required: false })}${field('openingDate', 'Data del saldo', { type: 'date', value: app.today, attrs: `max="${app.today}" required` })}`}
        ${labeled('Colore', swatches('color', a?.color ?? '', { allowAuto: true }))}
        ${labeled('Icona (se non usi un logo)', emojiPicker('emoji', a?.emoji ?? '', { allowNone: true }))}
        <div class="field"><span>Logo</span><div class="logo-row">${a ? accountTile(a, 'lg') : tile({ icon: '🏦', color: 'gray', size: 'lg' })}<input type="file" name="logoFile" accept="image/*" data-change="logo-pick"></div>
          <input type="hidden" name="logoData" value="">${a?.logo ? html`<label class="check"><input type="checkbox" name="removeLogo"><span>Rimuovi il logo attuale</span></label>` : ''}<small class="hint">L'immagine viene ridotta e salvata cifrata nell'archivio: non esce dal telefono.</small></div>
        ${a && !a.archived ? html`<button type="button" class="btn danger block" data-action="archive-account" data-id="${a.id}">Archivia conto</button>` : ''}`,
      onSubmit: async (v) => {
        const look = { bank: v.bank || null, color: v.color || null, emoji: v.emoji || null, role: v.role || null };
        const logo = v.removeLogo ? null : v.logoData ? v.logoData : undefined;
        if (a) await api.commit((s, c) => C.updateAccount(s, c, a.id, { name: v.name, type: v.type, ...look, ...(logo !== undefined ? { logo } : {}) }));
        else await api.commit((s, c) => C.addAccount(s, c, { name: v.name, type: v.type, openingCents: v.opening ? money(v.opening, 'Saldo', { zero: true }) : 0, balanceUnknown: !v.opening, openingDate: v.openingDate, ...look, logo: logo ?? null }));
      },
    });
  }

  // ───────────── Movimenti ─────────────
  function txSheet(kind = 'expense', pre = {}) {
    const first = accOpts();
    api.openSheet({
      title: 'Nuovo movimento', submit: 'Registra', kind,
      body: html`${segmented('kind', [['expense', 'Uscita'], ['income', 'Entrata'], ['transfer', 'Trasferimento']], kind, 'kind')}
        ${moneyField('amount', 'Importo', pre.amount ?? null)}
        ${field('date', 'Data', { type: 'date', value: app.today, attrs: `max="${app.today}" required` })}
        ${select('account', 'Conto', first, first[0]?.[0], { cls: 'not-transfer', change: 'tx-budget-hint' })}
        <div class="only-transfer"><div class="field-row">${select('from', 'Da', accOptsAny(), pre.from ?? first[0]?.[0])}${select('to', 'A', accOptsAny(), pre.to ?? first[1]?.[0] ?? first[0]?.[0])}</div>
          <div class="note">Un trasferimento sposta denaro tra i tuoi conti: non è un'entrata né una spesa.</div>
          ${select('purpose', 'Scopo', [['', 'Nessuno'], ['saving', 'Risparmio']], '')}</div>
        ${select('catExpense', 'Categoria', catOpts('expense'), 'cat_other', { cls: 'only-expense', change: 'tx-budget-hint' })}
        <div class="small only-expense" id="budget-hint" aria-live="polite"></div>
        ${select('catIncome', 'Categoria', catOpts('income'), 'cat_in_other', { cls: 'only-income' })}
        ${select('fund', 'Paga da un fondo (opzionale)', fundOpts(), '', { cls: 'only-expense', change: 'tx-budget-hint', hint: 'Spendere da un fondo scala il fondo, non il budget settimanale.' })}
        ${field('note', 'Nota', { attrs: 'maxlength="200"', cls: 'not-transfer' })}
        <div class="only-transfer">${field('note2', 'Nota')}</div>`,
      onSubmit: async (v) => {
        const cents = money(v.amount);
        if (v.kind === 'transfer') {
          await api.commit((s, c) => C.addTransfer(s, c, { fromAccountId: v.from, toAccountId: v.to, cents, date: v.date, note: v.note2, purpose: v.purpose || null }));
        } else {
          await api.commit((s, c) => C.addTransaction(s, c, { accountId: v.account, date: v.date, cents: v.kind === 'expense' ? -cents : cents, kind: v.kind, categoryId: v.kind === 'expense' ? v.catExpense : v.catIncome, fundId: v.kind === 'expense' && v.fund ? v.fund : null, note: v.note }));
        }
        api.toast('Movimento registrato');
        if (v.kind === 'expense' && snap().freeByAccount[v.account] < 0) overboundSheet(v.account);
      },
    });
    setTimeout(() => changes['tx-budget-hint']?.({ form: document.querySelector('form.sheet') }), 0);
  }
  /** Dopo una spesa che porta il libero di un conto sotto zero: spiega perché e offre i rimedi immediati. */
  function overboundSheet(accountId) {
    const S = st(), sn = snap(), acc = S.accounts.find((a) => a.id === accountId);
    const b = S.settings.budget;
    const pend = pendingTransfers(S, sn).filter((p) => p.toAccountId === accountId);
    const res = S.funds.map((f) => [f, sn.funds[f.id].byAccount[accountId] ?? 0]).filter(([, c]) => c > 0);
    const nm = (id) => S.accounts.find((a) => a.id === id)?.name;
    api.openSheet({
      title: `${acc.name}: vincolato oltre il saldo`, submit: null, cancel: 'Chiudi',
      body: html`<div class="alert high">${I.warn}<span>Dopo questa spesa su <b>${acc.name}</b> il saldo è ${formatEuro(sn.balances[accountId])} e i soldi vincolati a fondi sono ${formatEuro(sn.reservedByAccount[accountId] ?? 0)}: il libero risulta ${formatEuro(sn.freeByAccount[accountId])}.</span></div>
        <div class="section-title">Perché</div>
        <ul class="list">${res.map(([f, c]) => html`<li class="item"><span class="tile sm col-${f.color}">${f.icon}</span><div class="grow"><div class="t">${f.name}</div></div><div class="r num">${formatEuro(c)}</div></li>`)}</ul>
        ${pend.length ? html`<div class="section-title">Hai già fatto il bonifico?</div><div class="small muted">Se i soldi sono arrivati in banca ma l'app non lo sa, il saldo qui è più basso del vero. Confermalo e i saldi si allineano.</div>
          ${pend.map((p) => html`<div class="dueitem"><div class="grow"><div class="t">${nm(p.fromAccountId)} → ${nm(p.toAccountId)}</div></div><div class="r num">${formatEuro(p.cents)}</div><button class="btn sm primary inline" data-action="confirm-transfer" data-fund="${p.fundId}" data-from="${p.fromAccountId}" data-to="${p.toAccountId}" data-cents="${p.cents}">Fatto</button></div>`)}` : ''}
        ${b.fundId && b.accountId !== accountId && b.weeklyCents > 0 ? html`<div class="section-title">Budget settimanale</div><div class="small">Il conto spese del budget è <b>${nm(b.accountId)}</b>, non ${acc.name}: le spese fatte qui non consumano il fondo della settimana. Se spendi da ${acc.name}, impostalo come conto spese.</div>
          <button class="btn block mt8" data-action="budget-account-set" data-acc="${accountId}">Imposta ${acc.name} come conto spese del budget</button>` : ''}
        <div class="note">La spesa è stata registrata: nulla è perso. Puoi anche modificarla (Movimenti → tocca la spesa) o rilasciare un fondo dal suo dettaglio.</div>`,
    });
  }
  function txDetail(id) {
    const t = st().transactions.find((x) => x.id === id);
    if (!t) return;
    const acc = st().accounts.find((a) => a.id === t.accountId)?.name;
    const cat = st().categories.find((c) => c.id === t.categoryId)?.name;
    const fund = st().funds.find((f) => f.id === t.fundId)?.name;
    const lines = st().audit.filter((e) => e.entityId === id).slice(-4).reverse();
    api.openSheet({
      title: t.status === 'void' ? 'Movimento annullato' : t.kind === 'income' ? 'Entrata' : t.kind === 'adjustment' ? 'Rettifica' : 'Uscita', submit: null, cancel: 'Chiudi',
      body: html`<div class="card"><div class="big num stat-big">${amt(t.cents, { tone: true, plus: t.cents > 0 })}</div>
        <div class="kv mt12"><span class="k">Data</span><span>${formatDateLong(t.date)}</span><span class="k">Conto</span><span>${acc}</span>${cat ? html`<span class="k">Categoria</span><span>${cat}</span>` : ''}${fund ? html`<span class="k">Pagato dal fondo</span><span>${fund}</span>` : ''}${t.note ? html`<span class="k">Nota</span><span>${t.note}</span>` : ''}${t.status === 'void' ? html`<span class="k">Motivo annullamento</span><span>${t.voidReason}</span>` : ''}</div></div>
        ${t.status === 'posted' ? html`<div class="btn-row"><button class="btn" data-action="edit-tx" data-id="${t.id}">Modifica</button><button class="btn danger" data-action="void-tx" data-id="${t.id}">Annulla</button></div>` : ''}
        ${lines.length ? html`<div class="section-title">Cronologia</div><div class="card hist"><ul class="list">${lines.map((e) => html`<li class="item"><div class="grow"><div class="t">${e.action} · ${e.ts.slice(0, 16).replace('T', ' ')}</div>${e.note ? html`<div class="s">${e.note}</div>` : ''}</div></li>`)}</ul></div>` : ''}`,
    });
  }
  function txEdit(id) {
    const t = st().transactions.find((x) => x.id === id);
    api.openSheet({
      title: 'Modifica movimento', submit: 'Salva modifica',
      body: html`${moneyField('amount', 'Importo', t.cents)}${field('date', 'Data', { type: 'date', value: t.date, attrs: `max="${app.today}" required` })}
        ${select('account', 'Conto', accOpts(), t.accountId)}${t.kind !== 'adjustment' ? select('cat', 'Categoria', catOpts(t.kind), t.categoryId ?? '') : ''}
        ${t.kind === 'expense' ? select('fund', 'Fondo', fundOpts(), t.fundId ?? '') : ''}${field('note', 'Nota', { value: t.note, attrs: 'maxlength="200"' })}
        <div class="note">Ogni modifica resta nello storico con il valore prima e dopo.</div>`,
      onSubmit: async (v) => {
        const c = money(v.amount);
        const patch = { cents: t.kind === 'expense' ? -c : t.kind === 'income' ? c : (t.cents < 0 ? -c : c), date: v.date, accountId: v.account, note: v.note };
        if (t.kind !== 'adjustment') patch.categoryId = v.cat;
        if (t.kind === 'expense') patch.fundId = v.fund || null;
        await api.commit((s, cx) => C.updateTransaction(s, cx, id, patch));
        api.toast('Movimento aggiornato');
      },
    });
  }
  function reasonSheet(title, text, onDone, label = 'Annulla movimento') {
    api.openSheet({
      title, submit: label, danger: true,
      body: html`<div class="note">${text}</div>${field('reason', 'Motivo (obbligatorio)', { attrs: 'required minlength="3" maxlength="200"' })}`,
      onSubmit: async (v) => { await onDone(v.reason); },
    });
  }
  function transferDetail(id) {
    const t = st().transfers.find((x) => x.id === id);
    const nm = (i) => st().accounts.find((a) => a.id === i)?.name;
    api.openSheet({
      title: 'Trasferimento', submit: null, cancel: 'Chiudi',
      body: html`<div class="card"><div class="big num stat-big">${amt(t.cents)}</div><div class="kv mt12"><span class="k">Da</span><span>${nm(t.fromAccountId)}</span><span class="k">A</span><span>${nm(t.toAccountId)}</span><span class="k">Data</span><span>${formatDateLong(t.date)}</span>${t.note ? html`<span class="k">Nota</span><span>${t.note}</span>` : ''}${t.status === 'void' ? html`<span class="k">Annullato</span><span>${t.voidReason}</span>` : ''}</div></div>
        <div class="note">Non è un'entrata né una spesa: non incide su budget e totali.</div>
        ${t.status === 'posted' ? html`<button class="btn danger block" data-action="void-transfer" data-id="${t.id}">Annulla trasferimento</button>` : ''}`,
    });
  }

  // ───────────── Fondi ─────────────
  function fundSheet() {
    const accs = accOpts();
    api.openSheet({
      title: 'Nuovo fondo', submit: 'Crea', kind: 'goal',
      body: html`${field('name', 'Nome', { attrs: 'required maxlength="80"' })}
        ${segmented('kind', [['goal', 'Obiettivo'], ['tax', 'Fiscale'], ['reserve', 'Riserva']], 'goal', 'kind')}
        ${select('account', 'Conto', accs, accs[0]?.[0], { hint: 'Il denaro resta su questo conto: il fondo è solo un vincolo contabile.' })}
        ${kindWrap(html`${moneyField('target', 'Importo obiettivo', null, { required: false })}<div class="field-row">${select('priority', 'Priorità', PRIORITY, '2')}${field('deadline', 'Scadenza (opz.)', { type: 'date' })}</div>`)}
        ${labeled('Icona', emojiPicker('icon', '⭐'))}${labeled('Colore', swatches('color', 'indigo'))}`,
      onSubmit: async (v) => {
        const goal = v.kind === 'goal' ? { targetCents: money(v.target, 'Obiettivo'), priority: Number(v.priority), deadline: optDate(v.deadline) } : null;
        await api.commit((s, c) => C.addFund(s, c, { name: v.name, kind: v.kind, accountId: v.account, goal, icon: v.icon, color: v.color }));
      },
    });
  }
  const kindWrap = (inner) => html`<div data-show="goal">${inner}</div>`;
  function fundDetail(id) {
    const f = st().funds.find((x) => x.id === id);
    const sn = snap(), sf = sn.funds[id];
    const need = fundNeed(st(), f, sn);
    const acc = st().accounts.find((a) => a.id === f.accountId)?.name;
    const al = st().allocations.filter((a) => a.fundId === id).slice(-5).reverse();
    api.openSheet({
      title: `${f.icon} ${f.name}`, submit: null, cancel: 'Chiudi',
      body: html`<div class="card"><div class="small muted">Disponibile nel fondo</div><div class="big num stat-big">${amt(sf.available)}</div>
        <div class="kv mt12"><span class="k">Assegnato (totale)</span><span class="num">${amt(sf.assigned)}</span><span class="k">Già speso</span><span class="num">${amt(sf.spent)}</span>${f.kind === 'goal' ? html`<span class="k">Obiettivo</span><span class="num">${amt(f.goal.targetCents)}</span>` : ''}${f.refillFundId ? html`<span class="k">Reintegro automatico</span><span>→ ${st().funds.find((x) => x.id === f.refillFundId)?.name ?? '—'}</span>` : ''}${need ? html`<span class="k">Ancora da coprire</span><span class="num">${amt(need)}</span>` : ''}${f.kind === 'goal' && f.goal.deadline ? html`<span class="k">Scadenza</span><span>${formatDate(f.goal.deadline, { year: true })}</span>` : ''}<span class="k">Conto di riferimento</span><span>${acc}</span>${Object.entries(sf.byAccount).filter(([, c]) => c !== 0).map(([id, c]) => html`<span class="k">Riservato su ${st().accounts.find((a) => a.id === id)?.name}</span><span class="num">${amt(c)}</span>`)}</div></div>
        ${pendingTransfers(st(), sn).filter((p) => p.fundId === id).map((p) => html`<div class="alert">${I.warn}<span class="grow">${formatEuro(p.cents)} riservati su ${st().accounts.find((a) => a.id === p.fromAccountId)?.name}: bonifico verso ${acc} da confermare.</span><button class="btn sm primary inline" data-action="confirm-transfer" data-fund="${id}" data-from="${p.fromAccountId}" data-to="${p.toAccountId}" data-cents="${p.cents}">Bonifico fatto</button></div>`)}
        <div class="btn-row"><button class="btn primary" data-action="assign" data-id="${id}">Assegna</button><button class="btn" data-action="release" data-id="${id}">Rilascia</button></div>
        <div class="spacer10"></div><div class="btn-row"><button class="btn" data-action="move-fund" data-id="${id}">Sposta ad altro fondo</button><button class="btn" data-action="edit-fund" data-id="${id}">Modifica</button></div>
        <div class="spacer10"></div><div class="btn-row"><button class="btn" data-action="relocate-fund" data-id="${id}">Sposta su altro conto</button><button class="btn danger" data-action="close-fund" data-id="${id}">Chiudi fondo</button></div>
        <div class="note">Assegnare o rilasciare <b>non muove denaro in banca</b>: cambia solo quanto del conto è vincolato.</div>
        ${al.length ? html`<div class="section-title">Ultime allocazioni</div><div class="card"><ul class="list">${al.map((a) => html`<li class="item"><div class="grow"><div class="t">${a.kind === 'assign' ? 'Assegnato' : a.kind === 'release' ? 'Rilasciato' : 'Spostamento'}</div><div class="s">${formatDate(a.date, { year: true })}${a.note ? ' · ' + a.note : ''}</div></div><div class="r num">${amt(a.cents, { tone: true, plus: true })}</div></li>`)}</ul></div>` : ''}`,
    });
  }
  function simpleAmountSheet(title, label, hint, run, { max = null } = {}) {
    api.openSheet({ title, submit: 'Conferma', body: html`${moneyField('amount', label, max && max > 0 ? null : null, { hint })}${max != null ? html`<button type="button" class="link-btn small" data-fill="${toInputValue(Math.max(0, max))}">Usa il massimo (${formatEuro(Math.max(0, max))})</button>` : ''}`, onSubmit: async (v) => { await run(money(v.amount)); } });
  }

  // ───────────── Incassi ─────────────
  function receivableSheet(r = null) {
    const accs = accOpts();
    const got = r?.receivedCents ?? 0;
    const hasReserve = r?.reserveCents != null;
    api.openSheet({
      title: r ? (r.status === 'partial' ? 'Incasso parziale' : 'Incasso previsto') : 'Nuovo incasso previsto', submit: 'Salva',
      body: html`${field('client', 'Cliente', { value: r?.client ?? '', attrs: 'required maxlength="80"' })}${field('description', 'Descrizione', { value: r?.description ?? '', attrs: 'maxlength="200"' })}
        ${r?.status === 'partial' ? html`<div class="alert">${I.warn}<span>Incassati ${formatEuro(got)} di ${formatEuro(r.expectedCents)}: restano ${formatEuro(r.expectedCents - got)}.</span></div>` : ''}
        <label class="field"><span>Importo ${r ? 'definitivo della fattura' : 'previsto'}</span><input class="money" name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" required value="${r ? toInputValue(r.expectedCents) : ''}" data-change="receivable-amount" data-orig="${r?.expectedCents ?? ''}"></label>
        <div id="amount-note" class="alert amount-note">${I.warn}<span>L'importo della fattura è cambiato: scegli cosa fare con la riserva. Verrà modificata <b>solo questa fattura</b>, mai la regola dei mesi futuri.</span></div>
        ${field('date', 'Data prevista di incasso', { type: 'date', value: r?.expectedDate ?? app.today, attrs: 'required' })}
        ${r?.status === 'partial' ? '' : select('account', 'Conto di accredito', accs, r?.accountId ?? accs[0]?.[0])}
        ${moneyField('reserve', 'Riserva fiscale (tua regola)', r?.reserveCents ?? null, { required: false, hint: 'Vuoto = si usa la stima del profilo fiscale. La riserva è fissa; se incassi in parte è proporzionale.' })}
        ${hasReserve ? html`<div class="field amount-choice"><span>Se l'importo è cambiato, la riserva…</span><div class="seg stack-seg"><label><input type="radio" name="reserveMode" value="keep" checked><span>resta fissa</span></label><label><input type="radio" name="reserveMode" value="proportional"><span>si ricalcola in proporzione</span></label><label><input type="radio" name="reserveMode" value="theoretical"><span>stima del profilo fiscale</span></label></div></div>` : ''}
        <div class="note">È una <b>previsione</b>: non cambia saldi né liquidità finché non la segni come incassata.</div>
        ${r?.status === 'partial' ? html`<button type="button" class="btn block" data-action="close-receivable" data-id="${r.id}">Chiudi con quanto incassato (${formatEuro(got)})</button><div class="spacer10"></div>` : ''}
        ${r && r.status === 'expected' ? html`<button type="button" class="btn danger block" data-action="cancel-receivable" data-id="${r.id}">Annulla incasso previsto</button>` : ''}`,
      onSubmit: async (v) => {
        const reserve = String(v.reserve ?? '').trim() ? money(v.reserve, 'Riserva', { zero: true }) : null;
        const cents = money(v.amount);
        if (r) {
          const patch = { client: v.client, description: v.description, expectedCents: cents, expectedDate: v.date, ...(r.status === 'expected' ? { accountId: v.account } : {}) };
          if (reserve !== r.reserveCents) patch.reserveCents = reserve; else if (cents !== r.expectedCents) patch.reserveMode = v.reserveMode ?? 'keep';
          await api.commit((s, c) => C.updateReceivable(s, c, r.id, patch));
          if (cents !== r.expectedCents) api.toast(r.reserveCents != null && patch.reserveMode ? `Importo cambiato · riserva: ${{ keep: 'mantenuta fissa', proportional: 'ricalcolata in proporzione', theoretical: 'ricalcolata con la stima fiscale' }[patch.reserveMode]}` : 'Importo aggiornato');
        } else await api.commit((s, c) => C.addReceivable(s, c, { client: v.client, description: v.description, expectedCents: cents, expectedDate: v.date, accountId: v.account, reserveCents: reserve }));
      },
    });
  }
  function receiveSheet(id) {
    const r = st().receivables.find((x) => x.id === id);
    const accs = accOpts();
    const left = r.expectedCents - (r.receivedCents ?? 0);
    api.openSheet({
      title: `Incasso da ${r.client}`, submit: 'Registra incasso',
      body: html`${r.status === 'partial' ? html`<div class="alert">${I.warn}<span>Già incassati ${formatEuro(r.receivedCents)} di ${formatEuro(r.expectedCents)}: restano ${formatEuro(left)}.</span></div>` : ''}
        ${moneyField('amount', 'Importo effettivamente ricevuto', left, { hint: `Da incassare: ${formatEuro(left)}. Se ricevi meno, resta un incasso parziale e la riserva sarà proporzionale.` })}
        ${field('date', 'Data di accredito', { type: 'date', value: app.today, attrs: `max="${app.today}" required` })}${select('account', 'Conto', accs, r.accountId, { hint: 'Il denaro è registrato sul conto dove arriva davvero.' })}
        <label class="check"><input type="checkbox" name="close"><span><b>È il saldo definitivo:</b> chiudi la fattura con il totale incassato anche se diverso dal previsto.</span></label>
        <div class="note">Dopo la registrazione ti propongo la riserva fiscale. Resta tutto <b>virtuale</b>: nessun bonifico viene registrato da una proposta.</div>`,
      onSubmit: async (v) => {
        const cents = money(v.amount);
        await api.commit((s, c) => C.receiveReceivable(s, c, { id, date: v.date, cents, accountId: v.account, close: v.close === 'on' }));
        api.toast(st().receivables.find((x) => x.id === id)?.status === 'partial' ? 'Incasso parziale registrato' : 'Incasso registrato');
        setTimeout(() => allocationSheet(v.account, cents, 'Come usi questo incasso', { professional: true, receivableId: id }), 250);
      },
    });
  }

  // ───────────── Allocazione ─────────────
  function allocationSheet(accountId, cents, title = 'Suggerimento di allocazione', { professional = false, receivableId = null } = {}) {
    const receivable = receivableId ? st().receivables.find((r) => r.id === receivableId) : null;
    const p = proposeAllocation(st(), { accountId, cents, today: app.today, professional, receivable });
    const nm = (id) => st().accounts.find((a) => a.id === id)?.name;
    if (p.items.length === 0) {
      api.openSheet({ title, submit: null, cancel: 'Chiudi', body: html`${empty('Nessuna allocazione necessaria', 'Non ci sono fondi con fabbisogno scoperto o il denaro libero è esaurito: l\'importo resta libero.')}` });
      return;
    }
    const REASON = { tax: 'Riserva fiscale', urgent: 'Scadenza urgente', priority: 'Priorità' };
    const ti = p.taxInfo;
    const alt = ti?.mode === 'definitive_diff';
    api.openSheet({
      title, submit: 'Applica (virtuale)',
      body: html`<div class="note">Importo considerato <b>${formatEuro(p.allocatedCents + p.remainderCents)}</b> sul conto <b>${nm(accountId)}</b>${p.cappedByFree ? ' (limitato al denaro libero)' : ''}. È un <b>accantonamento virtuale</b>: nessun bonifico viene registrato. Se il fondo è su un altro conto, lo confermerai tu quando fai il bonifico in banca.</div>
        <input type="hidden" name="count" value="${p.items.length}">
        ${ti?.mode === 'partial' ? html`<div class="alert">${I.warn}<span><b>Incasso parziale.</b> Riserva proporzionale a quanto incassato. Riserva complessiva prevista ${formatEuro(ti.planned)} · già accantonata ${formatEuro(ti.done)} · con questa quota restano ${formatEuro(ti.remainingAfter)} da accantonare.</span></div>` : ''}
        ${alt ? html`<div class="alert">${I.warn}<span><b>L'importo definitivo (${formatEuro(ti.got)}) è diverso dal previsto.</b> La riserva fissa resta quella predefinita: scegli se mantenerla o ricalcolarla. Non cambia nessuna regola futura.</span></div>
          <div class="field"><span>Riserva per questa fattura</span><div class="seg stack-seg">
            <label><input type="radio" name="choice" value="fixed" checked data-change="reserve-choice" data-amount="${toInputValue(ti.fixed)}"><span>Fissa ${formatEuro(ti.fixed)}</span></label>
            <label><input type="radio" name="choice" value="prop" data-change="reserve-choice" data-amount="${toInputValue(ti.propFinal)}"><span>Proporzionale ${formatEuro(ti.propFinal)}</span></label>
            <label><input type="radio" name="choice" value="theo" data-change="reserve-choice" data-amount="${toInputValue(ti.theoFinal)}"><span>Stima fiscale ${formatEuro(ti.theoFinal)}</span></label></div></div>` : ''}
        ${p.items.map((it, i) => html`<input type="hidden" name="f${i}" value="${it.fundId}"><input type="hidden" name="acc${i}" value="${it.accountId}"><input type="hidden" name="rc${i}" value="${it.receivableId ?? ''}">
          <label class="field"><span>${it.icon} ${it.name}</span><input class="money sm" name="a${i}" inputmode="decimal" value="${toInputValue(it.cents)}" autocomplete="off"><small class="hint">${REASON[it.reason]} · ${it.detail}${it.pendingTransferTo ? ` · poi da trasferire a ${nm(it.pendingTransferTo)}` : ''}</small></label>`)}
        ${ti ? html`<div class="kv"><span class="k">Stima teorica (INPS + imposta)</span><span class="num">${amt(ti.total)}</span>${ti.custom != null ? html`<span class="k">Riserva prevista per questa fattura</span><span class="num">${amt(ti.planned ?? ti.custom)}</span>${ti.planned != null ? html`<span class="k">Già accantonata (incassi precedenti)</span><span class="num">${amt(ti.done)}</span>` : ''}` : ''}</div>` : ''}
        <div class="kv"><span class="k"><b>Ti resta libero (disponibile per te)</b></span><span class="num"><b>${amt(p.remainderCents)}</b></span></div>
        <div class="note">Puoi cambiare ogni cifra. Il totale non può superare il denaro libero del conto.</div>`,
      onSubmit: async (v) => {
        const items = [];
        for (let i = 0; i < Number(v.count); i++) { const c = String(v['a' + i] ?? '').trim() === '' ? 0 : money(v['a' + i], 'Importo', { zero: true }); if (c > 0) items.push({ fundId: v['f' + i], cents: c, accountId: v['acc' + i], receivableId: v['rc' + i] || null }); }
        if (!items.length) throw new AppError('vuoto', 'Nessun importo da allocare');
        await api.commit((s, c) => C.applyAllocationPlan(s, c, items));
        api.toast('Accantonamento registrato (virtuale)');
      },
    });
  }
  /** Aggiorna i saldi di tutti i conti insieme, con il saldo reale di oggi: utile anche dopo giorni senza aprire l'app. */
  function balancesSheet(focusId = null) {
    const sn = snap();
    const list = st().accounts.filter((x) => !x.archived);
    if (!list.length) { api.toast('Nessun conto', true); return; }
    api.openSheet({
      title: 'Aggiorna saldi', submit: 'Aggiorna',
      body: html`<div class="note">Scrivi il saldo di oggi <b>come lo mostra la banca</b> solo per i conti che vuoi aggiornare (gli altri lasciali vuoti). Se un conto ha già movimenti, la differenza viene registrata come <b>rettifica tracciata</b>; se non ne ha, correggi semplicemente il saldo iniziale.</div>
        ${list.map((a) => html`<label class="field bal-field"><span class="row left">${accountTile(a, 'sm')}<b>${a.name}</b>${a.role ? html` <small class="muted">· ${a.role}</small>` : ''}</span>
          <input class="money sm" name="b_${a.id}" inputmode="text" autocomplete="off" placeholder="${a.balanceUnknown ? 'Da aggiornare' : formatEuro(sn.balances[a.id], { symbol: false })}" ${a.id === focusId ? raw('data-focus="1"') : ''}>
          <small class="hint">${a.balanceUnknown ? 'Saldo non ancora inserito.' : `Oggi nell'app: ${formatEuro(sn.balances[a.id])}`}</small></label>`)}`,
      onSubmit: async (v) => {
        const items = [];
        for (const a of list) {
          const raw_ = String(v['b_' + a.id] ?? '').trim();
          if (!raw_) continue;
          const c = parseEuro(raw_);
          if (c == null) throw new AppError('importo', `Saldo di ${a.name} non valido (usa ad es. 1.234,56; il segno meno per un saldo negativo)`);
          items.push({ accountId: a.id, balanceCents: c });
        }
        if (!items.length) throw new AppError('vuoto', 'Scrivi il saldo di almeno un conto');
        const out = await api.commit((s, c) => C.updateBalances(s, c, items));
        const adj = out.filter((x) => x.how === 'adjustment').length;
        api.toast(out.length === 0 ? 'Nessuna differenza: saldi già allineati' : adj ? `Saldi aggiornati · ${adj} rettifica${adj > 1 ? 'e' : ''} registrata${adj > 1 ? 'e' : ''}` : 'Saldi aggiornati');
      },
    });
    setTimeout(() => sheetRootFocus(), 50);
  }
  const sheetRootFocus = () => document.querySelector('.sheet [data-focus="1"]')?.focus();
  /** Conferma di un bonifico GIÀ eseguito in banca: solo qui nasce il trasferimento reale. */
  function confirmTransferSheet({ fundId, from, to, cents }) {
    const f = st().funds.find((x) => x.id === fundId);
    const nm = (id) => st().accounts.find((a) => a.id === id)?.name;
    api.openSheet({
      title: 'Conferma bonifico eseguito', submit: 'Confermo: bonifico eseguito',
      body: html`<div class="note">Registra il trasferimento <b>${nm(from)} → ${nm(to)}</b> per "${f.icon} ${f.name}". Conferma solo se il bonifico è davvero partito: da qui in poi i saldi dei due conti cambiano.</div>
        ${moneyField('amount', 'Importo trasferito', cents, { hint: `Riservati su ${nm(from)}: ${formatEuro(cents)}. Puoi confermare una parte.` })}
        ${field('date', 'Data del bonifico', { type: 'date', value: app.today, attrs: `max="${app.today}" required` })}`,
      onSubmit: async (v) => { await api.commit((s, c) => C.confirmFundTransfer(s, c, { fundId, fromAccountId: from, toAccountId: to, cents: money(v.amount), date: v.date })); api.toast('Bonifico registrato ✓'); },
    });
  }

  // ───────────── Pianificazione ─────────────
  function plannedSheet(p = null) {
    const accs = accOpts();
    const funds = st().funds.filter((f) => !f.archived && f.kind !== 'planned').map((f) => [f.id, f.name]);
    const catOptsE = [...catOpts('expense'), ...catOpts('investment')];
    api.openSheet({
      title: p ? 'Modifica scadenza' : 'Nuova scadenza o spesa', submit: 'Salva',
      body: html`${field('name', 'Descrizione', { value: p?.name ?? '', attrs: 'required maxlength="80"', hint: 'Es. Abbonamento Claude, Corso di tennis, PAC, Rinnovo assicurazione' })}
        ${p ? '' : html`<label class="field"><span>Tipo</span><select name="kind" data-change="planned-kind">${PKINDS.map(([v, t]) => html`<option value="${v}">${t}</option>`)}</select></label>`}
        ${moneyField('amount', 'Importo', p?.cents ?? null)}${field('due', 'Prossima scadenza', { type: 'date', value: p?.dueDate ?? app.today, attrs: 'required' })}
        ${select('recurrence', 'Cadenza', RECUR, p?.recurrence ?? 'monthly')}
        ${select('category', 'Categoria', catOptsE, p?.categoryId ?? 'cat_subs')}
        ${select('remind', 'Avviso (nel Calendario)', REMIND, String(p?.remindDays ?? 2))}
        <label class="check"><input type="checkbox" name="autoPay" ${p?.autoPay ? raw('checked') : ''}><span>Addebito automatico (devo solo verificarlo)</span></label>
        ${select('priority', 'Priorità', PRIORITY, String(p?.priority ?? 2))}
        ${select('funding', 'Accantona dal conto', [['', 'Predefinito (impostazioni del budget)'], ...accOpts()], p?.fundingAccountId ?? '', { hint: 'Da quale conto riservare in anticipo i soldi di questa voce (es. BBVA per i viaggi e le scadenze).' })}
        ${select('lead', 'Bonifico con anticipo di', [['0', 'Nessun anticipo'], ['1', '1 giorno'], ['2', '2 giorni'], ['3', '3 giorni'], ['5', '5 giorni'], ['7', '7 giorni']], String(p?.leadDays ?? 0), { hint: 'Quanti giorni prima della scadenza i soldi devono essere sul conto di pagamento (es. PAC con addebito il 2: 2 giorni).' })}
        ${investOpts().length ? html`${select('toAccount', 'Versamento su (tasca di investimento)', [['', 'Nessuno: è una spesa o un pagamento'], ...investOpts()], p?.toAccountId ?? '', { hint: 'Es. PAC: i soldi passano dalla tasca Tasse alla tasca PAC (trasferimento interno, non una spesa).' })}
          <label class="check"><input type="checkbox" name="autoExecute" ${p?.autoExecute ? raw('checked') : ''}><span>Esegui <b>automaticamente</b> alla scadenza (solo se c'è denaro libero sufficiente nella tasca di origine)</span></label>` : ''}
        ${p ? select('account', 'Conto da cui paghi', accs, p.accountId, { hint: 'Il conto dove i soldi devono trovarsi al momento del pagamento. Se è diverso da quello di accantonamento compare il bonifico da fare.' }) : ''}
        ${p ? '' : html`${select('account', 'Conto da cui paghi', accs, accs[0]?.[0])}
          ${select('fundMode', 'Copertura', [['none', 'Nessun fondo (pesa sul libero)'], ['new', 'Crea un fondo dedicato'], ...(funds.length ? [['existing', 'Usa un fondo esistente']] : [])], 'none')}
          ${funds.length ? select('fund', 'Fondo esistente', funds, funds[0][0]) : ''}`}
        ${p ? html`<button type="button" class="btn danger block" data-action="cancel-planned" data-id="${p.id}">Elimina scadenza</button>` : ''}`,
      onSubmit: async (v) => {
        const common = { name: v.name, cents: money(v.amount), dueDate: v.due, priority: Number(v.priority), categoryId: v.category, autoPay: v.autoPay === 'on', remindDays: Number(v.remind), recurrence: v.recurrence, fundingAccountId: v.funding || null, leadDays: Number(v.lead), toAccountId: v.toAccount || null, autoExecute: v.autoExecute === 'on' };
        if (p) await api.commit((s, c) => C.updatePlanned(s, c, p.id, { ...common, accountId: v.account }));
        else await api.commit((s, c) => C.addPlanned(s, c, { ...common, kind: v.kind, accountId: v.account, fundMode: v.fundMode, fundId: v.fund || null }));
      },
    });
  }
  function completePlannedSheet(id) {
    const p = st().planned.find((x) => x.id === id);
    const f = st().funds.find((x) => x.id === p.fundId);
    const avail = f ? snap().funds[f.id].available : 0;
    api.openSheet({
      title: p.toAccountId ? `Versamento: ${p.name}` : `${p.autoPay ? 'Conferma addebito' : 'Segna pagato'}: ${p.name}`, submit: p.toAccountId ? 'Registra versamento' : p.autoPay ? 'Confermo addebito' : 'Segna pagato',
      body: html`${moneyField('amount', 'Importo pagato', p.cents)}${field('date', 'Data', { type: 'date', value: app.today, attrs: `max="${app.today}" required` })}
        ${select('account', p.toAccountId ? 'Da quale tasca' : 'Conto', accOpts(), p.accountId)}${p.toAccountId ? html`<div class="note">Trasferimento <b>interno</b> verso <b>${st().accounts.find((a) => a.id === p.toAccountId)?.name}</b>: non è una spesa. Riduce la liquidità e aumenta l'investito.</div>` : select('cat', 'Categoria', [...catOpts('expense'), ...catOpts('investment')], p.categoryId ?? 'cat_other')}
        ${f ? html`<label class="check"><input type="checkbox" name="useFund" ${avail > 0 ? raw('checked') : ''}><span>Paga dal fondo "${f.name}" (disponibili ${formatEuro(avail)})</span></label>` : ''}
        <div class="note">${p.kind === 'investment' ? 'È un investimento (PAC): riduce la liquidità ma non è una spesa di consumo. ' : ''}${p.recurrence === 'none' ? 'È una scadenza singola: verrà chiusa.' : `Scadenza ${RECUR_LABEL[p.recurrence]}: dopo il pagamento passa automaticamente alla successiva.`}</div>`,
      onSubmit: async (v) => {
        await api.commit((s, c) => C.completePlanned(s, c, { id, date: v.date, cents: money(v.amount), accountId: v.account, categoryId: v.cat || null, useFund: v.useFund === 'on' }));
        api.toast('Pagamento registrato ✓');
      },
    });
  }

  // ───────────── Impostazioni ─────────────
  function budgetSheet() {
    const b = st().settings.budget;
    api.openSheet({
      title: 'Budget settimanale', submit: 'Salva',
      body: html`${moneyField('weekly', 'Importo a settimana', b.weeklyCents || null, { required: false })}${field('start', 'Inizio calcolo', { type: 'date', value: b.startDate, attrs: 'required' })}
        <label class="check"><input type="checkbox" name="carry" ${b.carryOver ? raw('checked') : ''}><span>Riporta gli avanzi alla settimana successiva</span></label>
        <label class="check"><input type="checkbox" name="deficit" ${b.carryDeficit ? raw('checked') : ''}><span>Riporta anche i disavanzi (sforamenti)</span></label>`,
      onSubmit: async (v) => {
        await api.commit((s, c) => C.updateBudget(s, c, { weeklyCents: v.weekly ? money(v.weekly, 'Importo', { zero: true }) : 0, startDate: v.start, carryOver: v.carry === 'on', carryDeficit: v.deficit === 'on' }));
      },
    });
  }
  function taxSheet() {
    const rules = st().settings.taxRules;
    const fundOptsTax = st().funds.filter((f) => !f.archived).map((f) => [f.id, f.name]);
    if (!fundOptsTax.length) { api.toast('Crea prima un fondo (tipo Fiscale) in Fondi', true); return; }
    const row = (i) => { const r = rules[i]; return html`<div class="card"><div class="field-row">${field('name' + i, 'Nome', { value: r?.name ?? '', attrs: 'maxlength="60"' })}${field('pct' + i, 'Percentuale', { value: r ? String(r.bp / 100).replace('.', ',') : '', attrs: 'inputmode="decimal" placeholder="25"' })}</div>${select('fund' + i, 'Fondo di destinazione', fundOptsTax, r?.fundId ?? fundOptsTax[0][0])}</div>`; };
    api.openSheet({
      title: 'Accantonamenti fiscali', submit: 'Salva',
      body: html`<div class="note">Percentuale dell'incasso ricevuto da assegnare al fondo (allocazione virtuale). Lascia vuoto per non usare la regola.</div>${[0, 1, 2].map(row)}`,
      onSubmit: async (v) => {
        const out = [];
        for (let i = 0; i < 3; i++) {
          const name = String(v['name' + i] ?? '').trim(), pct = String(v['pct' + i] ?? '').trim();
          if (!name && !pct) continue;
          const p = Number(pct.replace(',', '.'));
          if (!name || !Number.isFinite(p) || p < 0 || p > 100 || Math.round(p * 100) !== p * 100 && Math.abs(Math.round(p * 100) - p * 100) > 1e-9) throw new AppError('regola', 'Regola non valida: nome e percentuale (0–100, max 2 decimali)');
          out.push({ id: rules[i]?.id, name, bp: Math.round(p * 100), fundId: v['fund' + i] });
        }
        await api.commit((s, c) => C.setTaxRules(s, c, out));
      },
    });
  }
  function lockSheet() {
    const s = st().settings;
    api.openSheet({
      title: 'Blocco automatico', submit: 'Salva',
      body: html`${select('idle', 'Blocca dopo inattività', [['30', '30 secondi'], ['60', '1 minuto'], ['120', '2 minuti'], ['300', '5 minuti'], ['900', '15 minuti']], String(s.autoLockSec))}
        ${select('hidden', 'Blocca se l\'app resta in background', [['0', 'Subito'], ['15', 'Dopo 15 secondi'], ['30', 'Dopo 30 secondi'], ['60', 'Dopo 1 minuto'], ['300', 'Dopo 5 minuti']], String(s.hiddenLockSec))}
        <div class="note">Più è breve, più sei protetto se qualcuno ha il telefono sbloccato.</div>`,
      onSubmit: async (v) => { await api.commit((st_, c) => C.updateSettings(st_, c, { autoLockSec: Number(v.idle), hiddenLockSec: Number(v.hidden) })); api.rearmIdle(); },
    });
  }
  function passwordSheet() {
    api.openSheet({
      title: 'Cambia password', submit: 'Cambia password',
      body: html`<label class="field"><span>Password attuale</span><input type="password" name="old" autocomplete="current-password" required></label>
        <label class="field"><span>Nuova password</span><input type="password" name="pw" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}"><small class="hint">Almeno ${MIN_PASSWORD_LENGTH} caratteri. Meglio una frase.</small></label>
        <label class="field"><span>Ripeti nuova password</span><input type="password" name="pw2" autocomplete="new-password" required></label>
        <div class="note">Cambia solo la chiave che protegge l'archivio. I backup già creati restano apribili con la loro password.</div>`,
      onSubmit: async (v) => {
        if (v.pw !== v.pw2) throw new AppError('pw', 'Le due password non coincidono');
        const ok = checkPasswordStrength(v.pw); if (!ok.ok) throw new AppError('pw', ok.message);
        await api.vault.changePassword(v.old, v.pw);
        api.toast('Password cambiata');
      },
    });
  }
  function reconciliationSheet() {
    const accs = accOpts();
    api.openSheet({
      title: 'Quadratura con la banca', submit: 'Confronta',
      body: html`${select('account', 'Conto', accs, accs[0]?.[0])}${field('date', 'Data del saldo', { type: 'date', value: app.today, attrs: `max="${app.today}" required` })}${moneyBank()}`,
      onSubmit: async (v) => { await api.commit((s, c) => C.addReconciliation(s, c, { accountId: v.account, date: v.date, bankCents: money(v.bank, 'Saldo', { zero: true }) })); },
    });
  }
  const moneyBank = () => html`<label class="field"><span>Saldo secondo la banca</span><input class="money" name="bank" inputmode="text" placeholder="0,00" autocomplete="off" required><small class="hint">Può essere negativo: usa il segno meno (es. -120,50).</small></label>`;

  // ───────────── Backup / ripristino ─────────────
  const saveBlob = (name, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  function exportBackupSheet() {
    api.openSheet({
      title: 'Backup cifrato', submit: 'Crea backup',
      body: html`<div class="note">Il file è cifrato con una password che scegli ora (può essere diversa da quella dell'app). <b>Senza questa password il backup non si apre.</b> Conservala separatamente.</div>
        <label class="field"><span>Password del backup</span><input type="password" name="pw" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}"></label>
        <label class="field"><span>Ripeti password</span><input type="password" name="pw2" autocomplete="new-password" required></label>`,
      onSubmit: async (v) => {
        if (v.pw !== v.pw2) throw new AppError('pw', 'Le due password non coincidono');
        const ok = checkPasswordStrength(v.pw); if (!ok.ok) throw new AppError('pw', ok.message);
        const b = await createBackup(st(), v.pw, { iterations: api.kdfIterations, now: new Date() });
        const check = await verifyBackup(b.text, v.pw); // verifica immediata: il file appena creato deve riaprirsi
        if (!check.integrity.ok || !check.summaryMatches) throw new AppError('verifica', 'Verifica del backup fallita: non utilizzare il file');
        app.pendingBackup = b;
        setTimeout(() => backupReadySheet(check.summary), 200);
      },
    });
  }
  function backupReadySheet(summary) {
    const b = app.pendingBackup;
    api.openSheet({
      title: 'Backup pronto e verificato', submit: null, cancel: 'Chiudi', onClose: () => { app.pendingBackup = null; },
      body: html`<div class="alert ok">${I.check}<span>Il file è stato ricreato e decifrato con successo: contenuto e quadratura verificati.</span></div>
        <div class="card"><div class="kv"><span class="k">File</span><span class="small">${b.filename}</span><span class="k">Conti</span><span>${summary.counts.accounts}</span><span class="k">Movimenti</span><span>${summary.counts.transactions}</span><span class="k">Saldo totale</span><span class="num">${amt(summary.totalCents)}</span><span class="k">Voci di storico</span><span>${summary.counts.audit}</span></div></div>
        <button class="btn primary block" data-action="share-backup">${I.save} Salva in File / Condividi</button><div class="spacer10"></div>
        <button class="btn block" data-action="download-backup">Scarica il file</button>
        <div class="note">Salvalo in <b>File → iCloud Drive</b> (o altrove fuori dal telefono). Il file è cifrato: puoi tenerlo anche in cloud senza esporre i dati.</div>`,
    });
  }
  function restoreSheet({ verifyOnly = false, atSetup = false } = {}) {
    api.openSheet({
      title: verifyOnly ? 'Verifica backup' : 'Ripristina da backup', submit: 'Verifica file',
      body: html`<div class="note">${verifyOnly ? 'Controlla che il file si apra e sia coerente, senza modificare nulla.' : 'Prima verifico il file (decifratura, hash, schema, quadratura): nulla viene sostituito finché non confermi.'}</div>
        <label class="field"><span>File di backup (.fpbak)</span><input type="file" name="file" accept=".fpbak,application/json,application/octet-stream" required></label>
        <label class="field"><span>Password del backup</span><input type="password" name="pw" autocomplete="off" required></label>`,
      onSubmit: async (v, form) => {
        const file = form.elements.file.files[0];
        if (!file) throw new AppError('file', 'Seleziona un file');
        if (file.size > 64 * 1024 * 1024) throw new AppError('file', 'File troppo grande');
        const res = await verifyBackup(await file.text(), v.pw);
        app.pendingRestore = res;
        setTimeout(() => restoreConfirmSheet(res, verifyOnly), 200);
      },
    });
  }
  function restoreConfirmSheet(res, verifyOnly) {
    const cur = st() ? snapshot(st()) : null;
    const s = res.summary;
    api.openSheet({
      title: verifyOnly ? 'Backup valido' : 'Conferma ripristino', submit: verifyOnly ? null : 'Ripristina', cancel: verifyOnly ? 'Chiudi' : 'Annulla', danger: !verifyOnly,
      onClose: () => { app.pendingRestore = null; },
      body: html`<div class="alert ${res.integrity.ok && res.summaryMatches ? 'ok' : 'high'}">${res.integrity.ok ? I.check : I.warn}<span>${res.integrity.ok && res.summaryMatches ? 'Decifratura, hash, schema e quadratura: tutto verificato.' : 'Il backup si apre ma presenta incongruenze di quadratura.'}</span></div>
        <div class="card"><div class="kv"><span class="k">Creato il</span><span>${res.createdAt.slice(0, 16).replace('T', ' ')}</span><span class="k">Conti</span><span>${s.counts.accounts}</span><span class="k">Movimenti</span><span>${s.counts.transactions}</span><span class="k">Fondi</span><span>${s.counts.funds}</span><span class="k">Saldo totale</span><span class="num">${amt(s.totalCents)}</span><span class="k">Liquidità libera</span><span class="num">${amt(s.freeCents)}</span>${s.demo ? html`<span class="k">Tipo</span><span>${pill('dati demo', 'acc')}</span>` : ''}</div></div>
        ${!verifyOnly && cur ? html`<div class="card"><h2>Dati attuali (verranno sostituiti)</h2><div class="kv"><span class="k">Movimenti</span><span>${st().transactions.length}</span><span class="k">Saldo totale</span><span class="num">${amt(cur.total)}</span></div></div>` : ''}
        ${verifyOnly ? '' : html`<div class="note">Prima di sostituire, i dati attuali vengono salvati in una copia di sicurezza interna cifrata. Scrivi <b>RIPRISTINA</b> per confermare.</div>${field('confirm', 'Conferma', { attrs: 'autocapitalize="characters" required' })}`}`,
      onSubmit: verifyOnly ? null : async (v) => {
        if (String(v.confirm).trim().toUpperCase() !== 'RIPRISTINA') throw new AppError('conferma', 'Scrivi RIPRISTINA per confermare');
        if (st()) await api.vault.saveSnapshot('pre-restore', st());
        const restored = app.pendingRestore.state;
        await api.commit((_s, c) => C.finalizeRestore(restored, c, `Ripristino da backup del ${app.pendingRestore.createdAt.slice(0, 10)}`));
        app.pendingRestore = null;
        api.toast('Backup ripristinato');
      },
    });
  }
  function csvSheet() {
    api.openSheet({
      title: 'Esporta in chiaro', submit: 'Esporta CSV', danger: true,
      body: html`<div class="alert high">${I.warn}<span>Il file CSV <b>non è cifrato</b>: chiunque lo apra vede tutti i movimenti. Non condividerlo e cancellalo dopo l'uso.</span></div>
        <label class="check"><input type="checkbox" name="ok" required><span>Ho capito e voglio esportare senza cifratura</span></label>`,
      onSubmit: async () => {
        const cat = Object.fromEntries(st().categories.map((c) => [c.id, c.name])), acc = Object.fromEntries(st().accounts.map((a) => [a.id, a.name]));
        const q = (x) => { let s = String(x ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
        const rows = [['data', 'conto', 'tipo', 'importo', 'categoria', 'nota', 'stato'].join(';')];
        for (const t of [...st().transactions].sort((a, b) => (a.date < b.date ? -1 : 1))) rows.push([t.date, q(acc[t.accountId]), t.kind, (t.cents / 100).toFixed(2).replace('.', ','), q(cat[t.categoryId]), q(t.note), t.status].join(';'));
        for (const t of st().transfers) rows.push([t.date, q(`${acc[t.fromAccountId]} → ${acc[t.toAccountId]}`), 'trasferimento', (t.cents / 100).toFixed(2).replace('.', ','), '', q(t.note), t.status].join(';'));
        saveBlob(`movimenti-${app.today}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
      },
    });
  }
  function confirmSheet({ title, text, label, word = null, run }) {
    api.openSheet({
      title, submit: label, danger: true,
      body: html`<div class="note">${text}</div>${word ? field('confirm', `Scrivi ${word} per confermare`, { attrs: 'autocapitalize="characters" required' }) : ''}`,
      onSubmit: async (v) => { if (word && String(v.confirm).trim().toUpperCase() !== word) throw new AppError('conferma', `Scrivi ${word} per confermare`); await run(); },
    });
  }

  // ───────────── Fatture ricorrenti, categorie, profilo fiscale, configurazione guidata ─────────────
  function templateSheet(t = null) {
    const accs = accOpts();
    api.openSheet({
      title: t ? 'Fattura ricorrente' : 'Nuova fattura ricorrente', submit: 'Salva',
      body: html`${field('client', 'Cliente', { value: t?.client ?? '', attrs: 'required maxlength="80"' })}
        ${moneyField('amount', 'Importo della fattura (netto che incassi)', t?.cents ?? null)}
        <div class="field-row">${field('day', 'Giorno di fatturazione', { value: String(t?.invoiceDay ?? 27), attrs: 'inputmode="numeric" required' })}${field('collect', 'Incasso dopo (giorni)', { value: String(t?.collectDays ?? 12), attrs: 'inputmode="numeric" required' })}</div>
        ${select('account', 'Conto di accredito', accs, t?.accountId ?? accs[0]?.[0])}
        ${moneyField('reserve', 'Riserva fiscale per questa fattura (tua regola)', t?.reserveCents ?? null, { required: false, hint: 'Es. 300 su 1.200. Il resto è disponibilità tua. Vuoto = si usa la stima teorica.' })}
        ${t ? html`<label class="check"><input type="checkbox" name="active" ${t.active !== false ? raw('checked') : ''}><span>Attiva (genera gli incassi attesi)</span></label>` : ''}
        <div class="note">Ogni mese compare un incasso <b>atteso</b> (non disponibile) alla data prevista. Quando arriva il bonifico tocca "Incassata ✓".</div>`,
      onSubmit: async (v) => {
        const day = Number(v.day), collect = Number(v.collect);
        const reserve = String(v.reserve ?? '').trim() ? money(v.reserve, 'Riserva', { zero: true }) : null;
        if (t) await api.commit((s, c) => C.updateInvoiceTemplate(s, c, t.id, { client: v.client, cents: money(v.amount), invoiceDay: day, collectDays: collect, accountId: v.account, active: v.active === 'on', reserveCents: reserve }));
        else await api.commit((s, c) => C.addInvoiceTemplate(s, c, { client: v.client, cents: money(v.amount), invoiceDay: day, collectDays: collect, accountId: v.account, reserveCents: reserve }));
      },
    });
  }
  function categorySheet(c = null) {
    api.openSheet({
      title: c ? 'Modifica categoria' : 'Nuova categoria', submit: 'Salva',
      body: html`${field('name', 'Nome', { value: c?.name ?? '', attrs: 'required maxlength="60"' })}
        ${c ? '' : segmented('kind', [['expense', 'Spesa'], ['income', 'Entrata']], 'expense')}
        ${c ? '' : select('parent', 'Sottocategoria di…', [['', 'Nessuna (categoria principale)'], ...st().categories.filter((x) => !x.parentId && x.kind === 'expense').map((x) => [x.id, x.name])], '', { hint: 'Una sottocategoria conta dentro la madre: nessun doppio conteggio.' })}
        ${labeled('Icona', emojiPicker('icon', c?.icon ?? '🏷️'))}${labeled('Colore', swatches('color', c?.color ?? 'gray'))}
        <label class="check"><input type="checkbox" name="inBudget" ${(c?.inBudget ?? true) ? raw('checked') : ''}><span>Conta nel budget settimanale (solo spese)</span></label>`,
      onSubmit: async (v) => {
        if (c) await api.commit((s, cx) => C.updateCategory(s, cx, c.id, { name: v.name, icon: v.icon, color: v.color, inBudget: v.inBudget === 'on' }));
        else await api.commit((s, cx) => C.addCategory(s, cx, { name: v.name, kind: v.kind, icon: v.icon, color: v.color, inBudget: v.inBudget === 'on', parentId: v.parent || null }));
      },
    });
  }
  function taxProfileSheet() {
    const tp = st().settings.taxProfile;
    const funds = st().funds.filter((f) => !f.archived).map((f) => [f.id, `${f.icon} ${f.name}`]);
    api.openSheet({
      title: 'Tasse e contributi', submit: 'Salva',
      body: html`<label class="check"><input type="checkbox" name="enabled" ${tp.enabled ? raw('checked') : ''}><span>Stima tasse e contributi su ogni incasso professionale</span></label>
        ${select('fund', 'Dove accantonare', funds, tp.fundId ?? funds[0]?.[0], { hint: 'Di solito un fondo sul conto dove versi le tasse (es. Trade Republic).' })}
        <div class="field-row">${field('coef', 'Coefficiente %', { value: pctStr(tp.coefficientBp), attrs: 'inputmode="decimal"' })}${field('inps', 'Contributi INPS %', { value: pctStr(tp.inpsBp), attrs: 'inputmode="decimal"' })}</div>
        ${field('tax', 'Imposta sostitutiva %', { value: pctStr(tp.taxBp), attrs: 'inputmode="decimal"' })}
        ${select('round', 'Arrotonda l\'accantonamento a', [['100', '1 €'], ['500', '5 €'], ['1000', '10 €'], ['5000', '50 €']], String(tp.roundStepCents))}
        ${select('ded', 'Contributi nel calcolo dell\'imposta', [['accrued', 'Maturati: imposta su (reddito − INPS)'], ['paid', 'Solo versati (più prudente)']], tp.inpsDeduction ?? 'accrued', { hint: 'Predefinito: imposta = (reddito − INPS) × aliquota. "Solo versati" deduce i contributi solo quando li hai pagati davvero.' })}
        <div class="note">Reddito = incasso × coefficiente · INPS = reddito × aliquota INPS · imposta = (reddito − INPS) × aliquota (metodo "maturati").</div>`,
      onSubmit: async (v) => {
        await api.commit((s, c) => C.setTaxProfile(s, c, { enabled: v.enabled === 'on', fundId: v.fund || null, coefficientBp: bpOf(v.coef, 'Coefficiente'), inpsBp: bpOf(v.inps, 'Contributi'), taxBp: bpOf(v.tax, 'Imposta'), roundStepCents: Number(v.round), inpsDeduction: v.ded || 'accrued' }));
      },
    });
  }
  function freelanceSetupSheet() {
    const accs = accOpts();
    if (!accs.length) { api.toast('Aggiungi prima almeno un conto', true); return; }
    api.openSheet({
      title: 'Profilo lavoratore autonomo', submit: 'Configura',
      body: html`<div class="note">Crea il fondo <b>Tasse e contributi</b> e attiva il calcolo forfettario (coefficiente 78%, INPS Gestione Separata 26,07%, imposta 5%): potrai cambiare ogni valore.</div>
        ${select('account', 'Su quale conto tieni gli accantonamenti per le tasse?', accs, accs[0][0], { hint: 'Scegli il conto dove versi ciò che togli dalle fatture.' })}
        ${moneyField('weekly', 'Budget settimanale per le spese (opzionale)', null, { required: false })}`,
      onSubmit: async (v) => { await api.commit((s, c) => C.setupFreelanceProfile(s, c, { taxAccountId: v.account, weeklyBudgetCents: v.weekly ? money(v.weekly, 'Budget') : 0 })); api.toast('Profilo attivato'); },
    });
  }
  function onboardingSheet() {
    api.openSheet({
      title: 'Configurazione guidata', submit: 'Crea i conti',
      body: html`<div class="note">Spunta le banche che usi e inserisci il saldo di oggi (puoi lasciarlo vuoto e aggiungerlo dopo). Colori e sigle sono già impostati; il logo vero lo carichi dopo da Conti e banche.</div>
        ${Object.entries(BANKS).map(([k, b]) => html`<div class="field-row"><label class="check"><input type="checkbox" name="b_${k}"><span class="row left">${tile({ color: b.color, icon: b.mono, size: 'sm' })}<b>${b.name}</b></span></label><label class="field"><input class="money sm" name="s_${k}" inputmode="decimal" placeholder="Saldo oggi" autocomplete="off"></label></div>`)}`,
      onSubmit: async (v) => {
        const picked = Object.entries(BANKS).filter(([k]) => v['b_' + k] === 'on');
        if (!picked.length) throw new AppError('vuoto', 'Seleziona almeno un conto');
        const opens = picked.map(([k]) => (String(v['s_' + k] ?? '').trim() ? money(v['s_' + k], 'Saldo', { zero: true }) : 0));
        await api.commit(async (s0, c) => {
          let cur = s0;
          for (let i = 0; i < picked.length; i++) { const [k, b] = picked[i]; cur = (await C.addAccount(cur, c, { name: b.name, bank: k, type: b.type, color: b.color, openingCents: opens[i], openingDate: c.today })).state; }
          return { state: cur, result: null };
        });
        api.toast('Conti creati');
        setTimeout(() => freelanceSetupSheet(), 250);
      },
    });
  }
  function reportSheet() {
    api.openSheet({
      title: 'Esporta statistiche e previsioni', submit: 'Crea file',
      body: html`<div class="note">File <b>CSV</b> (si apre in Numbers, Excel, Fogli). <b>Non sono cifrati</b>: contengono i tuoi dati in chiaro; conservali o condividili con attenzione.</div>
        <label class="field"><span>Cosa esportare</span><select name="what"><option value="stats">Statistiche mensili (incassi, spese, categorie, liquidità)</option><option value="fsum">Previsione: riepilogo per mese (entrate, uscite, saldi)</option><option value="fdet">Previsione: dettaglio di ogni movimento previsto</option></select></label>
        <label class="field"><span>Periodo</span><select name="months"><option value="6">6 mesi</option><option value="12" selected>12 mesi</option></select></label>
        <label class="check"><input type="checkbox" name="ack" required><span>Ho capito che il file non è cifrato</span></label>`,
      onSubmit: async (v) => {
        const n = Number(v.months), S = st();
        const [name, text] = v.what === 'stats' ? [`statistiche-${app.today}.csv`, statsCsv(S, app.today, n)] : v.what === 'fsum' ? [`previsione-mensile-${app.today}.csv`, forecastSummaryCsv(S, app.today, n)] : [`previsione-dettaglio-${app.today}.csv`, forecastDetailCsv(S, app.today, n)];
        const file = new File([text], name, { type: 'text/csv' });
        if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e?.name === 'AbortError') return; } }
        saveBlob(name, text, 'text/csv');
      },
    });
  }
  async function runPlannedNow() {
    const r = await api.commit((s, c) => C.runPlannedFunding(s, c, { force: true }));
    const sh = r.shortfalls ?? [];
    api.toast(sh.length ? `Riservati ${formatEuro(r.funded)} · non coperto: ${sh.map((x) => `${x.name} (${formatEuro(x.cents)})`).join(', ')}` : r.funded > 0 ? `Scadenze finanziate: ${formatEuro(r.funded)}` : 'Tutte le scadenze sono già coperte');
  }
  function icsSheet() {
    api.openSheet({
      title: 'Esporta nel Calendario', submit: 'Crea file calendario',
      body: html`<div class="note">Crea un file <b>.ics</b> con le tue scadenze (abbonamenti, rinnovi, PAC, fatture da emettere, incassi attesi, obiettivi), con avviso incluso. Aprendolo l'iPhone ti propone <b>Aggiungi al Calendario</b>: le notifiche le gestisce iOS, i dati restano tuoi.</div>
        <label class="check"><input type="checkbox" name="amounts"><span>Includi gli importi nei titoli (visibili nel Calendario e in iCloud, se sincronizzato)</span></label>`,
      onSubmit: async (v) => {
        const text = buildIcs(st(), { today: app.today, nowIso: new Date().toISOString(), includeAmounts: v.amounts === 'on' });
        const file = new File([text], 'scadenze-finanze.ics', { type: 'text/calendar' });
        if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Scadenze' }); return; } catch (e) { if (e?.name === 'AbortError') return; } }
        saveBlob('scadenze-finanze.ics', text, 'text/calendar');
      },
    });
  }
  function rebalance(accountId) {
    const sn = snap();
    const need = -sn.freeByAccount[accountId];
    const src = st().accounts.filter((a) => !a.archived && a.id !== accountId && sn.freeByAccount[a.id] > 0).sort((a, b) => sn.freeByAccount[b.id] - sn.freeByAccount[a.id])[0];
    if (!src) { api.toast('Nessun altro conto ha denaro libero da trasferire', true); return; }
    txSheet('transfer', { from: src.id, to: accountId, amount: Math.min(need, sn.freeByAccount[src.id]) });
  }

  // ───────────── Registro azioni ─────────────
  const byId = (coll, id) => st()[coll].find((x) => x.id === id);
  const actions = {
    'toggle-hide': () => { app.hide = !app.hide; document.body.classList.toggle('hide-amounts', app.hide); api.render(); },
    lock: () => api.lock(),
    'new-account': () => accountSheet(),
    'edit-account': (el) => accountSheet(byId('accounts', el.dataset.id)),
    'archive-account': (el) => confirmSheet({ title: 'Archivia conto', text: 'Il conto resta nello storico ma non sarà più selezionabile. Possibile solo con saldo zero.', label: 'Archivia', run: async () => { await api.commit((s, c) => C.archiveAccount(s, c, el.dataset.id)); } }),
    'new-tx': () => txSheet(),
    tx: (el) => txDetail(el.dataset.id),
    'edit-tx': (el) => txEdit(el.dataset.id),
    'void-tx': (el) => reasonSheet('Annulla movimento', 'Il movimento non viene cancellato: resta nello storico come annullato e non incide più sui saldi.', async (r) => { await api.commit((s, c) => C.voidTransaction(s, c, el.dataset.id, r)); api.toast('Movimento annullato'); }),
    transfer: (el) => transferDetail(el.dataset.id),
    'void-transfer': (el) => reasonSheet('Annulla trasferimento', 'Il trasferimento resta nello storico come annullato.', async (r) => { await api.commit((s, c) => C.voidTransfer(s, c, el.dataset.id, r)); }, 'Annulla trasferimento'),
    'set-filter': (el) => { app.ui[el.dataset.key] = el.dataset.v; app.ui.limit = 60; api.render(); },
    'toggle-void': () => { app.ui.showVoid = !app.ui.showVoid; api.render(); },
    'more-moves': () => { app.ui.limit += 60; api.render(); },
    'new-fund': () => fundSheet(),
    fund: (el) => fundDetail(el.dataset.id),
    assign: (el) => {
      const f = byId('funds', el.dataset.id);
      const opts = accOpts().map(([id, n]) => [id, `${n} · libero ${formatEuro(snap().freeByAccount[id])}`]);
      api.openSheet({ title: `Assegna a ${f.name}`, submit: 'Assegna (virtuale)', body: html`${select('account', 'Da quale conto', opts, f.accountId, { hint: 'Il denaro resta dov\'è: è un vincolo contabile, non un bonifico.' })}${moneyField('amount', 'Importo da vincolare')}`,
        onSubmit: async (v) => { await api.commit((s, cx) => C.assignToFund(s, cx, f.id, money(v.amount), '', v.account)); api.toast('Importo assegnato'); } });
    },
    release: (el) => {
      const f = byId('funds', el.dataset.id);
      const by = snap().funds[f.id].byAccount;
      const opts = Object.entries(by).filter(([, c]) => c > 0).map(([id, c]) => [id, `${st().accounts.find((a) => a.id === id)?.name} · riservati ${formatEuro(c)}`]);
      if (!opts.length) { api.toast('Il fondo non ha riserve da rilasciare', true); return; }
      api.openSheet({ title: `Rilascia da ${f.name}`, submit: 'Rilascia', body: html`${select('account', 'Su quale conto', opts, opts[0][0])}${moneyField('amount', 'Importo da liberare')}`,
        onSubmit: async (v) => { await api.commit((s, cx) => C.releaseFromFund(s, cx, f.id, money(v.amount), '', v.account)); api.toast('Importo rilasciato'); } });
    },
    'set-balance': (el) => balancesSheet(el.dataset.id),
    'update-balances': () => balancesSheet(),
    'confirm-planned': (el) => { const p = byId('planned', el.dataset.id); confirmSheet({ title: `Conferma: ${p.name}`, text: `È una voce attiva (${formatEuro(p.cents)})? Se la confermi entra nelle previsioni e negli avvisi. Se non è attiva viene annullata.`, label: 'Sì, è attiva', run: async () => { await api.commit((s, c) => C.confirmPlanned(s, c, p.id, true)); } }); },
    'tax-opening': () => {
      const y = Number(app.today.slice(0, 4)), o = st().settings.taxProfile.opening?.year === y ? st().settings.taxProfile.opening : null;
      api.openSheet({
        title: `Già maturato nel ${y}`, submit: 'Salva',
        body: html`<div class="note">Inserisci quanto hai <b>incassato</b> dal 1° gennaio fino al giorno indicato, cioè prima di cominciare a registrare qui: da quello l'app calcola <b>contributi INPS e imposta</b>. Se hai anche già <b>versato</b> qualcosa (INPS o acconti), aggiungilo sotto; se è il primo anno e non hai versato nulla, <b>lascia vuoto</b>. I movimenti dell'app fino a quel giorno non vengono contati due volte.</div>
          ${field('until', 'Fino al giorno (incluso)', { type: 'date', value: o?.untilDate ?? app.today, attrs: `min="${y}-01-01" max="${app.today}" required` })}
          ${moneyField('ricavi', 'Incassato (compensi ricevuti)', o?.ricaviCents ?? null, { required: false, hint: 'Conta solo ciò che ti è davvero arrivato: una fattura emessa ma non ancora pagata dal cliente non va inclusa (si tassa quando la incassi).' })}
          ${moneyField('inps', 'Contributi INPS già versati (facoltativo)', o?.inpsPaidCents ?? null, { required: false, hint: 'Lascia vuoto se non hai ancora versato nulla.' })}
          ${moneyField('imp', 'Imposta sostitutiva già versata (facoltativo)', o?.impostaPaidCents ?? null, { required: false, hint: 'Acconti già pagati. Il primo anno di solito è vuoto.' })}
          ${o ? html`<button type="button" class="btn danger block mt8" data-action="tax-opening-clear">Rimuovi questi dati</button>` : ''}`,
        onSubmit: async (v) => { await api.commit((s, c) => C.setTaxOpening(s, c, { year: y, untilDate: v.until, ricaviCents: money(v.ricavi, 'Incassato', { zero: true }), inpsPaidCents: money(v.inps, 'INPS', { zero: true }), impostaPaidCents: money(v.imp, 'Imposta', { zero: true }) })); api.toast('Dati salvati'); },
      });
    },
    'tax-opening-clear': () => { api.closeSheet?.(); confirmSheet({ title: 'Rimuovere i dati iniziali?', text: 'La stima tornerà a basarsi solo sui movimenti registrati nell\'app.', label: 'Rimuovi', run: async () => { await api.commit((s, c) => C.setTaxOpening(s, c, null)); } }); },
    'fee-calc': () => {
      const tp = st().settings.taxProfile;
      const rows = [['gross', 'Compenso'], ['base', `Reddito forfettario (${pctStr(tp.coefficientBp)}%)`], ['inps', `INPS Gestione Separata (${pctStr(tp.inpsBp)}%)`], ['imp', `Imposta sostitutiva (${pctStr(tp.taxBp)}% su reddito − INPS)`], ['tax', 'Totale tasse e contributi'], ['net', 'Netto in tasca'], ['pct', 'Peso delle tasse sul compenso']];
      api.openSheet({
        title: 'Calcolatrice compenso', submit: null, cancel: 'Chiudi',
        body: html`<div class="seg" role="radiogroup" aria-label="Modalità"><label><input type="radio" name="mode" value="gross" checked data-change="fee-calc" data-live><span>Ho il compenso</span></label><label><input type="radio" name="mode" value="net" data-change="fee-calc" data-live><span>Voglio il netto</span></label></div>
          <label class="field"><span id="fee-label">Compenso (€)</span><input class="money" name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" data-change="fee-calc" data-live></label>
          <div class="card"><div class="kv">${rows.map(([k, t]) => html`<span class="k ${k === 'net' ? 'strong' : ''}">${t}</span><span class="num ${k === 'net' ? 'strong' : ''}" data-fee="${k}">—</span>`)}</div></div>
          <div class="note">Stima con i parametri del tuo profilo fiscale (regime forfettario). Importi senza IVA. Non include marca da bollo né spese. "Voglio il netto" calcola il compenso minimo da chiedere per avere in tasca quella cifra.</div>`,
      });
    },
    'verify-rates': () => { const y = Number(app.today.slice(0, 4)); confirmSheet({ title: `Aliquote ${y} verificate?`, text: 'Conferma solo dopo aver controllato aliquota INPS Gestione Separata, coefficiente e imposta sostitutiva validi per l\'anno.', label: 'Le ho verificate', run: async () => { await api.commit((s, c) => C.verifyTaxRates(s, c, y)); } }); },
    'close-receivable': (el) => confirmSheet({ title: 'Chiudi con quanto incassato', text: 'La fattura diventa definitiva con il totale già incassato. La riserva accantonata fin qui resta com\'è.', label: 'Chiudi', run: async () => { await api.commit((s, c) => C.closeReceivable(s, c, el.dataset.id)); } }),
    'confirm-transfer': (el) => confirmTransferSheet({ fundId: el.dataset.fund, from: el.dataset.from, to: el.dataset.to, cents: Number(el.dataset.cents) }),
    'move-fund': (el) => {
      const f = byId('funds', el.dataset.id);
      const others = st().funds.filter((x) => !x.archived && x.id !== f.id).map((x) => [x.id, x.name]);
      if (!others.length) { api.toast('Serve un altro fondo', true); return; }
      api.openSheet({ title: `Sposta da ${f.name}`, submit: 'Sposta', body: html`${select('to', 'Verso il fondo', others, others[0][0])}${moneyField('amount', 'Importo', null, { hint: `Disponibile: ${formatEuro(snap().funds[f.id].available)}. Resta sullo stesso conto (virtuale).` })}`, onSubmit: async (v) => { await api.commit((s, c) => C.moveBetweenFunds(s, c, f.id, v.to, money(v.amount))); api.toast('Fondi aggiornati'); } });
    },
    'edit-fund': (el) => {
      const f = byId('funds', el.dataset.id);
      api.openSheet({ title: 'Modifica fondo', submit: 'Salva', body: html`${field('name', 'Nome', { value: f.name, attrs: 'required maxlength="80"' })}${labeled('Icona', emojiPicker('icon', f.icon))}${labeled('Colore', swatches('color', f.color))}${f.kind === 'goal' ? html`${moneyField('target', 'Importo obiettivo', f.goal.targetCents)}<div class="field-row">${select('priority', 'Priorità', PRIORITY, String(f.goal.priority))}${field('deadline', 'Scadenza', { type: 'date', value: f.goal.deadline ?? '' })}</div>` : ''}${select('refill', 'Reintegro automatico', [['', 'Nessuno'], ...st().funds.filter((x) => !x.archived && x.kind === 'goal' && x.id !== f.id).map((x) => [x.id, x.name])], f.refillFundId ?? '', { hint: 'Quando paghi una spesa direttamente da questo fondo, l\'obiettivo del fondo scelto aumenta dello stesso importo: è quanto dovrai rimettere.' })}`,
        onSubmit: async (v) => { await api.commit((s, c) => C.updateFund(s, c, f.id, { name: v.name, icon: v.icon, color: v.color, refillFundId: v.refill || null, ...(f.kind === 'goal' ? { goal: { targetCents: money(v.target), priority: Number(v.priority), deadline: optDate(v.deadline) } } : {}) })); } });
    },
    'relocate-fund': (el) => {
      const f = byId('funds', el.dataset.id);
      const others = accOpts().filter(([id]) => id !== f.accountId);
      if (!others.length) { api.toast('Serve un altro conto', true); return; }
      const parts = Object.entries(snap().funds[f.id].byAccount).filter(([, c]) => c > 0).map(([id, c]) => [byId('accounts', id), c]);
      api.openSheet({
        title: `Sposta "${f.name}" su un altro conto`, submit: 'Confermo i bonifici e sposto',
        body: html`${select('to', 'Nuovo conto', others, others[0][0])}
          <div class="field"><span>Quali parti hai già spostato con un bonifico?</span>${parts.map(([a, c]) => html`<label class="check"><input type="checkbox" name="mv_${a.id}" checked><span>Quella su <b>${a.name}</b>: ${formatEuro(c)}</span></label>`)}
          <small class="hint">Spunta solo ciò che hai <b>davvero bonificato</b> sul nuovo conto. La parte che già si trova sul nuovo conto non serve e viene ignorata; ciò che lasci senza spunta resta riservato dov'è e comparirà come "bonifico da fare".</small></div>
          <div class="note">Per ogni parte spuntata registro <b>un bonifico reale</b> dal suo conto verso il nuovo (non un unico bonifico dell'importo totale). Il conto di riferimento del fondo cambia${f.kind === 'budget' ? ' e con lui il conto spese del budget' : ''}.</div>`,
        onSubmit: async (v) => {
          const onlyFrom = parts.filter(([a]) => v['mv_' + a.id] === 'on').map(([a]) => a.id);
          await api.commit((s, c) => C.relocateFund(s, c, f.id, v.to, { onlyFrom }));
          api.toast('Fondo spostato');
        },
      });
    },
    'close-fund': (el) => { const f = byId('funds', el.dataset.id); confirmSheet({ title: 'Chiudi fondo', text: `Il disponibile (${formatEuro(snap().funds[f.id].available)}) torna al denaro libero. Il fondo resta nello storico.`, label: 'Chiudi fondo', run: async () => { await api.commit((s, c) => C.closeFund(s, c, f.id)); } }); },
    'new-receivable': () => (accOpts().length ? receivableSheet() : api.toast('Aggiungi prima un conto', true)),
    receivable: (el) => receivableSheet(byId('receivables', el.dataset.id)),
    receive: (el) => receiveSheet(el.dataset.id),
    'cancel-receivable': (el) => reasonSheet('Annulla incasso atteso', 'L\'incasso non verrà più considerato.', async (r) => { await api.commit((s, c) => C.cancelReceivable(s, c, el.dataset.id, r)); }, 'Annulla incasso'),
    'new-planned': () => (accOpts().length ? plannedSheet() : api.toast('Aggiungi prima un conto', true)),
    planned: (el) => plannedSheet(byId('planned', el.dataset.id)),
    'complete-planned': (el) => completePlannedSheet(el.dataset.id),
    'cancel-planned': (el) => reasonSheet('Annulla acquisto', 'Il fondo dedicato (se presente) verrà chiuso e il residuo tornerà libero.', async (r) => { await api.commit((s, c) => C.cancelPlanned(s, c, el.dataset.id, r)); }, 'Annulla acquisto'),
    'toggle-expected': () => { app.ui.showExpected = !app.ui.showExpected; api.render(); },
    'budget-fund-setup': () => {
      const opts = accOpts();
      if (!opts.length) { api.toast('Aggiungi prima un conto', true); return; }
      api.openSheet({ title: 'Finanzia il budget', submit: 'Attiva',
        body: html`${select('account', 'Da quale conto si spende il budget?', opts, opts[0][0], { hint: 'Di solito il conto delle spese quotidiane. Il denaro del budget resta lì, ma viene riservato ogni settimana.' })}
          <div class="note">Ogni lunedì (quando apri l'app) viene riservato l'importo del budget dal <b>denaro libero</b> di quel conto. Se non basta, finanzia quello che c'è e ti avvisa. Puoi disattivarlo quando vuoi.</div>`,
        onSubmit: async (v) => {
          await api.commit((s, c) => C.setupBudgetFund(s, c, { accountId: v.account }));
          const r = await api.commit((s, c) => C.runBudgetFunding(s, c, { force: true }));
          api.toast(r.skipped === 'saldo_da_aggiornare' ? 'Attivo: aggiorna il saldo del conto per finanziarlo' : r.shortfall > 0 ? `Finanziati ${formatEuro(r.funded)} · mancano ${formatEuro(r.shortfall)}` : `Budget finanziato: ${formatEuro(r.funded)} riservati`);
        } });
    },
    'budget-fund-now': async () => {
      const r = await api.commit((s, c) => C.runBudgetFunding(s, c, { force: true }));
      api.toast(r.skipped === 'saldo_da_aggiornare' ? 'Aggiorna prima il saldo del conto spese' : r.funded > 0 ? `Riservati altri ${formatEuro(r.funded)}${r.shortfall > 0 ? ` · mancano ancora ${formatEuro(r.shortfall)}` : ''}` : r.shortfall > 0 ? `Nessun denaro libero: mancano ${formatEuro(r.shortfall)}` : 'Il budget è già finanziato');
    },
    'planned-funding': () => {
      const pf = st().settings.plannedFunding;
      api.openSheet({
        title: 'Scadenze finanziate in anticipo', submit: 'Salva',
        body: html`<label class="check"><input type="checkbox" name="enabled" ${pf.enabled ? raw('checked') : ''}><span>Riserva in anticipo il denaro delle scadenze</span></label>
          ${select('horizon', 'Quanto in anticipo', [['15', '15 giorni'], ['30', '30 giorni'], ['45', '45 giorni'], ['60', '60 giorni'], ['90', '90 giorni']], String(pf.horizonDays))}
          ${select('src', 'Conto predefinito da cui accantonare', [['', 'Il conto di pagamento di ogni voce'], ...accOpts()], pf.sourceAccountId ?? '', { hint: 'Ogni voce può avere un conto diverso: lo scegli nella singola scadenza.' })}
          <div class="note">Il denaro resta dov'è: è un vincolo. Se il conto da cui accantoni è diverso da quello di pagamento compare il <b>bonifico da confermare</b>: appena lo confermi, la somma è sul conto di pagamento ma resta <b>riservata</b> a quella scadenza (non diventa liberamente spendibile). Per i versamenti automatici (PAC) l'addebito viene registrato da solo alla scadenza <b>solo se il denaro è arrivato</b>.</div>`,
        onSubmit: async (v) => {
          await api.commit((s, c) => C.setPlannedFunding(s, c, { enabled: v.enabled === 'on', horizonDays: Number(v.horizon), sourceAccountId: v.src || null }));
          if (v.enabled === 'on') await runPlannedNow();
        },
      });
    },
    'planned-funding-now': () => runPlannedNow(),
    'budget-account-set': async (el) => {
      await api.commit((s, c) => C.setBudgetAccount(s, c, { accountId: el.dataset.acc }));
      api.closeSheet?.(); api.toast('Conto spese del budget cambiato');
    },
    'budget-account': () => {
      const b = st().settings.budget;
      const opts = accOpts().filter(([id]) => id !== b.accountId && !(b.advanceWeeks > 0 && id === b.sourceAccountId));
      if (!opts.length) { api.toast('Nessun altro conto disponibile', true); return; }
      api.openSheet({
        title: 'Conto spese del budget', submit: 'Cambia',
        body: html`<div class="note">È il conto da cui spendi: qui sta la <b>settimana corrente</b>. Cambia solo il riferimento: <b>non registra nessun bonifico</b>. Le riserve già presenti su altri conti restano dove sono e, se servono qui, compare il "bonifico da fare".</div>
          ${select('acc', 'Nuovo conto spese', opts, opts[0][0])}`,
        onSubmit: async (v) => { await api.commit((s, c) => C.setBudgetAccount(s, c, { accountId: v.acc })); api.toast('Conto spese cambiato'); },
      });
    },
    'budget-advance': () => {
      const b = st().settings.budget;
      const others = accOpts().filter(([id]) => id !== b.accountId);
      if (!others.length) { api.toast('Serve un secondo conto come appoggio', true); return; }
      api.openSheet({
        title: 'Settimane finanziate in anticipo', submit: 'Salva',
        body: html`<div class="note">Oltre alla settimana corrente, l'app riserva ${formatEuro(b.weeklyCents)} per ciascuna delle prossime settimane dal <b>denaro libero del conto di appoggio</b>. Il denaro resta dov'è (nessun bonifico finché non lo fai): serve a non allocarlo altrove. Ogni lunedì ti propone <b>un solo bonifico</b>, quello della settimana che comincia.</div>
          ${select('weeks', 'Settimane in anticipo', [['0', 'Nessuna'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], String(b.advanceWeeks ?? 0))}
          ${select('src', 'Conto di appoggio', others, b.sourceAccountId ?? others[0][0], { hint: 'Di solito il conto dove arrivano gli incassi.' })}`,
        onSubmit: async (v) => {
          await api.commit((s, c) => C.setBudgetAdvance(s, c, { weeks: Number(v.weeks), sourceAccountId: Number(v.weeks) > 0 ? v.src : null }));
          const r = await api.commit((s, c) => C.runBudgetFunding(s, c, { force: true }));
          api.toast(r.shortfall > 0 ? `Riservati ${formatEuro(r.funded)} · mancano ${formatEuro(r.shortfall)}` : r.funded > 0 ? `Riservati altri ${formatEuro(r.funded)}` : 'Salvato');
        },
      });
    },
    'budget-fund-off': () => confirmSheet({ title: 'Disattiva il finanziamento', text: 'Il denaro riservato per il budget torna libero e il budget resta un semplice tetto di spesa.', label: 'Disattiva', run: async () => { await api.commit((s, c) => C.disableBudgetFund(s, c)); } }),
    'edit-budget': budgetSheet, 'edit-tax': taxSheet, 'edit-lock': lockSheet, 'change-password': passwordSheet,
    'new-reconciliation': reconciliationSheet,
    'resolve-rec': (el) => confirmSheet({ title: 'Registra rettifica', text: 'Verrà creato un movimento di rettifica tracciato per allineare il saldo alla banca. Controlla prima di non avere dimenticato movimenti.', label: 'Registra rettifica', run: async () => { await api.commit((s, c) => C.resolveReconciliation(s, c, el.dataset.id)); } }),
    recheck: () => api.refreshIntegrity(true),
    'more-history': () => { app.ui.histLimit += 60; api.render(); },
    'export-backup': exportBackupSheet,
    'verify-backup': () => restoreSheet({ verifyOnly: true }),
    'restore-backup': () => restoreSheet(),
    'export-csv': csvSheet,
    'share-backup': async () => {
      const b = app.pendingBackup; if (!b) return;
      const file = new File([b.text], b.filename, { type: 'application/octet-stream' });
      try {
        if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Backup finanze' }); }
        else { saveBlob(b.filename, b.text, 'application/octet-stream'); }
        await api.commit((s, c) => C.markBackup(s, c));
        api.toast('Backup esportato');
      } catch (e) { if (e?.name !== 'AbortError') api.toast('Condivisione non riuscita: usa "Scarica il file"', true); }
    },
    'download-backup': async () => { const b = app.pendingBackup; if (!b) return; saveBlob(b.filename, b.text, 'application/octet-stream'); await api.commit((s, c) => C.markBackup(s, c)); api.toast('File scaricato'); },
    'clear-demo': () => confirmSheet({ title: 'Elimina dati dimostrativi', text: 'Conti, movimenti e fondi fittizi verranno eliminati. Potrai iniziare con i tuoi dati.', label: 'Elimina dati demo', run: async () => { await api.commit((s, c) => C.clearDemoData(s, c)); api.nav('overview'); } }),
    'wipe-all': () => confirmSheet({ title: 'Cancella tutto', text: 'Elimina archivio, chiavi e copie interne da questo dispositivo. IRREVERSIBILE, a meno di avere un backup.', label: 'Cancella tutto', word: 'CANCELLA', run: async () => { await api.wipe(); } }),
    'open-restore-setup': () => restoreSheet({ atSetup: true }),
    'new-template': () => (accOpts().length ? templateSheet() : api.toast('Aggiungi prima un conto', true)),
    template: (el) => templateSheet(byId('invoiceTemplates', el.dataset.id)),
    'new-category': () => categorySheet(),
    'edit-category': (el) => categorySheet(byId('categories', el.dataset.id)),
    'edit-tax-profile': taxProfileSheet,
    'freelance-setup': freelanceSetupSheet,
    onboarding: onboardingSheet,
    'export-ics': icsSheet,
    rebalance: (el) => rebalance(el.dataset.id),
    'open-situation': (el) => {
      const t = app.today, y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
      const eom = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-${String(new Date(yy, mm, 0).getDate()).padStart(2, '0')}`;
      app.ui.situationUntil = el.dataset.v === 'eom' ? eom(y, m) : el.dataset.v === 'eom2' ? (m === 12 ? eom(y + 1, 1) : eom(y, m + 1)) : `${y}-12-31`;
      if (app.ui.situationUntil <= t) app.ui.situationUntil = el.dataset.v === 'dec' ? `${y + 1}-12-31` : eom(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
      location.hash = '#/situation'; api.render();
    },
    'export-ai': () => {
      api.openSheet({
        title: 'Esporta situazione per ChatGPT', submit: 'Crea file',
        body: html`<div class="note">Crea <b>un unico file JSON</b> con la fotografia dell'app: saldi, fondi, incassi, spese, movimenti e proiezioni già calcolate. Non aggiunge calcoli e non esporta password, chiavi o IBAN. <b>Il file non è cifrato</b> e contiene anche le note che hai scritto sui movimenti: condividilo solo dove vuoi che arrivi.</div>
          <label class="check"><input type="checkbox" name="ack" required><span>Ho capito che il file non è cifrato</span></label>`,
        onSubmit: async () => {
          const name = `situazione-chatgpt-${app.today}.json`;
          const text = aiExportJson(st(), { today: app.today, nowIso: new Date().toISOString(), appVersion: app.version });
          const file = new File([text], name, { type: 'application/json' });
          if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e?.name === 'AbortError') return; } }
          saveBlob(name, text, 'application/json');
        },
      });
    },
    'export-situation': () => {
      const until = app.ui.situationUntil ?? app.today;
      api.openSheet({
        title: 'Esporta la situazione', submit: 'Crea file',
        body: html`<div class="note">File <b>CSV</b> con ogni entrata e uscita prevista, il libero dopo ciascuna e se è coperta. <b>Non è cifrato</b>.</div><label class="check"><input type="checkbox" name="ack" required><span>Ho capito che il file non è cifrato</span></label>`,
        onSubmit: async () => {
          const name = `situazione-${app.today}-${until}.csv`, text = situationCsv(st(), app.today, until);
          const file = new File([text], name, { type: 'text/csv' });
          if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e?.name === 'AbortError') return; } }
          saveBlob(name, text, 'text/csv');
        },
      });
    },
    'set-range': (el) => { app.ui.analysisRange = Number(el.dataset.v); api.render(); },
    'chart-month': (el) => { app.ui.analysisMonth = el.dataset.v; api.render(); },
    'export-report': reportSheet,
    'set-analysis': (el) => { app.ui.analysisMonth = el.dataset.v; api.render(); },
  };

  // Moduli non-sheet (setup, sblocco, calcolo suggerimento)
  const forms = {
    'alloc-suggest': async (v) => {
      const cents = v.amount ? money(v.amount) : Math.max(0, snap().freeByAccount[v.account]);
      app.ui.allocAccount = v.account;
      allocationSheet(v.account, cents);
    },
  };
  const changes = {
    'alloc-account': (el) => { app.ui.allocAccount = el.value; api.render(); },
    'account-bank': (el) => {
      const b = BANKS[el.value]; const f = el.form; if (!b) return;
      const known = Object.values(BANKS).map((x) => x.name);
      if (!f.elements.name.value || known.includes(f.elements.name.value)) f.elements.name.value = b.name;
      f.elements.type.value = b.type;
    },
    'receivable-amount': (el) => {
      const note = el.closest('form').querySelector('#amount-note'); if (!note) return;
      const cur = parseEuro(el.value); const orig = Number(el.dataset.orig);
      note.classList.toggle('on', cur != null && Number.isFinite(orig) && cur !== orig);
    },
    'fee-calc': (el) => {
      const f = el.form, tp = st().settings.taxProfile, mode = f.elements.mode.value;
      f.querySelector('#fee-label').textContent = mode === 'net' ? 'Netto che vuoi ottenere (€)' : 'Compenso (€)';
      const v = parseEuro(f.elements.amount.value);
      const set = (k, text) => { const n = f.querySelector(`[data-fee="${k}"]`); if (n) n.textContent = text; };
      if (v == null || v <= 0) { for (const k of ['gross', 'base', 'inps', 'imp', 'tax', 'net', 'pct']) set(k, '—'); return; }
      const gross = mode === 'net' ? grossForNet(v, tp) : v;
      const t = estimateTaxes(gross, tp);
      set('gross', formatEuro(gross)); set('base', formatEuro(t.base)); set('inps', formatEuro(t.inps)); set('imp', formatEuro(t.imposta));
      set('tax', formatEuro(t.total)); set('net', formatEuro(t.netAfter)); set('pct', (t.total / gross * 100).toFixed(1).replace('.', ',') + '%');
    },
    'tx-budget-hint': (el) => {
      const f = el.form; if (!f) return;
      const box = f.querySelector('#budget-hint'); if (!box) return;
      const S = st(), b = S.settings.budget;
      const isExpense = (f.dataset.kind ?? 'expense') === 'expense';
      const set = (txt, cls) => { box.textContent = txt; box.className = `small only-expense ${cls}`; };
      if (!isExpense || !b.fundId || b.weeklyCents <= 0) { set('', ''); return; }
      const acc = f.elements.account?.value, cat = f.elements.catExpense?.value, fund = f.elements.fund?.value;
      const name = (id) => S.accounts.find((a) => a.id === id)?.name ?? '';
      const bs = budgetStatus(S, app.today);
      if (fund) set('Pagata dal fondo scelto: non consuma il budget settimanale.', 'muted');
      else if (S.categories.find((c) => c.id === cat)?.inBudget === false) set('Categoria fuori dal budget settimanale: non lo consuma.', 'muted');
      else if (acc !== b.accountId) set(`Questo non è il conto spese del budget (${name(b.accountId)}): non consumerà la settimana corrente.`, 'warn-t');
      else set(`Conta nel budget settimanale: consuma la settimana corrente (restano ${formatEuro(bs.remainingCents)}).`, 'pos');
    },
    'situation-date': (el) => { if (el.value) { app.ui.situationUntil = el.value; api.render(); } },
    'reserve-choice': (el) => { const i = el.form.elements.a0; if (i) i.value = el.dataset.amount; },
    'planned-kind': (el) => {
      const [rec, mode, cat] = PKIND_DEF[el.value]; const f = el.form;
      f.elements.recurrence.value = rec; f.elements.fundMode.value = mode; f.elements.category.value = cat;
    },
    'logo-pick': async (el) => {
      const file = el.files?.[0]; if (!file) return;
      try {
        const bmp = await createImageBitmap(file);
        let url = '';
        for (const size of [96, 64, 48]) {
          const cv = document.createElement('canvas'); cv.width = cv.height = size;
          const g = cv.getContext('2d'); const m = Math.min(bmp.width, bmp.height);
          g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
          g.drawImage(bmp, (bmp.width - m) / 2, (bmp.height - m) / 2, m, m, 0, 0, size, size);
          url = cv.toDataURL('image/png');
          if (url.length <= MAX_LOGO_CHARS) break;
        }
        if (url.length > MAX_LOGO_CHARS) throw new Error('troppo grande');
        el.form.elements.logoData.value = url;
        const prev = el.closest('.logo-row')?.querySelector('.tile');
        if (prev) { const im = document.createElement('img'); im.alt = ''; im.src = url; prev.replaceChildren(im); }
        api.toast('Logo pronto: premi Salva');
      } catch { api.toast('Immagine non utilizzabile', true); }
    },
  };
  return { actions, forms, changes, helpers: { allocationSheet, restoreSheet, restoreConfirmSheet, buildDemoState, runIntegrityChecks } };
}
