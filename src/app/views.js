// Schermate (funzioni pure: stato → HTML sicuro). Nessuna mutazione qui.
import { html, raw } from './html.js';
import { I } from './icons.js';
import { amt, empty, pill, bar, pctOf, accountTile, fundTile, catTile } from './ui.js';
import { flowChart, balanceChart, cashflowChart, budgetChart, stackedChart } from './charts.js';
import { situationAt, monthlyReport, balanceHistory, categoryTrend, weeklyBudget, kpis, cashflowByMonth, monthLabel } from '../core/reports.js';
import { monthlySeries, categoryBreakdown, investedTotal } from '../core/analytics.js';
import { estimateTaxes, taxLedger } from '../core/tax.js';
import { monthlyPace } from '../core/allocation.js';
import { BANKS } from '../core/palette.js';
import { snapshot, fundNeed, pendingTransfers, reserveProgress, fundProgress, childFunds } from '../core/derive.js';
import { budgetStatus } from '../core/budget.js';
import { forecast, expandPlanned } from '../core/forecast.js';
import { formatEuro } from '../core/money.js';
import { formatDate, formatDateLong, diffDays, addDays as addDaysD } from '../core/dates.js';

const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
const KIND_LABEL = { goal: 'Obiettivo', tax: 'Fiscale', planned: 'Acquisto', reserve: 'Riserva', budget: 'Budget' };
const ACC_LABEL = { checking: 'Conto corrente', savings: 'Risparmio', cash: 'Contanti', other: 'Altro' };

export const topbar = (title, sub = '', actions = '') => html`<div class="topbar"><div><h1>${title}</h1>${sub ? html`<div class="sub">${sub}</div>` : ''}</div><div class="actions">${actions}</div></div>`;
const when = (d, today) => { const n = diffDays(d, today); return n === 0 ? 'oggi' : n === 1 ? 'domani' : n === -1 ? 'ieri' : n > 0 ? `tra ${n} gg` : `${-n} gg fa`; };

// ───────────────────────────── Panoramica ─────────────────────────────
const KIND_ICON = { subscription: '🔁', renewal: '📅', investment: '📈', purchase: '🛍️', extraordinary: '💸' };
export const RECUR_LABEL = { none: 'una tantum', weekly: 'ogni settimana', monthly: 'ogni mese', quarterly: 'ogni 3 mesi', yearly: 'ogni anno' };

/** Elementi da pagare/incassare a breve (scaduti o entro `days` giorni). */
export function dueItems(st, today, days = 7) {
  const out = [];
  const horizon = addDaysStr(today, days);
  for (const p of st.planned.filter((x) => x.status === 'planned' && !x.confirm && addDaysStr(x.dueDate, -(x.leadDays ?? 0)) <= horizon)) out.push({ type: 'pay', id: p.id, date: p.dueDate, title: p.name, cents: -p.cents, sub: `${p.autoPay ? 'Addebito automatico' : 'Da pagare'}${p.recurrence !== 'none' ? ' · ' + RECUR_LABEL[p.recurrence] : ''}${p.leadDays ? ` · soldi sul conto entro il ${formatDate(addDaysStr(p.dueDate, -p.leadDays))}` : ''}`, late: p.dueDate < today, auto: p.autoPay, icon: KIND_ICON[p.kind] });
  for (const r of st.receivables.filter((x) => (x.status === 'expected' || x.status === 'partial') && x.expectedDate <= addDaysStr(today, Math.min(days, 3)))) out.push({ type: 'in', id: r.id, date: r.expectedDate, title: r.client, cents: r.expectedCents - (r.receivedCents ?? 0), sub: `${r.status === 'partial' ? 'Residuo da incassare' : r.expectedDate < today ? 'Incasso in ritardo' : 'Incasso previsto'} · da confermare`, late: r.expectedDate < today, icon: '💶' });
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function moneyMap(app, snap) {
  const st = app.state;
  const funds = st.funds.filter((f) => !f.archived);
  const name = (id) => st.accounts.find((x) => x.id === id)?.name ?? '—';
  const active = st.accounts.filter((a) => !a.archived);
  // Un blocco per conto ("tasca"). I conti della stessa banca (es. Tasse + PAC) si raggruppano sotto un'unica intestazione.
  const block = (a, nested = false) => {
    const bal = snap.balances[a.id], free = snap.freeByAccount[a.id];
    const inv = a.type === 'investment';
    const at = (f) => snap.funds[f.id].byAccount[a.id] ?? 0;       // quanto di QUESTO conto è riservato al fondo (virtuale)
    const fl = inv ? [] : funds.filter((f) => at(f) > 0 || (f.accountId === a.id && (f.kind === 'goal' || f.kind === 'tax')));
    const denom = Math.max(bal, fl.reduce((t, f) => t + Math.max(0, at(f)), 0), 1);
    const w = (c) => ((Math.max(0, c) / denom) * 100).toFixed(1);
    return html`<div class="${nested ? 'pocket' : 'acct'}">
      <button class="head" data-action="edit-account" data-id="${a.id}">${accountTile(a, nested ? 'sm' : '')}<div class="grow"><div class="t">${a.name}</div><div class="small muted">${a.role ?? (inv ? 'Investito' : 'Saldo bancario')}</div></div><div class="bal num">${a.balanceUnknown ? pill('Da aggiornare', 'warn') : amt(bal)}</div></button>
      ${a.balanceUnknown ? html`<div class="row between small"><span class="muted">Saldo non ancora inserito</span><button class="btn sm primary inline" data-action="set-balance" data-id="${a.id}">Imposta saldo</button></div>` : ''}
      ${inv ? html`<div class="frow"><span class="dotc col-navy"></span><span class="nm">Investito · non è liquidità</span><span class="am num">${a.balanceUnknown ? 'da aggiornare' : amt(bal)}</span></div>` : html`
      ${!a.balanceUnknown && (bal > 0 || fl.length) ? html`<div class="map-bar" aria-hidden="true">${fl.map((f) => html`<i class="col-${f.color}" data-w="${w(at(f))}"></i>`)}<i class="free" data-w="${w(free)}"></i></div>` : ''}
      ${fl.map((f) => html`<button class="frow" data-action="fund" data-id="${f.id}"><span class="dotc col-${f.color}"></span><span class="nm ellipsis">${f.icon} ${f.name}${f.accountId !== a.id && at(f) > 0 ? html` ${pill('da trasferire a ' + name(f.accountId), 'warn')}` : ''}</span><span class="am num">${amt(at(f))}</span></button>`)}
      <div class="frow ${a.balanceUnknown ? '' : free < 0 ? 'bad' : 'free'}"><span class="dotc ${a.balanceUnknown ? 'col-gray' : free < 0 ? 'col-red' : 'col-green'}"></span><span class="nm">${a.balanceUnknown ? 'Libero da spendere' : free < 0 ? 'Vincolato oltre il saldo' : 'Libero da spendere'}</span><span class="am num">${a.balanceUnknown ? 'da aggiornare' : amt(free)}</span></div>`}
    </div>`;
  };
  const groups = [];
  for (const a of active) {
    const g = a.bank ? groups.find((x) => x.bank === a.bank) : null;
    if (g) g.items.push(a); else groups.push({ bank: a.bank, items: [a] });
  }
  return html`<section class="card">
    <h2>Dove sono i tuoi soldi <span><button class="link-btn small" data-action="update-balances">Aggiorna saldi</button> <button class="link-btn small" data-action="new-account">+ Conto</button></span></h2>
    ${active.length === 0 ? html`${empty('Nessun conto', 'Parti dalla configurazione guidata o aggiungi un conto.')}<div class="btn-row"><button class="btn primary" data-action="onboarding">Configurazione guidata</button><button class="btn" data-action="new-account">Nuovo conto</button></div>` : groups.map((g) => g.items.length === 1 ? block(g.items[0]) : html`<div class="acct group">
      <div class="group-head">${accountTile(g.items[0])}<div class="grow"><div class="t">${BANKS[g.bank]?.name ?? 'Banca'}</div><div class="small muted">${g.items.length} tasche · totale</div></div><div class="bal num">${g.items.some((a) => a.balanceUnknown) ? pill('Da aggiornare', 'warn') : amt(g.items.reduce((t, a) => t + snap.balances[a.id], 0))}</div></div>
      <div class="pockets">${g.items.map((a) => block(a, true))}</div></div>`)}
  </section>`;
}

/** Accantonamenti virtuali la cui riserva sta su un conto diverso da quello di riferimento del fondo. */
export function pendingCard(app, snap) {
  const st = app.state;
  const list = pendingTransfers(st, snap);
  if (!list.length) return '';
  const nm = (id) => st.accounts.find((x) => x.id === id)?.name ?? '—';
  return html`<section class="card"><h2>Bonifici da confermare <span class="pill warn">${list.length}</span></h2>
    <div class="small muted mt0">Sono accantonamenti <b>virtuali</b>: il denaro è ancora sul conto di origine. Quando fai il bonifico in banca, confermalo qui: solo allora viene registrato.</div>
    ${list.map((p) => { const f = st.funds.find((x) => x.id === p.fundId); return html`<div class="dueitem"><span class="tile sm col-${f.color}">${f.icon}</span><div class="grow"><div class="t ellipsis">${f.name}</div><div class="s small muted">${nm(p.fromAccountId)} → ${nm(p.toAccountId)}${(() => { const pl = st.planned.find((x) => x.fundId === p.fundId && x.status === 'planned'); return pl ? ` · per "${pl.name}" entro il ${formatDate(addDaysStr(pl.dueDate, -(pl.leadDays ?? 0)))}` : ''; })()}</div></div><div class="r num">${amt(p.cents)}</div><button class="btn sm primary inline" data-action="confirm-transfer" data-fund="${p.fundId}" data-from="${p.fromAccountId}" data-to="${p.toAccountId}" data-cents="${p.cents}">Bonifico fatto</button></div>`; })}
  </section>`;
}

/** Riga "finanziamento" del budget: quanto è riservato davvero rispetto a quanto serve questa settimana. */
function budgetFundLine(st, snap, bs) {
  const b = st.settings.budget;
  if (!b.fundId) return html`<div class="note">Il budget è solo un <b>tetto di spesa</b>: non riserva denaro. <button class="link-btn small" data-nav="settings/budget">Finanzialo come un fondo</button></div>`;
  const have = snap.funds[b.fundId]?.available ?? 0;
  const need = Math.max(0, bs.remainingCents);
  const short = Math.max(0, need + (b.advanceWeeks ?? 0) * b.weeklyCents - have);
  const acc = st.accounts.find((a) => a.id === b.accountId);
  return short > 0
    ? html`<div class="alert">${I.warn}<span class="grow">Budget <b>non del tutto finanziato</b>: riservati ${formatEuro(have)} su ${formatEuro(need)} (mancano ${formatEuro(short)}${acc?.balanceUnknown ? ': aggiorna il saldo di ' + acc.name : ' nel denaro libero di ' + (acc?.name ?? 'conto spese')}).</span><button class="btn sm primary inline" data-action="budget-fund-now">Finanzia ora</button></div>`
    : html`<div class="small muted mt8">🧺 Finanziato: ${formatEuro(have)} riservati${b.advanceWeeks ? ` (settimana corrente + ${Math.min(b.advanceWeeks, Math.floor(Math.max(0, have - need) / Math.max(1, b.weeklyCents)))} di ${b.advanceWeeks} in anticipo)` : ` sul conto ${acc?.name ?? ''}`} · non sono liberi da spendere altrove.</div>`;
}

const flowLegend = () => html`<div class="legend"><span><i class="lg-inc"></i>Incassi</span><span><i class="lg-exp"></i>Spese</span><span><i class="lg-tax"></i>Riserva fiscale</span><span><i class="lg-inv"></i>Investito</span><span><i class="lg-net"></i>Disponibile</span></div>`;

export function earningsCard(app) {
  const st = app.state;
  const series = monthlySeries(st, app.today, 6);
  const cur = series.at(-1);
  const spent = cur.expense, tax = cur.tax, net = cur.income - tax - spent;
  const base = Math.max(cur.income, spent + tax, 1);
  const w = (c) => ((Math.max(0, c) / base) * 100).toFixed(1);
  const per100 = (c) => (cur.income > 0 ? Math.round((c / cur.income) * 100) : 0);
  return html`<section class="card">
    <h2>Guadagni vs costi · questo mese <button class="link-btn small" data-nav="analysis">Analisi</button></h2>
    ${cur.income === 0 && spent === 0 && cur.invested === 0 ? html`<div class="muted small">Nessun movimento questo mese.</div>` : html`
      <div class="row between"><div><div class="small muted">Incassato</div><div class="big num stat-big">${amt(cur.income)}</div></div><div class="r"><div class="small muted">Disponibile dopo spese e riserva</div><div class="big num stat-big">${amt(net, { tone: true })}</div></div></div>
      <div class="ratio" aria-hidden="true"><i class="r-exp" data-w="${w(spent)}"></i><i class="r-tax" data-w="${w(tax)}"></i><i class="r-net" data-w="${w(net)}"></i></div>
      <div class="legend"><span><i class="lg-exp"></i>Spese ${amt(spent)}</span><span><i class="lg-tax"></i>Riserva fiscale ${amt(tax)}</span><span><i class="c-free"></i>Resta ${amt(net, { tone: true })}</span></div>
      ${cur.income > 0 ? html`<div class="small muted mt8">Ogni 100 € incassati: ${per100(spent)} spesi, ${per100(tax)} accantonati per le tasse, ${Math.max(0, 100 - per100(spent) - per100(tax))} restano.</div>` : ''}
      ${cur.invested > 0 || investedTotal(st) > 0 ? html`<div class="kv mt8"><span class="k">📈 Investito questo mese (PAC, non è una spesa)</span><span class="num">${amt(cur.invested)}</span><span class="k">Versato in totale</span><span class="num">${amt(investedTotal(st))}</span></div>` : ''}`}
    <div class="mt12">${flowChart(series.map((m) => ({ ...m, label: monthLabel(m.month, true) })), { interactive: false, height: 160 })}</div>
    ${flowLegend()}
  </section>`;
}

export function viewOverview(app) {
  const st = app.state, today = app.today;
  const snap = snapshot(st);
  const fc = forecast(st, today);
  const bs = budgetStatus(st, today);
  const k = snap.reservedByKind;
  const pos = (n) => Math.max(0, n);
  const totalPos = pos(snap.free) + pos(k.tax) + pos(k.goal) + pos(k.planned) + pos(k.reserve) + pos(snap.invested) || 1;
  const w = (n) => ((pos(n) / totalPos) * 100).toFixed(1);

  const alerts = [];
  for (const i of fc.issues.filter((x) => x.kind !== 'goal_at_risk')) {
    alerts.push({ sev: i.severity, text: `${i.message}${i.kind === 'free_negative' || i.kind === 'total_negative' ? ` Dal ${formatDate(i.date)} (${formatEuro(i.cents)}).` : i.kind === 'account_overcommitted' ? ` di ${formatEuro(-i.cents)}` : ''}`, go: i.kind === 'balances_unknown' ? 'settings/status' : 'plan', act: i.kind === 'account_overcommitted' ? 'rebalance' : null, id: i.refId, actLabel: 'Riequilibra' });
  }
  for (const i of fc.issues.filter((x) => x.kind === 'goal_at_risk')) alerts.push({ sev: 'medium', text: i.message.replace(/mancano [\d.]+ €/, `mancano ${formatEuro(i.cents)}`), go: 'funds' });
  if (app.integrity && !app.integrity.ok) alerts.push({ sev: 'high', text: `Controlli di quadratura: ${app.integrity.errors} errori. Verifica subito.`, go: 'settings/integrity' });
  else if (app.integrity?.warnings) alerts.push({ sev: 'medium', text: `Controlli di quadratura: ${app.integrity.warnings} avvisi da rivedere.`, go: 'settings/integrity' });
  const hasData = st.transactions.length > 0 || st.accounts.length > 0;
  const lastB = st.meta.lastBackupAt;
  const age = lastB ? Math.floor((Date.parse(app.nowIso) - Date.parse(lastB)) / 86400000) : null;
  if (hasData && !st.meta.demo && (age === null || age >= st.settings.backupReminderDays)) alerts.push({ sev: 'medium', text: age === null ? 'Non hai ancora fatto nessun backup cifrato.' : `Ultimo backup ${age} giorni fa.`, go: 'settings/backup' });

  const due = dueItems(st, today, 7);
  const upcoming = [];
  for (const p of st.planned.filter((x) => x.status === 'planned' && !x.confirm && x.dueDate > addDaysStr(today, 7))) for (const d of expandPlanned(p, today, addDaysStr(today, 60)).slice(0, 1)) upcoming.push({ date: d, title: p.name, sub: p.recurrence !== 'none' ? RECUR_LABEL[p.recurrence] : 'Acquisto programmato', cents: -p.cents, kind: 'out', icon: KIND_ICON[p.kind] });
  for (const f of st.funds.filter((x) => !x.archived && x.kind === 'goal' && x.goal?.deadline && x.goal.deadline >= today)) upcoming.push({ date: f.goal.deadline, title: f.name, sub: 'Scadenza obiettivo', cents: f.goal.targetCents, kind: 'goal', icon: f.icon });
  for (const r of st.receivables.filter((x) => (x.status === 'expected' || x.status === 'partial') && x.expectedDate > addDaysStr(today, 3))) upcoming.push({ date: r.expectedDate, title: r.client, sub: 'Incasso previsto · non ancora disponibile', cents: r.expectedCents - (r.receivedCents ?? 0), kind: 'in', icon: '💶' });
  upcoming.sort((a, b) => (a.date < b.date ? -1 : 1));

  const goals = st.funds.filter((f) => !f.archived && (f.kind === 'goal' || f.kind === 'planned'));
  return html`<div class="screen">
    ${topbar('Panoramica', formatDateLong(today), html`
      <button class="icon-btn" data-action="toggle-hide" aria-label="Mostra o nascondi importi">${app.hide ? I.eyeOff : I.eye}</button>
      <button class="icon-btn" data-action="fee-calc" aria-label="Calcolatrice compenso netto">${I.calc}</button>
      <button class="icon-btn" data-action="lock" aria-label="Blocca">${I.lock}</button>
      <button class="icon-btn" data-nav="settings" aria-label="Impostazioni">${I.gear}</button>`)}
    ${st.meta.demo ? html`<div class="banner">Dati dimostrativi · fittizi — puoi eliminarli da Impostazioni</div>` : ''}
    <section class="card hero">
      <div class="label">Saldo totale dei conti</div>
      <div class="big num">${amt(snap.total)}</div>
      <div class="stack" aria-hidden="true"><i class="c-free" data-w="${w(snap.free)}"></i><i class="c-tax" data-w="${w(k.tax)}"></i><i class="c-goal" data-w="${w(k.goal)}"></i><i class="c-planned" data-w="${w(k.planned)}"></i><i class="c-reserve" data-w="${w(k.reserve)}"></i><i class="col-navy" data-w="${w(snap.invested)}"></i></div>
      <div class="stats">
        <div class="stat ${snap.free < 0 ? 'warn' : ''}"><div class="k">Liquidità libera</div><div class="v num">${amt(snap.free)}</div></div>
        <div class="stat"><div class="k">Somme vincolate</div><div class="v num">${amt(snap.reserved)}</div></div>
      </div>
      ${snap.invested > 0 ? html`<div class="small hero-sub">di cui investito (PAC): ${amt(snap.invested)} · non è liquidità</div>` : ''}
      ${st.accounts.some((a) => a.balanceUnknown && !a.archived) ? html`<div class="hero-note">Totale parziale: ${st.accounts.filter((a) => a.balanceUnknown && !a.archived).length} conti da aggiornare</div>` : ''}
    </section>
    ${alerts.length ? html`<div>${alerts.map((a) => html`<div class="alert ${a.sev === 'high' ? 'high' : ''}">${I.warn}<button class="grow left" data-nav="${a.go}">${a.text}</button>${a.act ? html`<button class="btn sm inline" data-action="${a.act}" data-id="${a.id}">${a.actLabel}</button>` : ''}</div>`)}</div>` : html`<div class="alert ok">${I.check}<span>Nessun problema di liquidità rilevato nei prossimi ${st.settings.forecastDays} giorni.</span></div>`}

    ${due.length ? html`<section class="card"><h2>Da pagare / incassare <span class="pill ${due.some((d) => d.late) ? 'warn' : ''}">${due.length}</span></h2>
      ${due.slice(0, 6).map((d) => html`<div class="dueitem"><span class="tile sm col-${d.type === 'in' ? 'green' : d.late ? 'red' : 'gray'}">${d.icon}</span><div class="grow"><div class="t ellipsis">${d.title}</div><div class="s small ${d.late ? 'neg' : 'muted'}">${d.sub} · ${formatDate(d.date)} · ${when(d.date, today)}</div></div><div class="r num">${amt(d.cents, { tone: true })}</div>
        <button class="btn sm primary inline" data-action="${d.type === 'pay' ? 'complete-planned' : 'receive'}" data-id="${d.id}">${d.type === 'in' ? 'Incassata' : d.auto ? 'Addebitato' : 'Pagato'}</button></div>`)}</section>` : ''}

    ${pendingCard(app, snap)}
    ${moneyMap(app, snap)}
    ${earningsCard(app)}

    <section class="card">
      <h2>Budget della settimana</h2>
      ${bs.baseCents <= 0 ? html`${empty('Budget non impostato', 'Imposta un importo settimanale in Impostazioni → Budget e accantonamenti.')}<button class="btn block" data-nav="settings/budget">Imposta budget</button>` : !bs.started ? html`<div class="muted">Il budget partirà il ${formatDate(st.settings.budget.startDate)}.</div>` : html`
        <div class="row between"><div><div class="small muted">Residuo (${formatDate(bs.weekStart)} – ${formatDate(bs.weekEnd)})</div><div class="num" data-big>${amt(bs.remainingCents, { tone: true })}</div></div>
        <div class="r small muted">Speso ${amt(bs.spentCents)}<br>su ${amt(bs.baseCents + bs.carryCents)}</div></div>
        <div class="bar-wrap">${bar(pctOf(bs.spentCents, bs.baseCents + bs.carryCents), bs.remainingCents < 0 ? 'neg' : bs.remainingCents < (bs.baseCents + bs.carryCents) * 0.2 ? 'warn' : 'pos')}</div>
        ${budgetFundLine(st, snap, bs)}
        ${bs.carryCents !== 0 ? html`<div class="small muted">${bs.carryCents > 0 ? 'Avanzo riportato' : 'Disavanzo riportato'}: ${amt(bs.carryCents, { plus: true })}</div>` : ''}`}
    </section>

    <section class="card">
      <h2>Obiettivi <button class="link-btn small" data-nav="funds">Vedi tutti</button></h2>
      ${goals.length === 0 ? empty('Nessun obiettivo', 'Crea un obiettivo (es. un viaggio) dalla sezione Fondi.') : html`<ul class="list">${goals.slice(0, 4).map((f) => fundRow(st, snap, f, { today }))}</ul>`}
    </section>

    <section class="card">
      <h2>Prossime scadenze <button class="link-btn small" data-nav="plan">Pianificazione</button></h2>
      ${upcoming.length === 0 ? empty('Nessuna scadenza', 'Aggiungi abbonamenti, rinnovi o incassi attesi.') : html`<ul class="list">${upcoming.slice(0, 6).map((u) => html`
        <li class="item"><span class="tile sm col-${u.kind === 'in' ? 'green' : u.kind === 'goal' ? 'indigo' : 'gray'}">${u.icon}</span>
          <div class="grow"><div class="t ellipsis">${u.title}</div><div class="s">${u.sub}</div></div>
          <div class="r"><div class="num">${amt(u.cents, { tone: u.kind !== 'goal' })}</div><div class="s">${formatDate(u.date)} · ${when(u.date, today)}</div></div></li>`)}</ul>`}
    </section>
  </div>`;
}
const addDaysStr = (d, n) => { const t = new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000); return t.toISOString().slice(0, 10); };

export function fundRow(st, snap, f, { detail = false, today = null, child = false } = {}) {
  const sf = snap.funds[f.id];
  const target = f.kind === 'goal' ? f.goal.targetCents : f.kind === 'planned' ? (st.planned.find((p) => p.id === f.plannedId)?.cents ?? 0) : 0;
  const undefinedTarget = f.kind === 'goal' && f.goal.targetCents == null;
  const range = f.kind === 'goal' && f.goal.minCents ? `${formatEuro(f.goal.minCents, { symbol: false })}–${formatEuro(f.goal.targetCents)}` : null;
  const prog = fundProgress(st, f, snap);
  const dl = f.kind === 'goal' ? f.goal.deadline : f.kind === 'planned' ? st.planned.find((p) => p.id === f.plannedId)?.dueDate : null;
  const pace = today ? monthlyPace(st, f, snap, today) : null;
  const kids = childFunds(st, f);
  return html`<li class="${child ? 'fund-child' : ''}"><button class="fund-card" data-action="fund" data-id="${f.id}">
    <div class="row between"><span class="tile col-${f.color}">${f.icon}</span><div class="grow"><div class="name ellipsis">${f.name}${f.provisional ? html` ${pill('provvisorio', 'warn')}` : ''}${child ? html` ${pill('incluso nel budget del viaggio', 'acc')}` : ''}</div><div class="small muted">${KIND_LABEL[f.kind]}${dl ? ` · entro ${formatDate(dl, { year: true })}` : ''} · <span title="Vincolo contabile: il denaro resta sul conto">virtuale</span>${f.origin === 'profile' ? ' · configurato' : ''}</div></div>
      <div class="r"><div class="big num">${amt(prog.have)}</div>${undefinedTarget ? html`<div class="small muted">obiettivo da definire</div>` : target ? html`<div class="small muted">di ${range ?? amt(target)}</div>` : ''}</div></div>
    ${target ? html`<div class="bar-wrap"><div class="hbar"><i class="col-${f.color}" data-w="${Math.min(100, Math.round(pctOf(prog.have, target)))}"></i></div></div>` : ''}
    ${prog.have === 0 && (target || undefinedTarget) ? html`<div class="small muted">Non ancora finanziato</div>` : ''}
    ${kids.length ? html`<div class="small muted">Include ${kids.map((k) => k.name).join(', ')}: contati una sola volta nel totale</div>` : ''}
    ${pace ? html`<div class="small"><span class="pill acc">Servono circa ${formatEuro(pace)}/mese</span></div>` : ''}
    ${detail ? html`<div class="meta"><span>Assegnato ${amt(sf.assigned)}</span><span>Già speso ${amt(sf.spent)}</span><span>${acc(st, f.accountId)}</span></div>` : ''}
  </button></li>`;
}
const acc = (st, id) => st.accounts.find((a) => a.id === id)?.name ?? '—';

// ───────────────────────────── Movimenti ─────────────────────────────
export function viewMoves(app) {
  const st = app.state, ui = app.ui;
  const cat = byId(st.categories), accs = byId(st.accounts), funds = byId(st.funds);
  let rows = [
    ...st.transactions.map((t) => ({ type: 'tx', date: t.date, at: t.createdAt, t })),
    ...st.transfers.map((t) => ({ type: 'tr', date: t.date, at: t.createdAt, t })),
  ];
  rows = rows.filter((r) => (ui.showVoid ? true : r.t.status === 'posted'));
  if (ui.moveFilter === 'in') rows = rows.filter((r) => r.type === 'tx' && r.t.cents > 0);
  if (ui.moveFilter === 'out') rows = rows.filter((r) => r.type === 'tx' && r.t.cents < 0);
  if (ui.moveFilter === 'tr') rows = rows.filter((r) => r.type === 'tr');
  if (ui.moveAccount) rows = rows.filter((r) => (r.type === 'tx' ? r.t.accountId === ui.moveAccount : r.t.fromAccountId === ui.moveAccount || r.t.toAccountId === ui.moveAccount));
  rows.sort((a, b) => (a.date === b.date ? (a.at < b.at ? 1 : -1) : a.date < b.date ? 1 : -1));
  const shown = rows.slice(0, ui.limit);
  const groups = [];
  for (const r of shown) { const g = groups.at(-1); if (g && g.date === r.date) g.rows.push(r); else groups.push({ date: r.date, rows: [r] }); }
  const chip = (id, label, key = 'moveFilter') => html`<button class="chip" data-action="set-filter" data-key="${key}" data-v="${id}" aria-pressed="${(ui[key] ?? '') === id}">${label}</button>`;
  return html`<div class="screen">
    ${topbar('Movimenti', `${rows.length} ${rows.length === 1 ? 'movimento' : 'movimenti'}`)}
    <div class="chips">${chip('', 'Tutti')}${chip('in', 'Entrate')}${chip('out', 'Uscite')}${chip('tr', 'Trasferimenti')}
      ${st.accounts.filter((a) => !a.archived).map((a) => html`<button class="chip" data-action="set-filter" data-key="moveAccount" data-v="${ui.moveAccount === a.id ? '' : a.id}" aria-pressed="${ui.moveAccount === a.id}">${a.name.replace(/ \(demo\)/, '')}</button>`)}
      <button class="chip" data-action="toggle-void" aria-pressed="${!!ui.showVoid}">Annullati</button></div>
    ${st.accounts.length === 0 ? html`<div class="card">${empty('Aggiungi prima un conto', 'I movimenti si registrano sui conti.')}<button class="btn primary block" data-action="new-account">Nuovo conto</button></div>` : groups.length === 0 ? html`<div class="card">${empty('Nessun movimento')}</div>` : groups.map((g) => html`
      <div class="day">${formatDateLong(g.date)}</div>
      <div class="card"><ul class="list">${g.rows.map((r) => r.type === 'tx' ? txRow(r.t, cat, accs, funds) : trRow(r.t, accs))}</ul></div>`)}
    ${rows.length > shown.length ? html`<button class="btn block" data-action="more-moves">Mostra altri</button>` : ''}
    ${st.accounts.length ? html`<button class="fab" data-action="new-tx" aria-label="Nuovo movimento">${I.plus}</button>` : ''}
  </div>`;
}
function txRow(t, cat, accs, funds) {
  const isIn = t.cents > 0;
  const c = t.categoryId ? cat[t.categoryId]?.name : '';
  return html`<li><button class="item ${t.status === 'void' ? 'void' : ''}" data-action="tx" data-id="${t.id}">
    ${catTile(cat[t.categoryId])}
    <div class="grow"><div class="t ellipsis">${t.note || c || (isIn ? 'Entrata' : 'Uscita')}</div>
      <div class="s ellipsis">${accs[t.accountId]?.name.replace(/ \(demo\)/, '')}${c && t.note ? ` · ${c}` : ''}${t.fundId ? html` · ${pill('da fondo', 'acc')}` : ''}${t.kind === 'investment' ? html` · ${pill('investimento', 'acc')}` : ''}${t.kind === 'adjustment' ? html` · ${pill('rettifica', 'warn')}` : ''}${t.status === 'void' ? html` · ${pill('annullato', 'neg')}` : ''}</div></div>
    <div class="r num">${amt(t.cents, { tone: true, plus: isIn })}</div></button></li>`;
}
function trRow(t, accs) {
  return html`<li><button class="item ${t.status === 'void' ? 'void' : ''}" data-action="transfer" data-id="${t.id}">
    <div class="avatar tr">${I.swap}</div>
    <div class="grow"><div class="t ellipsis">${accs[t.fromAccountId]?.name.replace(/ \(demo\)/, '')} → ${accs[t.toAccountId]?.name.replace(/ \(demo\)/, '')}</div>
      <div class="s">${pill(t.purpose === 'fund' ? 'trasferimento per fondo' : 'trasferimento', 'acc')} ${t.note ? t.note : 'non è un\'entrata né una spesa'}${t.status === 'void' ? html` ${pill('annullato', 'neg')}` : ''}</div></div>
    <div class="r num">${amt(t.cents)}</div></button></li>`;
}

// ───────────────────────────── Fondi ─────────────────────────────
export function viewFunds(app) {
  const st = app.state, today = app.today;
  const snap = snapshot(st);
  const active = st.funds.filter((f) => !f.archived);
  const group = (kind) => active.filter((f) => f.kind === kind);
  const section = (title, list) => list.length ? html`<div class="section-title">${title}</div><div class="card"><ul class="list">${list.map((f) => html`${fundRow(st, snap, f, { detail: true, today })}${childFunds(st, f).map((k) => fundRow(st, snap, k, { detail: true, today, child: true }))}`)}</ul></div>` : '';
  const prio = (f) => f.goal.priority;
  const goals = group('goal').filter((f) => !f.parentId).sort((a, b) => prio(a) - prio(b) || ((a.goal.deadline ?? '9') < (b.goal.deadline ?? '9') ? -1 : 1));
  return html`<div class="screen">
    ${topbar('Fondi', 'Denaro libero, assegnato e già speso', html`<button class="icon-btn" data-action="new-fund" aria-label="Nuovo fondo">${I.plus}</button>`)}
    <section class="card">
      <h2>Per conto</h2>
      ${st.accounts.length === 0 ? empty('Nessun conto') : html`<ul class="list">${st.accounts.filter((a) => !a.archived && a.type !== 'investment').map((a) => {
        const bal = snap.balances[a.id], res = snap.reservedByAccount[a.id] ?? 0, free = snap.freeByAccount[a.id];
        return html`<li class="item block-item"><div class="row between"><div class="row left">${accountTile(a, 'sm')}<div class="t">${a.name}</div></div><div class="num small muted">Saldo ${amt(bal)}</div></div>
          <div class="bar-wrap">${bar(pctOf(res, Math.max(bal, 1)), free < 0 ? 'neg' : 'planned')}</div>
          <div class="row between small"><span class="${free < 0 ? 'neg' : ''}">Libero <b class="num">${amt(free)}</b></span><span class="muted">Vincolato <b class="num">${amt(res)}</b></span></div></li>`;
      })}</ul>`}
      <div class="note">I fondi sono <b>vincoli contabili interni</b>: il denaro resta sul conto bancario. Per spostarlo davvero usa un trasferimento.</div>
    </section>
    ${active.length === 0 ? html`<div class="card">${empty('Nessun fondo', 'Crea un obiettivo di risparmio, un accantonamento fiscale o una riserva.')}<button class="btn primary block" data-action="new-fund">Nuovo fondo</button></div>` : ''}
    ${section('Obiettivi di risparmio', goals)}
    ${section('Accantonamenti fiscali', group('tax'))}
    ${section('Acquisti programmati', group('planned'))}
    ${section('Budget settimanale', group('budget'))}
    ${section('Riserve', group('reserve'))}
  </div>`;
}

// ───────────────────────────── Incassi ─────────────────────────────
export function viewIncome(app) {
  const st = app.state, today = app.today;
  const accs = byId(st.accounts);
  const open = st.receivables.filter((r) => r.status === 'expected' || r.status === 'partial').sort((a, b) => (a.expectedDate < b.expectedDate ? -1 : 1));
  const received = st.receivables.filter((r) => r.status === 'received').sort((a, b) => (a.receivedDate < b.receivedDate ? 1 : -1));
  const cancelled = st.receivables.filter((r) => r.status === 'cancelled');
  const remaining = (r) => r.expectedCents - (r.receivedCents ?? 0);
  const sumExp = open.reduce((s, r) => s + remaining(r), 0);
  const late = open.filter((r) => r.expectedDate < today);
  const sumRec = st.receivables.filter((r) => r.receivedDate && diffDays(today, r.receivedDate) <= 90).reduce((s, r) => s + (r.receivedCents ?? 0), 0);
  return html`<div class="screen">
    ${topbar('Incassi', 'Previsti ed effettivi', html`<button class="icon-btn" data-action="new-receivable" aria-label="Nuovo incasso atteso">${I.plus}</button>`)}
    <section class="card">
      <div class="field-row">
        <div><div class="small muted">Previsti · non disponibili</div><div class="big num stat-big">${amt(sumExp)}</div>${late.length ? html`<div class="small neg">${late.length} in ritardo</div>` : ''}</div>
        <div><div class="small muted">Incassati (90 gg)</div><div class="big num stat-big">${amt(sumRec)}</div></div>
      </div>
      <div class="note">I compensi <b>previsti</b> sono pianificazione, non denaro: entrano nei saldi solo quando li segni come incassati con l'importo effettivo (anche parziale).</div>
    </section>
    <div class="section-title">Previsti · da incassare</div>
    <div class="card">${open.length === 0 ? empty('Nessun incasso previsto', 'Aggiungi le fatture o i compensi che aspetti.') : html`<ul class="list">${open.map((r) => {
      const rp = reserveProgress(st, r);
      return html`<li class="item"><button class="grow row left" data-action="receivable" data-id="${r.id}">
      <div class="avatar ${r.expectedDate < today ? 'warn' : 'in'}">${I.down}</div>
      <div class="grow"><div class="t ellipsis">${r.client}</div><div class="s ellipsis">${r.description || accs[r.accountId]?.name}</div>
      ${r.status === 'partial' ? html`<div class="s">${pill('parziale', 'warn')} Incassati ${formatEuro(r.receivedCents)} di ${formatEuro(r.expectedCents)} · restano ${formatEuro(remaining(r))}</div>` : ''}
      ${rp.planned != null ? html`<div class="s">Riserva prevista ${formatEuro(rp.planned)}${rp.done ? ` · accantonata ${formatEuro(rp.done)} · resta ${formatEuro(rp.remaining)}` : ` → disponibile ${formatEuro(r.expectedCents - rp.planned)}`}</div>` : ''}
      <div class="s">${r.expectedDate < today ? pill(`in ritardo di ${diffDays(today, r.expectedDate)} gg`, 'warn') : pill(`${formatDate(r.expectedDate)} · ${when(r.expectedDate, today)}`)}</div></div>
      <div class="r num">${amt(remaining(r))}</div></button>
      <button class="btn sm primary" data-action="receive" data-id="${r.id}">Incassata ✓</button></li>`;
    })}</ul>`}</div>
    <div class="section-title">Fatture ricorrenti · regole <button class="link-btn" data-action="new-template">+ Aggiungi</button></div>
    <div class="card">${st.invoiceTemplates.length === 0 ? empty('Nessuna fattura ricorrente', 'Es.: fatturi un cliente ogni 27 del mese e incassi dopo ~12 giorni: l\'app genera gli incassi previsti per te.') : html`<ul class="list">${st.invoiceTemplates.map((t) => html`<li><button class="item ${t.active === false ? 'void' : ''}" data-action="template" data-id="${t.id}"><span class="tile sm col-teal">🧾</span><div class="grow"><div class="t ellipsis">${t.client}${t.review ? html` ${pill('da verificare', 'warn')}` : ''}${t.origin === 'profile' ? html` ${pill('configurato')}` : ''}</div><div class="s">Il ${t.invoiceDay} del mese · incasso dopo ~${t.collectDays} gg${t.reserveCents != null ? ` · riserva fissa ${formatEuro(t.reserveCents)} → disponibile ${formatEuro(t.cents - t.reserveCents)}` : ' · riserva da stima fiscale'}${t.active === false ? ' · disattivata' : ''}</div>${t.note ? html`<div class="s">${t.note}</div>` : ''}</div><div class="r num">${amt(t.cents)}</div></button></li>`)}</ul>`}</div>
    ${received.length ? html`<div class="section-title">Incassati</div><div class="card"><ul class="list">${received.slice(0, 12).map((r) => {
      const d = r.receivedCents - r.expectedCents;
      const rp = reserveProgress(st, r);
      return html`<li><button class="item" data-action="tx" data-id="${r.receivedTxId}"><div class="avatar in">${I.check}</div><div class="grow"><div class="t ellipsis">${r.client}</div><div class="s">${formatDate(r.receivedDate, { year: true })}${d !== 0 ? html` · ${pill(`${formatEuro(d, { plus: true })} vs previsto`, d < 0 ? 'warn' : 'pos')}` : ''}</div>${rp.planned != null ? html`<div class="s">Riserva ${formatEuro(rp.done)} di ${formatEuro(rp.planned)}${rp.remaining ? ` · restano ${formatEuro(rp.remaining)} da accantonare` : ''}</div>` : ''}</div><div class="r num">${amt(r.receivedCents, { tone: true })}</div></button></li>`;
    })}</ul></div>` : ''}
    ${cancelled.length ? html`<div class="section-title">Annullati</div><div class="card"><ul class="list">${cancelled.map((r) => html`<li class="item void"><div class="grow"><div class="t">${r.client}</div><div class="s">${r.cancelReason}</div></div><div class="r num">${amt(r.expectedCents)}</div></li>`)}</ul></div>` : ''}
  </div>`;
}

// ───────────────────────────── Pianificazione ─────────────────────────────
export function viewPlan(app) {
  const st = app.state, today = app.today, ui = app.ui;
  const fc = forecast(st, today);
  const snap = snapshot(st);
  const planned = st.planned.filter((p) => p.status === 'planned').sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  const done = st.planned.filter((p) => p.status === 'done').slice(-3);
  const accOpts = st.accounts.filter((a) => !a.archived);
  const selAcc = accOpts.find((a) => a.id === ui.allocAccount) ?? accOpts[0];
  const free = selAcc ? Math.max(0, snap.freeByAccount[selAcc.id]) : 0;
  const issues = fc.issues;
  const expectedTotal = fc.points.at(-1).totalWithExpected - fc.points.at(-1).total;
  return html`<div class="screen">
    ${topbar('Pianificazione', `Previsioni a ${st.settings.forecastDays} giorni`, html`<button class="icon-btn" data-action="new-planned" aria-label="Nuovo acquisto programmato">${I.plus}</button>`)}
    <section class="card">
      <h2>Liquidità: passato e previsione</h2>
      ${st.accounts.length === 0 ? empty('Nessun conto') : html`
      ${balanceChart(balanceHistory(st, today, 6), fc.points)}
      <div class="legend"><span><i class="c-reserve"></i>Saldo a fine mese (storico)</span><span><i class="c-goal"></i>Previsione prudente</span><span><i class="c-free"></i>Con incassi attesi (non garantiti)</span></div>
      <div class="kv mt12"><span class="k">Libera oggi</span><span class="num">${amt(fc.start.free)}</span>
        <span class="k">Minimo previsto</span><span class="num">${amt(fc.minFree, { tone: true })} <span class="small muted">· ${formatDate(fc.minFreeDate)}</span></span>
        <span class="k">Incassi attesi (esclusi)</span><span class="num muted">${amt(expectedTotal)}</span></div>
      <div class="note">Previsione prudente: considera budget settimanale e acquisti programmati; <b>esclude</b> gli incassi non ricevuti.</div>`}
    </section>
    <section class="card"><h2>Situazione a una data</h2><p class="small mt0">Cosa entra, cosa esce e se le spese previste sono coperte, in elenco: scegli fino a quando.</p>
      <div class="chips">${[['eom', 'Fine mese'], ['eom2', 'Fine mese prossimo'], ['dec', '31 dicembre']].map(([k, t]) => html`<button class="chip" data-action="open-situation" data-v="${k}">${t}</button>`)}</div></section>
    ${cashflowCard(app)}
    ${issues.length ? html`<div>${issues.map((i) => html`<div class="alert ${i.severity === 'high' ? 'high' : ''}">${I.warn}<span>${i.message}${i.kind.includes('negative') ? ` dal ${formatDate(i.date)} (${formatEuro(i.cents)})` : ''}</span></div>`)}</div>` : ''}

    <section class="card">
      <h2>Suggerimento di allocazione</h2>
      ${!selAcc ? empty('Nessun conto') : html`
        <form data-form="alloc-suggest">
          <label class="field"><span>Conto</span><select name="account" data-change="alloc-account">${accOpts.map((a) => html`<option value="${a.id}" ${a.id === selAcc.id ? raw('selected') : ''}>${a.name}</option>`)}</select></label>
          <label class="field"><span>Importo da allocare</span><input class="money sm" name="amount" inputmode="decimal" placeholder="${formatEuro(free, { symbol: false })}" autocomplete="off"><small class="hint">Lascia vuoto per usare tutto il denaro libero del conto.</small></label>
          <button class="btn primary block" type="submit">Calcola suggerimento</button>
        </form>
        <div class="small muted mt8">Libero su ${selAcc.name}: ${amt(free)} · Ordine: accantonamenti fiscali → scadenze urgenti → priorità.</div>`}
    </section>

    <div class="section-title">Spese ricorrenti, rinnovi e acquisti</div>
    <div class="card">${planned.length === 0 ? empty('Niente in programma', 'Aggiungi abbonamenti, PAC, corsi, rinnovi o acquisti: compariranno nelle previsioni e negli avvisi.') : html`<ul class="list">${planned.map((p) => {
      const f = st.funds.find((x) => x.id === p.fundId);
      const cov = f ? snap.funds[f.id].available : 0;
      const cat = st.categories.find((c) => c.id === p.categoryId);
      return html`<li class="item"><button class="grow row left" data-action="planned" data-id="${p.id}">
        <span class="tile col-${p.dueDate < today ? 'red' : cat?.color ?? 'gray'}">${KIND_ICON[p.kind]}</span>
        <div class="grow"><div class="t ellipsis">${p.name}${p.confirm === 'active' ? html` ${pill('da confermare come attiva', 'warn')}` : p.confirm === 'date' ? html` ${pill('data da confermare', 'warn')}` : ''}${p.origin === 'profile' && !p.confirm ? html` ${pill('configurato')}` : ''}</div><div class="s">${p.confirm === 'date' ? 'data indicativa ' : ''}${formatDate(p.dueDate, { year: true })} · ${RECUR_LABEL[p.recurrence]}${p.autoPay ? ' · addebito auto' : ''}${p.kind === 'investment' ? ' · investimento' : ''}${p.toAccountId ? ` · ${acc(st, p.accountId)} → ${acc(st, p.toAccountId)}${p.autoExecute ? ' · automatico' : ''}` : ''}${p.confirm ? ' · previsto, non registrato' : ` · ${when(p.dueDate, today)}`}</div>
        ${f ? (() => { const atPay = snap.funds[f.id].byAccount[p.accountId] ?? 0; return cov >= p.cents ? (atPay >= p.cents ? html`<div class="s pos">✓ Coperta sul conto ${acc(st, p.accountId)}</div>` : html`<div class="s warn-t">Riservata ma <b>bonifico da fare</b> verso ${acc(st, p.accountId)}${p.leadDays || true ? ` entro il ${formatDate(addDaysStr(p.dueDate, -(p.leadDays ?? 0)))}` : ''}</div>`) : html`<div class="s warn-t">Da finanziare · coperto ${amt(Math.min(cov, p.cents))} / ${amt(p.cents)}</div>`; })() : ''}</div>
        <div class="r num">${amt(-p.cents)}</div></button>${p.confirm === 'active' ? html`<button class="btn sm primary inline" data-action="confirm-planned" data-id="${p.id}">Conferma</button>` : p.confirm === 'date' ? html`<button class="btn sm inline" data-action="planned" data-id="${p.id}">Imposta data</button>` : html`<button class="btn sm primary inline" data-action="complete-planned" data-id="${p.id}">${p.toAccountId ? 'Eseguito' : p.autoPay ? 'Addebitato' : 'Pagato'} ✓</button>`}</li>`;
    })}</ul>`}</div>
    ${done.length ? html`<div class="small muted done-note">Completati di recente: ${done.map((p) => p.name).join(', ')}</div>` : ''}
  </div>`;
}

// ───────────────────────────── Impostazioni ─────────────────────────────
export function viewSettings(app, sub) {
  const st = app.state;
  const back = html`<button class="back" data-nav="${sub ? 'settings' : 'overview'}">${I.back}${sub ? 'Impostazioni' : 'Panoramica'}</button>`;
  if (sub === 'integrity') return settingsIntegrity(app, back);
  if (sub === 'history') return settingsHistory(app, back);
  if (sub === 'backup') return settingsBackup(app, back);
  if (sub === 'security') return settingsSecurity(app, back);
  if (sub === 'budget') return settingsBudget(app, back);
  if (sub === 'accounts') return settingsAccounts(app, back);
  if (sub === 'categories') return settingsCategories(app, back);
  if (sub === 'tax') return settingsTax(app, back);
  if (sub === 'calendar') return settingsCalendar(app, back);
  if (sub === 'status') return settingsStatus(app, back);
  const row = (icon, title, text, nav, action) => html`<button class="menu-row" ${nav ? raw(`data-nav="${nav}"`) : raw(`data-action="${action}"`)}><div class="avatar">${icon}</div><div class="grow"><div class="t">${title}</div><div class="s muted small">${text}</div></div><span class="chev">${I.chev}</span></button>`;
  return html`<div class="screen no-tabs">${back}${topbar('Impostazioni')}
    <section class="card">
      ${row(I.check, 'Stato dei dati', 'Configurati · previsti · da confermare', 'settings/status')}
      ${row(I.wallet, 'Conti e banche', `${st.accounts.filter((a) => !a.archived).length} attivi · logo, colore, icona`, 'settings/accounts')}
      ${row(I.list, 'Categorie', `${st.categories.filter((c) => c.kind !== 'adjustment').length} categorie`, 'settings/categories')}
      ${row(I.shield, 'Tasse e contributi', st.settings.taxProfile.enabled ? 'Forfettario + Gestione Separata attivo' : 'Non attivo', 'settings/tax')}
      ${row(I.plan, 'Calendario e avvisi', 'Notifiche iPhone via Calendario', 'settings/calendar')}
      ${row(I.list, 'Budget e accantonamenti', 'Budget settimanale, riporto, regole fiscali', 'settings/budget')}
      ${row(I.check, 'Controlli di quadratura', app.integrity ? (app.integrity.ok ? (app.integrity.warnings ? `${app.integrity.warnings} avvisi` : 'Tutto quadra') : `${app.integrity.errors} errori`) : 'Verifica in corso…', 'settings/integrity')}
      ${row(I.list, 'Storico delle modifiche', `${st.audit.length} voci · catena di hash`, 'settings/history')}
    </section>
    <section class="card">
      ${row(I.shield, 'Sicurezza', 'Blocco automatico, cambio password', 'settings/security')}
      ${row(I.save, 'Backup e ripristino', st.meta.lastBackupAt ? `Ultimo: ${formatDate(st.meta.lastBackupAt.slice(0, 10), { year: true })}` : 'Nessun backup ancora', 'settings/backup')}
    </section>
    ${st.meta.demo ? html`<section class="card"><h2>Dati dimostrativi</h2><p class="small muted mt0">Stai usando dati fittizi. Quando vuoi iniziare con i tuoi, eliminali: lo storico registrerà l'operazione.</p><button class="btn danger block" data-action="clear-demo">Elimina i dati dimostrativi</button></section>` : ''}
    <section class="card"><button class="btn block" data-action="lock">${I.lock} Blocca ora</button></section>
    <p class="small muted center">Finanze personali v${app.version} · dati solo su questo dispositivo, cifrati.</p>
  </div>`;
}
function settingsAccounts(app, back) {
  const st = app.state, snap = snapshot(st);
  return html`<div class="screen no-tabs">${back}${topbar('Conti', '', html`<button class="icon-btn" data-action="new-account">${I.plus}</button>`)}
    <section class="card"><ul class="list">${st.accounts.map((a) => html`<li><button class="item ${a.archived ? 'void' : ''}" data-action="edit-account" data-id="${a.id}">${accountTile(a)}<div class="grow"><div class="t">${a.name}${a.archived ? ' (archiviato)' : ''}</div><div class="s">${ACC_LABEL[a.type]} · dal ${formatDate(a.openingDate, { year: true })}</div></div><div class="r num">${amt(snap.balances[a.id])}</div></button></li>`)}</ul>
    ${st.accounts.length === 0 ? empty('Nessun conto') : ''}</section></div>`;
}
function settingsBudget(app, back) {
  const st = app.state, b = st.settings.budget;
  const funds = byId(st.funds);
  return html`<div class="screen no-tabs">${back}${topbar('Budget e accantonamenti')}
    <section class="card"><h2>Budget settimanale <button class="link-btn small" data-action="edit-budget">Modifica</button></h2>
      <div class="kv"><span class="k">Importo</span><span class="num">${amt(b.weeklyCents)}</span><span class="k">Dal</span><span>${formatDate(b.startDate, { year: true })}</span>
      <span class="k">Riporto avanzi</span><span>${b.carryOver ? 'Sì' : 'No'}</span><span class="k">Riporto disavanzi</span><span>${b.carryOver && b.carryDeficit ? 'Sì' : 'No'}</span></div>
      <div class="note">Contano le uscite effettive in categorie "nel budget" (non le scadenze programmate come corso o abbonamenti, che sono impegni a parte).</div></section>
    <section class="card"><h2>Finanziamento del budget ${b.fundId ? pill('attivo', 'pos') : pill('non attivo')}</h2>
      ${b.fundId ? html`<p class="small mt0">Ogni settimana l'app <b>riserva</b> il budget dal denaro libero di <b>${st.accounts.find((a) => a.id === b.accountId)?.name}</b>: i soldi restano sul conto ma non sono più "liberi". Le spese del budget consumano il fondo. <b>Avanzo</b> riportato; <b>sforo</b> sottratto dalla settimana dopo. Mai oltre il denaro libero: se non basta, ti dice quanto manca.</p>
        <div class="kv mt8"><span class="k">Settimane finanziate in anticipo</span><span>${b.advanceWeeks ? `${b.advanceWeeks} · da ${st.accounts.find((a) => a.id === b.sourceAccountId)?.name ?? '—'}` : 'nessuna'}</span></div>
        <div class="btn-row"><button class="btn primary" data-action="budget-fund-now">Finanzia ora</button><button class="btn" data-action="budget-advance">Settimane in anticipo</button></div>
        <div class="spacer10"></div><button class="btn danger block" data-action="budget-fund-off">Disattiva</button>`
      : html`<p class="small mt0">Con 500 € in conto e un budget di 220 €, i 220 vanno <b>riservati</b>: il libero vero è 280. Attiva il finanziamento per trattare il budget come un fondo, ogni settimana.</p>
        <button class="btn primary block" data-action="budget-fund-setup" ${b.weeklyCents > 0 ? '' : raw('disabled')}>Finanzia il budget come un fondo</button>${b.weeklyCents > 0 ? '' : html`<div class="small muted mt8">Imposta prima l'importo settimanale.</div>`}`}</section>
    <section class="card"><h2>Scadenze finanziate in anticipo ${st.settings.plannedFunding.enabled ? pill('attivo', 'pos') : pill('non attivo')}</h2>
      <p class="small mt0">L'app riserva in anticipo il denaro delle scadenze dei prossimi giorni (abbonamenti, PAC, rinnovi…) dal conto che scegli, così non lo alloci altrove. Se il conto è diverso da quello di pagamento compare il <b>bonifico da fare</b>.</p>
      <div class="kv"><span class="k">Orizzonte</span><span>${st.settings.plannedFunding.horizonDays} giorni</span><span class="k">Conto predefinito</span><span>${st.accounts.find((a) => a.id === st.settings.plannedFunding.sourceAccountId)?.name ?? 'il conto di pagamento'}</span></div>
      <div class="btn-row mt12"><button class="btn primary" data-action="planned-funding">Impostazioni</button>${st.settings.plannedFunding.enabled ? html`<button class="btn" data-action="planned-funding-now">Finanzia ora</button>` : ''}</div></section>
    <section class="card"><h2>Accantonamenti fiscali <button class="link-btn small" data-action="edit-tax">Modifica</button></h2>
      ${st.settings.taxRules.length === 0 ? empty('Nessuna regola', 'Esempio: 25% di ogni incasso professionale nel fondo imposte.') : html`<ul class="list">${st.settings.taxRules.map((r) => html`<li class="item"><div class="grow"><div class="t">${r.name}</div><div class="s">→ ${funds[r.fundId]?.name}</div></div><div class="r num">${(r.bp / 100).toLocaleString('it-IT')}%</div></li>`)}</ul>`}
      <div class="note">L'accantonamento è un'<b>allocazione virtuale</b>: non sposta denaro in banca e non è spendibile finché resta nel fondo.</div></section></div>`;
}
function settingsSecurity(app, back) {
  const s = app.state.settings;
  return html`<div class="screen no-tabs">${back}${topbar('Sicurezza')}
    <section class="card"><h2>Blocco</h2><div class="kv"><span class="k">Dopo inattività</span><span>${s.autoLockSec >= 60 ? s.autoLockSec / 60 + ' min' : s.autoLockSec + ' s'}</span><span class="k">In background dopo</span><span>${s.hiddenLockSec === 0 ? 'subito' : s.hiddenLockSec + ' s'}</span></div>
      <button class="btn block mt12" data-action="edit-lock">Modifica blocco</button></section>
    <section class="card"><h2>Password</h2><p class="small muted mt0">La password non è salvata da nessuna parte: se la dimentichi i dati non sono recuperabili (se non da un backup, con la sua password).</p><button class="btn block" data-action="change-password">${I.key} Cambia password</button></section>
    <section class="card"><h2>Cosa protegge la cifratura</h2><div class="small muted">AES-256-GCM, chiave derivata dalla password con PBKDF2-SHA256 (${(app.kdfIterations / 1000).toLocaleString('it-IT')}k iterazioni). Se il telefono è sbloccato e l'app aperta, i dati sono visibili: usa il blocco automatico. Dettagli in docs/SICUREZZA.md.</div></section>
    <section class="card"><button class="btn danger block" data-action="wipe-all">Cancella tutti i dati da questo dispositivo</button></section></div>`;
}
function settingsBackup(app, back) {
  const st = app.state;
  return html`<div class="screen no-tabs">${back}${topbar('Backup e ripristino')}
    <section class="card"><h2>Stato</h2><div class="kv"><span class="k">Ultimo backup</span><span>${st.meta.lastBackupAt ? formatDate(st.meta.lastBackupAt.slice(0, 10), { year: true }) : 'mai'}</span><span class="k">Modifiche da allora</span><span class="num">${Math.max(0, st.audit.length - (st.meta.lastBackupSeq ?? 0) + 1)}</span></div>
      <div class="kv mt8"><span class="k">Protezione dalla cancellazione automatica</span><span>${app.persisted === true ? pill('richiesta e concessa', 'pos') : app.persisted === false ? pill('non garantita', 'warn') : pill('sconosciuta')}</span></div>
      <div class="note">Safari può cancellare i dati di un sito (pulizia dati, poco spazio, reinstallazione). Anche con la protezione concessa, l'unica vera difesa è un backup cifrato salvato in <b>File / iCloud Drive</b>. Fallo spesso.</div></section>
    <section class="card"><button class="btn primary block" data-action="export-backup">${I.save} Crea backup cifrato</button>
      <div class="spacer10"></div><button class="btn block" data-action="verify-backup">Verifica un backup (senza ripristinare)</button>
      <div class="spacer10"></div><button class="btn block" data-action="restore-backup">Ripristina da backup</button></section>
    <section class="card"><h2>Esporta in chiaro</h2><p class="small muted mt0">CSV dei movimenti, <b>non cifrato</b>: chi riceve il file vede tutto.</p><button class="btn block" data-action="export-csv">Esporta movimenti (CSV)</button></section></div>`;
}
function settingsIntegrity(app, back) {
  const r = app.integrity;
  const icon = (sv) => (sv === 'ok' ? I.check : I.warn);
  return html`<div class="screen no-tabs">${back}${topbar('Controlli di quadratura', '', html`<button class="icon-btn" data-action="recheck">${I.swap}</button>`)}
    ${!r ? html`<div class="card">${empty('Verifica in corso…')}</div>` : html`
    <div class="alert ${r.ok ? (r.warnings ? '' : 'ok') : 'high'}">${r.ok ? icon(r.warnings ? 'warn' : 'ok') : I.warn}<span>${r.ok ? (r.warnings ? `Nessun errore, ${r.warnings} avvisi` : 'Tutti i controlli superati') : `${r.errors} errori di quadratura`}</span></div>
    <section class="card checks"><ul class="list">${r.items.map((i) => html`<li class="item"><div class="avatar ${i.severity === 'ok' ? 'in' : i.severity === 'warn' ? 'warn' : 'out'}">${icon(i.severity)}</div><div class="grow"><div class="t">${i.label}</div>${i.detail ? html`<div class="s">${i.detail}</div>` : ''}</div></li>`)}</ul></section>
    <section class="card"><h2>Riconcilia con la banca</h2><p class="small muted mt0">Inserisci il saldo mostrato dalla banca a una data: l'app lo confronta con quello derivato dai movimenti.</p><button class="btn block" data-action="new-reconciliation">Nuova quadratura</button>
    ${app.state.reconciliations.filter((x) => !x.resolvedTxId).length ? html`<ul class="list mt10">${app.state.reconciliations.filter((x) => !x.resolvedTxId).slice(-4).map((x) => html`<li class="item"><div class="grow"><div class="t">${app.state.accounts.find((a) => a.id === x.accountId)?.name}</div><div class="s">${formatDate(x.date, { year: true })} · banca ${formatEuro(x.bankCents)}</div></div><button class="btn sm" data-action="resolve-rec" data-id="${x.id}">Rettifica</button></li>`)}</ul>` : ''}</section>`}</div>`;
}
function settingsHistory(app, back) {
  const entries = [...app.state.audit].reverse().slice(0, app.ui.histLimit);
  const LAB = { create: 'Creato', update: 'Modificato', void: 'Annullato', archive: 'Archiviato', allocate: 'Allocato', release: 'Rilasciato', move: 'Spostato', relocate: 'Fondo spostato', receive: 'Incasso ricevuto', reopen: 'Riaperto', cancel: 'Cancellato', complete: 'Completato', resolve: 'Risolto', backup: 'Backup', restore: 'Ripristino', load_demo: 'Demo caricata', clear_demo: 'Demo eliminata' };
  const ENT = { account: 'conto', transaction: 'movimento', transfer: 'trasferimento', fund: 'fondo', allocation: 'allocazione', receivable: 'incasso', planned: 'acquisto', settings: 'impostazioni', budget: 'budget', tax_rules: 'regole fiscali', category: 'categoria', reconciliation: 'quadratura', meta: 'archivio' };
  const chg = (e) => {
    if (!e.before || !e.after) return '';
    const out = [];
    for (const k of Object.keys(e.after)) {
      if (['updatedAt', 'createdAt'].includes(k)) continue;
      const a = JSON.stringify(e.before[k]), b = JSON.stringify(e.after[k]);
      if (a !== b) out.push(`${k}: ${/cents/i.test(k) && Number.isSafeInteger(e.before[k]) ? formatEuro(e.before[k]) + ' → ' + formatEuro(e.after[k]) : a + ' → ' + b}`);
    }
    return out.slice(0, 4).join(' · ');
  };
  return html`<div class="screen no-tabs">${back}${topbar('Storico modifiche', `${app.state.audit.length} voci, ciascuna legata alla precedente da un hash`)}
    <section class="card hist"><ul class="list">${entries.map((e) => html`<li class="item"><div class="grow"><div class="t">${LAB[e.action] ?? e.action} · ${ENT[e.entity] ?? e.entity}</div>${e.note ? html`<div class="s">${e.note}</div>` : ''}${chg(e) ? html`<div class="chg">${chg(e)}</div>` : ''}<div class="s tiny">#${e.seq} · ${e.ts.slice(0, 16).replace('T', ' ')} · ${e.hash.slice(0, 8)}</div></div></li>`)}</ul>
    ${app.state.audit.length > entries.length ? html`<button class="btn block" data-action="more-history">Mostra altre</button>` : ''}</section></div>`;
}

function settingsCategories(app, back) {
  const st = app.state;
  const row = (c, sub = false) => html`<li class="${sub ? 'fund-child' : ''}"><button class="item" data-action="edit-category" data-id="${c.id}">${catTile(c)}<div class="grow"><div class="t">${c.name}</div><div class="s">${c.kind === 'expense' ? (c.parentId ? 'Sottocategoria: conta nella categoria madre' : c.inBudget ? 'Conta nel budget settimanale' : 'Fuori dal budget settimanale') : c.kind === 'investment' ? 'Investimento · non è una spesa' : 'Entrata'}</div></div><span class="chev">${I.chev}</span></button></li>`;
  const group = (kind, title) => html`<div class="section-title">${title}</div><div class="card"><ul class="list">${st.categories.filter((c) => c.kind === kind && !c.parentId).map((c) => html`${row(c)}${st.categories.filter((k) => k.parentId === c.id).map((k) => row(k, true))}`)}</ul></div>`;
  return html`<div class="screen no-tabs">${back}${topbar('Categorie', '', html`<button class="icon-btn" data-action="new-category" aria-label="Nuova categoria">${I.plus}</button>`)}${group('expense', 'Spese di consumo')}${group('investment', 'Investimenti (separati dalle spese)')}${group('income', 'Entrate')}<div class="note">Risparmio e trasferimenti non sono categorie di spesa: sono allocazioni e trasferimenti tra conti, sempre fuori dai grafici delle spese.</div></div>`;
}
function settingsTax(app, back) {
  const st = app.state, tp = st.settings.taxProfile;
  const fund = st.funds.find((f) => f.id === tp.fundId);
  const ex = estimateTaxes(100000, tp);
  const year = Number(app.today.slice(0, 4));
  const L = taxLedger(st, year, app.today);
  const pct = (bp) => (bp / 100).toLocaleString('it-IT') + '%';
  return html`<div class="screen no-tabs">${back}${topbar('Tasse e contributi')}
    <section class="card"><h2>Profilo ${tp.enabled ? pill('attivo', 'pos') : pill('non attivo')}</h2>
      ${tp.enabled ? html`<div class="kv"><span class="k">Coefficiente di redditività</span><span>${pct(tp.coefficientBp)}</span><span class="k">Contributi Gestione Separata</span><span>${pct(tp.inpsBp)}</span><span class="k">Imposta sostitutiva</span><span>${pct(tp.taxBp)}</span><span class="k">Deduzione contributi</span><span>${tp.inpsDeduction === 'paid' ? 'solo versati' : 'maturati sul reddito'}</span><span class="k">Arrotonda la stima a</span><span>${formatEuro(tp.roundStepCents)}</span><span class="k">Fondo di destinazione</span><span>${fund ? `${fund.icon} ${fund.name}` : '—'}</span></div>
      ${L.ratesVerified ? html`<div class="alert ok">${I.check}<span>Aliquote verificate per il ${year}.</span></div>` : html`<div class="alert">${I.warn}<span class="grow">Le aliquote (in particolare ${pct(tp.inpsBp)} per la Gestione Separata) sono valori iniziali: <b>da verificare per il ${year}</b>.</span><button class="btn sm primary inline" data-action="verify-rates">Verificate</button></div>`}
      <button class="btn block mt12" data-action="edit-tax-profile">Modifica parametri</button>` : html`<p class="small muted mt0">Ti propone quanto accantonare a ogni incasso e stima il debito fiscale dell'anno.</p><button class="btn primary block" data-action="freelance-setup">Configura profilo autonomo</button>`}
    </section>
    ${tp.enabled ? html`
    <section class="card"><h2>Quattro numeri, tenuti separati · ${year}</h2>
      <div class="four"><div><div class="k">1 · Stima fiscale (dovuto previsto)</div><div class="v num">${amt(L.estimate.totalDue)}</div><div class="s small muted">su ${formatEuro(L.estimate.ricavi)} incassati · contributi ${formatEuro(L.estimate.inpsDue)} + imposta ${formatEuro(L.estimate.impostaDue)}</div></div>
      <div><div class="k">2 · Accantonamento personale (virtuale)</div><div class="v num">${amt(L.earmarked.reservedNow)}</div><div class="s small muted">riservato nel fondo · deciso da te, non è una stima · nell'anno ${formatEuro(L.earmarked.allocatedYear, { plus: true })}</div></div>
      <div><div class="k">3 · Somme effettivamente trasferite</div><div class="v num">${amt(L.transferred.year)}</div><div class="s small muted">bonifici reali confermati verso ${fund ? st.accounts.find((a) => a.id === fund.accountId)?.name : 'il conto del fondo'}</div></div>
      <div><div class="k">4 · Debiti fiscali effettivamente pagati</div><div class="v num">${amt(L.paid.total)}</div><div class="s small muted">INPS ${formatEuro(L.paid.inps)} · imposta ${formatEuro(L.paid.imposta)}</div></div></div>
      <div class="kv mt12"><span class="k"><b>Ancora da versare (stima)</b></span><span class="num"><b>${amt(L.estimate.stillDue)}</b></span><span class="k">${L.earmarked.reservedNow - L.estimate.stillDue >= 0 ? 'Riserva in eccesso' : 'Riserva mancante'}</span><span class="num ${L.earmarked.reservedNow - L.estimate.stillDue < 0 ? 'neg' : ''}">${amt(Math.abs(L.earmarked.reservedNow - L.estimate.stillDue))}</span></div>
      <div class="note"><b>Formula:</b> reddito = compenso × ${pct(tp.coefficientBp)} · INPS = reddito × ${pct(tp.inpsBp)} · imposta = ${tp.inpsDeduction === 'paid' ? '(reddito − INPS <u>versati</u> nell\'anno)' : '(reddito − INPS)'} × ${pct(tp.taxBp)}. ${tp.inpsDeduction === 'paid' ? 'Metodo prudente: i contributi si deducono solo quando li versi davvero.' : 'I contributi maturati sullo stesso reddito sono dedotti.'} Registra i versamenti nelle categorie "Previdenza · contributi INPS versati" e "Imposte · imposta sostitutiva versata": gli accantonamenti virtuali e i bonifici <b>non</b> sono pagamenti.</div></section>
    <section class="card"><h2>Tasse sull'incassato del ${year} <button class="link-btn small" data-action="tax-opening">${L.estimate.opening ? 'Modifica dati iniziali' : 'Aggiungi già incassato'}</button></h2>
      <p class="small mt0">Si contano solo gli incassi <b>realmente ricevuti</b> nell'anno (per cassa): una fattura di dicembre incassata a gennaio entra nel ${year + 1}.</p>
      <div class="kv"><span class="k">Incassato nel ${year}</span><span class="num">${amt(L.estimate.ricavi)}</span>
        ${L.estimate.opening ? html`<span class="k small muted">· inserito a mano fino al ${formatDate(L.estimate.opening.untilDate)}</span><span class="num small muted">${formatEuro(L.estimate.opening.ricaviCents)}</span><span class="k small muted">· registrato nell'app</span><span class="num small muted">${formatEuro(L.estimate.ricaviFromApp)}</span>` : ''}
        <span class="k">Imponibile (${pct(tp.coefficientBp)})</span><span class="num">${amt(L.estimate.base)}</span>
        <span class="k">Contributi INPS (${pct(tp.inpsBp)})</span><span class="num">${amt(L.estimate.inpsDue)}</span>
        <span class="k">Imposta sostitutiva (${pct(tp.taxBp)})</span><span class="num">${amt(L.estimate.impostaDue)}</span>
        <span class="k"><b>Dovuto stimato sull'incassato</b></span><span class="num"><b>${amt(L.estimate.totalDue)}</b></span>
        <span class="k">Già versato (INPS + imposta)</span><span class="num">${amt(L.paid.total)}</span>
        <span class="k"><b>Resta da versare</b></span><span class="num"><b>${amt(L.estimate.stillDue)}</b></span></div>
      ${L.estimate.scenario.expectedRest > 0 ? html`<div class="note"><b>Scenario a fine anno</b> (non garantito): se incassi anche i ${formatEuro(L.estimate.scenario.expectedRest)} ancora attesi entro il 31 dicembre, il dovuto sale a <b>${formatEuro(L.estimate.scenario.totalDue)}</b> e resta da versare <b>${formatEuro(L.estimate.scenario.stillDue)}</b>.</div>` : ''}
      ${L.estimate.opening ? '' : html`<div class="note">L'app parte dai tuoi primi incassi registrati. Se hai già incassato o versato qualcosa quest'anno <b>prima di usarla</b>, aggiungilo con "Aggiungi già incassato": senza, la stima è troppo bassa.</div>`}
      <div class="note">Quanto pagare e quando (saldo e acconti) dipende dalla tua situazione: l'app stima il <b>dovuto sul fatturato incassato</b>, non fissa le scadenze. Verificale con il commercialista.</div></section>
    <section class="card"><h2>Stima teorica su UNA fattura da 1.000 €</h2><div class="kv"><span class="k">Reddito imponibile (${pct(tp.coefficientBp)})</span><span class="num">${amt(ex.base)}</span><span class="k">Contributi (${pct(tp.inpsBp)})</span><span class="num">${amt(ex.inps)}</span><span class="k">Imposta (${pct(tp.taxBp)} su reddito − INPS)</span><span class="num">${amt(ex.imposta)}</span><span class="k"><b>Totale teorico</b></span><span class="num"><b>${amt(ex.total)}</b></span></div>
      <div class="note">Solo un riferimento per i compensi senza regola. <b>Non è il debito annuale</b>. La riserva di ogni cliente è la tua regola (Incassi → Fatture ricorrenti).</div></section>` : ''}
    <section class="card"><div class="note">Aliquote, coefficiente, scadenze di acconti e saldo, soglie e massimali cambiano nel tempo e dipendono dalla tua situazione: l'app fa una <b>stima per accantonare</b>, non un calcolo fiscale ufficiale. Verifica con il tuo commercialista.</div></section></div>`;
}
function settingsCalendar(app, back) {
  const st = app.state;
  const n = st.planned.filter((p) => p.status === 'planned').length + st.invoiceTemplates.filter((t) => t.active !== false).length;
  return html`<div class="screen no-tabs">${back}${topbar('Calendario e avvisi')}
    <section class="card"><h2>Notifiche sull'iPhone</h2><p class="small mt0">Una app installata dalla Home non può inviare notifiche in background senza un server esterno, e questa app non si collega a nessun server. La soluzione che resta <b>privata e gratuita</b> è usare il <b>Calendario</b> di iOS: esporti le scadenze e l'iPhone ti avvisa con le sue notifiche.</p>
      <div class="kv"><span class="k">Voci da esportare</span><span>${n}</span></div><button class="btn primary block mt12" data-action="export-ics" ${n ? '' : raw('disabled')}>Esporta scadenze nel Calendario</button>
      <div class="note"><b>Procedura sicura contro i duplicati:</b> alla prima importazione scegli o crea un calendario dedicato chiamato <b>Finanze</b>. Quando cambi scadenze, <b>elimina il calendario "Finanze"</b> (Calendario → Calendari → ⓘ → Elimina calendario) e reimporta il nuovo file: è il metodo che non può lasciare doppioni né promemoria vecchi.</div>
      <div class="note">Ogni evento ha un identificativo stabile e un numero di revisione, e le scadenze pagate o annullate sono segnate come annullate: molti calendari aggiornano da soli reimportando, ma questo comportamento <b>va verificato sul tuo iPhone</b> (prova con una sola scadenza prima di fidarti).</div></section>
    <section class="card"><h2>Dentro l'app</h2><p class="small mt0">Quando apri l'app, in Panoramica trovi "Da pagare / incassare" con le scadenze entro 7 giorni e quelle in ritardo, con un tocco per segnare pagato o incassato.</p></section></div>`;
}

// ───────────────────────────── Analisi guadagni/costi ─────────────────────────────
export function cashflowCard(app) {
  const st = app.state;
  const cf = cashflowByMonth(st, app.today, 6);
  const sum = (k) => cf.rows.reduce((t, r) => t + r[k], 0);
  return html`<section class="card"><h2>Entrate e uscite previste <button class="link-btn small" data-action="export-report">Esporta</button></h2>
    ${cashflowChart(cf.rows)}
    <div class="legend"><span><i class="lg-exp2"></i>Entrate previste (non garantite)</span><span><i class="lg-exp"></i>Scadenze</span><span><i class="lg-bud"></i>Budget</span><span><i class="lg-inv"></i>Investimenti</span></div>
    <div class="tbl-wrap mt8"><table class="tbl"><thead><tr><th>Mese</th><th>Entrate</th><th>Uscite</th><th>Netto</th></tr></thead><tbody>${cf.rows.map((r) => html`<tr><td>${monthLabel(r.month, true)}</td><td>${formatEuro(r.inExpected)}</td><td>${formatEuro(r.outTotal)}</td><td>${amt(r.netWithExpected, { tone: true })}</td></tr>`)}<tr><td><b>Totale</b></td><td><b>${formatEuro(sum('inExpected'))}</b></td><td><b>${formatEuro(sum('outTotal'))}</b></td><td><b>${amt(sum('netWithExpected'), { tone: true })}</b></td></tr></tbody></table></div>
    <div class="note">Le entrate comprendono gli incassi attesi e le fatture ricorrenti future: <b>non sono garantite</b> e la liquidità prudente non le conta. Le uscite includono budget settimanale, scadenze e PAC.</div></section>`;
}

export function viewAnalysis(app) {
  const st = app.state, today = app.today;
  const months = [3, 6, 12].includes(app.ui.analysisRange) ? app.ui.analysisRange : 6;
  const rep = monthlyReport(st, today, months);
  const sel = app.ui.analysisMonth && rep.some((m) => m.month === app.ui.analysisMonth) ? app.ui.analysisMonth : rep.at(-1).month;
  const m = rep.find((x) => x.month === sel);
  const prev = rep[rep.findIndex((x) => x.month === sel) - 1];
  const cats = categoryBreakdown(st, sel);
  const prevCats = prev ? Object.fromEntries(categoryBreakdown(st, prev.month).map((c) => [c.id, c.cents])) : null;
  const maxCat = Math.max(1, ...cats.map((c) => c.cents));
  const k = kpis(st, today);
  const trend = categoryTrend(st, today, months, 5);
  const wb = weeklyBudget(st, today, 8);
  const net = m.net;
  const base = Math.max(m.income, m.expense + m.tax, 1);
  const w = (c) => ((Math.max(0, c) / base) * 100).toFixed(1);
  const pc = (x) => (x === null ? '—' : Math.round(x * 100) + '%');
  const delta = (cur, old) => (old === undefined || old === null || (cur === 0 && old === 0) ? '' : html`<span class="small delta ${cur > old ? 'up' : 'down'}">${cur > old ? '▲' : '▼'} ${formatEuro(Math.abs(cur - old))}</span>`);
  const row2 = (a, b) => html`<div class="row2"><span>${a}</span><b>${b}</b></div>`;
  return html`<div class="screen"><button class="back" data-nav="overview">${I.back}Panoramica</button>${topbar('Analisi', `Statistiche e andamento`, html`<button class="btn sm" data-action="export-report">Esporta</button>`)}
    <div class="range-chips">${[3, 6, 12].map((n) => html`<button class="chip" data-action="set-range" data-v="${n}" aria-pressed="${n === months}">${n} mesi</button>`)}</div>
    <section class="card"><h2>Indicatori <span class="small muted">media ultimi ${k.monthsOfData || 0} mesi completi</span></h2>
      ${k.monthsOfData === 0 ? html`<div class="muted small">Servono almeno un mese completo di movimenti.</div>` : html`<div class="kpi3">
        <div><div class="k">Incassi medi / mese</div><div class="v num">${formatEuro(k.avgIncome)}</div></div>
        <div><div class="k">Spese medie / mese</div><div class="v num">${formatEuro(k.avgExpense)}</div></div>
        <div><div class="k">Quota che ti resta</div><div class="v num">${pc(k.savingsRate)}</div><div class="s">dopo spese e riserva</div></div>
        <div><div class="k">Autonomia</div><div class="v num">${k.runwayMonths === null ? '—' : k.runwayMonths.toFixed(1).replace('.', ',') + ' mesi'}</div><div class="s">liquidità ÷ spese medie</div></div></div>`}</section>
    <section class="card"><h2>Entrate e uscite per mese</h2><div class="small muted">Tocca un mese per il dettaglio.</div>
      ${flowChart(rep, { selected: sel, height: 200 })}${flowLegend()}
      <div class="chart-detail"><div class="t"><b>${monthLabel(sel)}</b></div>
        ${row2('Incassato', formatEuro(m.income))}${row2('Spese', formatEuro(m.expense))}${row2('Riserva fiscale accantonata', formatEuro(m.tax))}${row2('📈 Investito (PAC)', formatEuro(m.invested))}${row2('Disponibile dopo spese e riserva', formatEuro(net))}${row2('Stima teorica tasse', formatEuro(m.taxEstimate))}
        ${m.income > 0 ? html`<div class="ratio mt8" aria-hidden="true"><i class="r-exp" data-w="${w(m.expense)}"></i><i class="r-tax" data-w="${w(m.tax)}"></i><i class="r-net" data-w="${w(net)}"></i></div><div class="small muted">Ti resta il <b>${pc(m.savingsRate)}</b> di quanto incassato (gli investimenti non sono spesa).</div>` : html`<div class="small muted mt8">Nessun incasso in questo mese.</div>`}
        ${st.settings.taxProfile.enabled ? '' : html`<div class="note">Attiva "Tasse e contributi" in Impostazioni per accantonare le tasse a ogni incasso.</div>`}</div></section>
    <section class="card"><h2>Liquidità a fine mese</h2>${balanceChart(balanceHistory(st, today, months), [])}${balanceHistory(st, today, months).some((h) => h.partial) ? html`<div class="note">Alcuni conti hanno il saldo "da aggiornare": i mesi con dati parziali non sono tracciati.</div>` : ''}</section>
    ${wb.started && wb.weeks.length ? html`<section class="card"><h2>Budget settimanale</h2>${budgetChart(wb.weeks, wb.base)}<div class="legend"><span><i class="lg-pos"></i>Dentro il budget</span><span><i class="lg-neg"></i>Sforato</span><span><i class="lg-net"></i>Disponibile (budget + riporto)</span></div></section>` : ''}
    <section class="card"><h2>Spese per categoria · ${monthLabel(sel)}</h2>${cats.length === 0 ? empty('Nessuna spesa') : html`<ul class="list">${cats.map((c) => html`<li class="item block-item"><div class="row"><span class="tile sm col-${c.color}">${c.icon}</span><div class="grow t">${c.name}</div><div class="num">${amt(c.cents)}</div></div>${prevCats ? html`<div class="small muted">vs mese prima ${delta(c.cents, prevCats[c.id] ?? 0)}</div>` : ''}<div class="hbar"><i class="col-${c.color}" data-w="${Math.round((c.cents / maxCat) * 100)}"></i></div>${c.children?.map((kc) => html`<div class="row small muted sub-row"><span>↳ ${kc.icon} ${kc.name}</span><span class="grow"></span><span class="num">${amt(kc.cents)}</span></div>`)}</li>`)}</ul>`}
      <div class="note">Le spese non includono investimenti (PAC), pagamenti di imposte e contributi (già coperti dalla riserva) né trasferimenti tra conti.</div></section>
    ${trend.series.length ? html`<section class="card"><h2>Categorie nel tempo</h2>${stackedChart(trend)}<div class="legend">${trend.series.map((c) => html`<span><i class="col-${c.color}"></i>${c.name}</span>`)}</div></section>` : ''}
    <section class="card"><h2>Tabella mensile</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mese</th><th>Incassi</th><th>Spese</th><th>Riserva</th><th>Resta</th></tr></thead><tbody>${[...rep].reverse().map((x) => html`<tr><td>${monthLabel(x.month, true)}</td><td>${formatEuro(x.income)}</td><td>${formatEuro(x.expense)}</td><td>${formatEuro(x.tax)}</td><td>${amt(x.net, { tone: true })}</td></tr>`)}</tbody></table></div></section></div>`;
}

// ───────────────────────────── Stato dei dati: configurato / previsto / da confermare ─────────────────────────────
function settingsStatus(app, back) {
  const st = app.state, today = app.today, snap = snapshot(st);
  const nm = (id) => st.accounts.find((a) => a.id === id)?.name ?? '—';
  const unknown = st.accounts.filter((a) => a.balanceUnknown && !a.archived);
  const pending = pendingTransfers(st, snap);
  const open = st.receivables.filter((r) => r.status === 'expected' || r.status === 'partial');
  const planned = st.planned.filter((p) => p.status === 'planned');
  const toConfirm = planned.filter((p) => p.confirm);
  const due = dueItems(st, today, 7);
  const funded = st.funds.filter((f) => !f.archived && snap.funds[f.id].available > 0).length;
  const sec = (title, sub) => html`<div class="section-title">${title}</div><div class="small muted status-sub">${sub}</div>`;
  return html`<div class="screen no-tabs">${back}${topbar('Stato dei dati', 'Cosa è configurato, cosa è previsto, cosa devi confermare')}
    <button class="btn block" data-action="update-balances">Aggiorna i saldi di tutti i conti</button>
    ${sec('1 · Dati configurati', 'Impostazioni di partenza: non sono movimenti. Si modificano senza perdere lo storico.')}
    <div class="card"><div class="kv"><span class="k">Conti</span><span>${st.accounts.filter((a) => !a.archived).length}${st.accounts.some((a) => a.origin === 'profile') ? ' · dal profilo' : ''}</span>
      <span class="k">Fondi e obiettivi</span><span>${st.funds.filter((f) => !f.archived).length} · finanziati: ${funded}</span>
      <span class="k">Regole di fatturazione</span><span>${st.invoiceTemplates.length}</span><span class="k">Scadenze ricorrenti</span><span>${planned.length}</span>
      <span class="k">Profilo fiscale</span><span>${st.settings.taxProfile.enabled ? (st.settings.taxProfile.verifiedYear === Number(today.slice(0, 4)) ? 'attivo · verificato' : 'attivo · aliquote da verificare') : 'non attivo'}</span>
      <span class="k">Budget settimanale</span><span class="num">${amt(st.settings.budget.weeklyCents)}</span></div></div>
    ${sec('2 · Movimenti previsti', 'Pianificazione: NON sono denaro e non toccano i saldi.')}
    <div class="card"><div class="kv"><span class="k">Incassi previsti</span><span>${open.length} · ${formatEuro(open.reduce((t, r) => t + r.expectedCents - (r.receivedCents ?? 0), 0))}</span>
      <span class="k">Scadenze e spese ricorrenti</span><span>${planned.length}${toConfirm.length ? ` · ${toConfirm.length} da confermare` : ''}</span></div></div>
    ${sec('3 · Movimenti effettivi da confermare', 'Diventano dati reali solo quando li confermi tu.')}
    <div class="card">${unknown.length + pending.length + due.length + toConfirm.length === 0 ? empty('Niente da confermare') : html`<ul class="list">
      ${unknown.map((a) => html`<li class="item"><span class="tile sm col-amber">${a.emoji ?? '🏦'}</span><div class="grow"><div class="t">Saldo da aggiornare</div><div class="s">${a.name}</div></div><button class="btn sm primary" data-action="set-balance" data-id="${a.id}">Imposta</button></li>`)}
      ${pending.map((p) => html`<li class="item"><span class="tile sm col-amber">🏦</span><div class="grow"><div class="t">Bonifico da confermare · ${formatEuro(p.cents)}</div><div class="s">${nm(p.fromAccountId)} → ${nm(p.toAccountId)}</div></div><button class="btn sm primary" data-action="confirm-transfer" data-fund="${p.fundId}" data-from="${p.fromAccountId}" data-to="${p.toAccountId}" data-cents="${p.cents}">Fatto</button></li>`)}
      ${due.map((d) => html`<li class="item"><span class="tile sm col-${d.type === 'in' ? 'green' : d.late ? 'red' : 'gray'}">${d.icon}</span><div class="grow"><div class="t ellipsis">${d.title}</div><div class="s">${d.sub} · ${formatDate(d.date)}</div></div><button class="btn sm primary" data-action="${d.type === 'pay' ? 'complete-planned' : 'receive'}" data-id="${d.id}">${d.type === 'in' ? 'Incassata' : 'Pagato'}</button></li>`)}
      ${toConfirm.map((p) => html`<li class="item"><span class="tile sm col-purple">${KIND_ICON[p.kind]}</span><div class="grow"><div class="t">${p.name}</div><div class="s">${p.confirm === 'active' ? 'Da confermare come attiva' : 'Data da confermare'}</div></div><button class="btn sm primary" data-action="${p.confirm === 'active' ? 'confirm-planned' : 'planned'}" data-id="${p.id}">${p.confirm === 'active' ? 'Conferma' : 'Imposta data'}</button></li>`)}</ul>`}</div></div>`;
}

// ───────────────────────────── Situazione a una data ─────────────────────────────
const SIT_STATUS = { ok: ['Coperta', 'pos'], con_incassi: ['Solo se arrivano gli incassi', 'warn'], scoperta: ['NON coperta', 'neg'] };
export function viewSituation(app) {
  const st = app.state, today = app.today;
  const maxD = addDaysD(today, 365);
  let until = app.ui.situationUntil ?? monthEndOf(today);
  if (until < addDaysD(today, 1)) until = addDaysD(today, 1);
  if (until > maxD) until = maxD;
  const r = situationAt(st, today, until);
  const v = r.verdict, T = r.totals;
  const verdictBox = v.level === 'ok'
    ? html`<div class="alert ok">${I.check}<span>Fino al <b>${formatDate(until, { year: true })}</b> le spese previste sono <b>coperte anche senza gli incassi previsti</b>. Libero minimo ${formatEuro(v.minFree)} (${formatDate(v.minFreeDate)}).</span></div>`
    : v.level === 'attenzione'
      ? html`<div class="alert">${I.warn}<span>Senza gli incassi previsti mancano <b>${formatEuro(v.shortfallPrudent)}</b> (punto più basso il ${formatDate(v.minFreeDate)}). <b>Con</b> gli incassi previsti è tutto coperto: ${v.dependOnReceipts} ${v.dependOnReceipts === 1 ? 'spesa dipende' : 'spese dipendono'} da incassi non ancora ricevuti.</span></div>`
      : html`<div class="alert high">${I.warn}<span>Anche contando gli incassi previsti mancano <b>${formatEuro(v.shortfallWithExpected)}</b> (il ${formatDate(v.minFreeWithExpectedDate)}). ${v.uncovered} ${v.uncovered === 1 ? 'spesa non è coperta' : 'spese non sono coperte'}.</span></div>`;
  const row2 = (a, b, cls = '') => html`<div class="row2 ${cls}"><span>${a}</span><b class="num">${b}</b></div>`;
  const ins = r.lines.filter((l) => l.dir === 'in'), outs = r.lines.filter((l) => l.dir === 'out');
  return html`<div class="screen"><button class="back" data-nav="plan">${I.back}Pianificazione</button>
    ${topbar('Situazione a una data', `da oggi al ${formatDate(until, { year: true })}`, html`<button class="btn sm" data-action="export-situation">Esporta</button>`)}
    <div class="chips">${[['eom', 'Fine mese'], ['eom2', 'Fine mese prossimo'], ['dec', '31 dic']].map(([k, t]) => html`<button class="chip" data-action="open-situation" data-v="${k}">${t}</button>`)}</div>
    <label class="field"><span>Oppure scegli una data (entro 365 giorni)</span><input type="date" name="until" value="${until}" min="${addDaysD(today, 1)}" max="${maxD}" data-change="situation-date"></label>
    ${v.partial.length ? html`<div class="alert">${I.warn}<span>Saldi da aggiornare: ${v.partial.join(', ')}. Il calcolo è <b>parziale</b>.</span></div>` : ''}
    ${verdictBox}
    <section class="card"><h2>In sintesi</h2>
      ${row2('Liquidità oggi', formatEuro(r.start.total))}${row2('di cui vincolata a fondi', formatEuro(r.start.reserved))}${row2('Libera oggi', formatEuro(r.start.free), 'strong')}
      <div class="sep"></div>
      ${row2('Entrate previste (non garantite)', formatEuro(T.inExpected))}${row2('di cui da accantonare (tasse)', formatEuro(T.inExpected - T.inFree))}
      ${row2('Uscite previste', formatEuro(T.outTotal))}${row2('· scadenze e spese fisse', formatEuro(T.outFixed))}${row2('· budget settimanale', formatEuro(T.outBudget))}${row2('· investimenti (PAC)', formatEuro(T.outInvest))}
      <div class="sep"></div>
      ${row2('Libero a fine periodo · prudente', formatEuro(T.freeEnd), T.freeEnd < 0 ? 'neg' : 'strong')}${row2('Libero a fine periodo · con incassi previsti', formatEuro(T.freeEndWithExpected), T.freeEndWithExpected < 0 ? 'neg' : 'strong')}
      <div class="note">Prudente = solo i soldi che hai oggi. "Con incassi" include quelli previsti, che <b>non sono garantiti</b>; gli incassi entrano al netto della riserva fiscale. Il libero esclude il denaro già riservato ai fondi.</div></section>
    <section class="card"><h2>Mese per mese</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mese</th><th>Entrate</th><th>Uscite</th><th>Libero fine (prudente)</th><th>Libero fine (con incassi)</th></tr></thead><tbody>
      ${r.months.map((m) => html`<tr><td>${m.label.split(' ')[0]}${m.partialStart ? ' (da oggi)' : ''}${m.partialEnd ? ' (fino al ' + formatDate(m.to) + ')' : ''}</td><td>${formatEuro(m.inExpected)}</td><td>${formatEuro(m.outTotal)}</td><td>${amt(m.freeEnd, { tone: true })}</td><td>${amt(m.freeEndWithExpected, { tone: true })}</td></tr>`)}</tbody></table></div></section>
    <section class="card"><h2>Entrate previste <span class="small muted">${formatEuro(T.inExpected)}</span></h2>
      ${ins.length === 0 ? empty('Nessun incasso previsto nel periodo') : html`<ul class="list">${ins.map((l) => html`<li class="item"><div class="grow"><div class="t">${l.label}${l.projected ? html` ${pill('da fattura ricorrente')}` : ''}</div><div class="s">${formatDate(l.date)} · accantoni ${formatEuro(l.total - l.free)} · liberi ${formatEuro(l.free)}</div></div><div class="r num">${amt(l.total, { plus: true, tone: true })}</div></li>`)}</ul>`}
      ${r.overdue.length ? html`<div class="note"><b>Già scaduti e non ricevuti (non contati):</b> ${r.overdue.map((o) => `${o.client} ${formatEuro(o.cents)} (atteso il ${formatDate(o.date)})`).join(' · ')}. Se arrivano, aumentano il libero.</div>` : ''}</section>
    <section class="card"><h2>Uscite previste <span class="small muted">${formatEuro(T.outTotal)}</span></h2>
      ${outs.length === 0 ? empty('Nessuna uscita prevista nel periodo') : html`<ul class="list">${outs.map((l) => { const [txt, tone] = SIT_STATUS[l.status]; return html`<li class="item block-item"><div class="row"><div class="grow"><div class="t">${l.label}</div><div class="s">${formatDate(l.date)}${l.type === 'budget' ? ' · budget' : l.type === 'investimento' ? ' · investimento' : ''}${l.covered ? ` · già riservati ${formatEuro(l.covered)}` : ''}</div></div><div class="r num">${amt(l.total)}</div></div><div class="row between small"><span>${pill(txt, tone)}</span><span class="muted">libero dopo: ${formatEuro(l.freeAfter)}${l.freeAfter < 0 ? ` · con incassi ${formatEuro(l.freeAfterWithExpected)}` : ''}</span></div></li>`; })}</ul>`}</section>
    ${r.tax ? html`<section class="card"><h2>Tasse ${r.tax.year}</h2>${row2('Ancora da versare nell\'anno (stima)', formatEuro(r.tax.stillDue))}${row2('Riservato nel fondo tasse', formatEuro(r.tax.reserved))}${row2(r.tax.reserved >= r.tax.stillDue ? 'Riserva in eccesso' : 'Riserva mancante', formatEuro(Math.abs(r.tax.reserved - r.tax.stillDue)), r.tax.reserved < r.tax.stillDue ? 'neg' : '')}<div class="note">Le tasse sono <b>incluse tra le uscite sopra solo se le hai messe tra le scadenze</b>. Questa è la stima sull'incassato dell'anno, a parte.</div></section>` : ''}</div>`;
}
function monthEndOf(d) { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); return `${d.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; }
