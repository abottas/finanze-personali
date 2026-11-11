// Esportazione delle scadenze in un file calendario (.ics): l'iPhone mostra gli avvisi con le notifiche
// NATIVE del Calendario, senza server e senza inviare dati a nessuno (una PWA non può fare notifiche push
// in background senza un server).
//
// COME SI EVITANO DUPLICATI E SI AGGIORNANO LE MODIFICHE (RFC 5545):
//  • UID stabile per ogni voce (fp-<tipo>-<id>): lo stesso evento ha sempre lo stesso UID, in ogni esportazione.
//  • SEQUENCE crescente (= numero di voci dello storico, sempre in aumento) e DTSTAMP = momento dell'esportazione:
//    un client calendario riconosce la revisione più recente di un UID già noto e lo aggiorna invece di duplicarlo.
//  • Le voci pagate/annullate/non più attive vengono riemesse come STATUS:CANCELLED con lo stesso UID, così il
//    promemoria scompare dopo la reimportazione.
//  Il comportamento REALE di Calendario su iPhone alla reimportazione NON è verificabile da qui: per questo la
//  procedura sicura consigliata è un calendario dedicato "Finanze" che si elimina e si reimporta (vedi docs).
import { addDays } from './dates.js';

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const d8 = (d) => d.replaceAll('-', '');
const enc = new TextEncoder();
function fold(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const RR = { weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', quarterly: 'FREQ=MONTHLY;INTERVAL=3', yearly: 'FREQ=YEARLY' };
/** Allarme alle 9:00 del giorno (d=0) o di d giorni prima, per un evento "tutto il giorno". */
const alarm = (d, text) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(text)}`, d === 0 ? 'TRIGGER:PT9H' : `TRIGGER:-P${d}DT15H`, 'END:VALARM'];
const stampOf = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/Z?$/, 'Z');

export function buildIcs(state, { today, nowIso = null, includeAmounts = false, euro = (c) => (c / 100).toFixed(2).replace('.', ',') + ' €' } = {}) {
  const seq = state.audit.length;
  const stamp = stampOf(nowIso ?? today + 'T00:00:00.000Z');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Finanze personali//IT', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Finanze', 'X-WR-TIMEZONE:Europe/Rome'];
  const uids = new Set();
  const ev = (uid, date, summary, { rrule, desc, alarms = [0], cancelled = false } = {}) => {
    if (uids.has(uid)) return;           // mai due eventi con lo stesso UID nello stesso file
    uids.add(uid);
    L.push('BEGIN:VEVENT', `UID:${uid}@finanze.local`, `DTSTAMP:${stamp}`, `SEQUENCE:${seq}`, `DTSTART;VALUE=DATE:${d8(date)}`, `DTEND;VALUE=DATE:${d8(addDays(date, 1))}`, `SUMMARY:${esc(summary)}`);
    if (desc) L.push(`DESCRIPTION:${esc(desc)}`);
    if (cancelled) L.push('STATUS:CANCELLED');
    else {
      if (rrule) L.push(`RRULE:${rrule}`);
      for (const d of alarms) L.push(...alarm(d, summary));
    }
    L.push('END:VEVENT');
  };
  const amt = (c) => (includeAmounts ? ` (${euro(c)})` : '');
  for (const p of state.planned) {
    if (p.confirm) continue;               // data o attività da confermare: nessun promemoria finché non è certa
    const live = p.status === 'planned';
    const days = [...new Set([p.remindDays, 0])].sort((a, b) => b - a);
    const icon = p.kind === 'subscription' ? '🔁' : p.kind === 'renewal' ? '📅' : p.kind === 'investment' ? '📈' : '💸';
    ev(`fp-planned-${p.id}`, p.dueDate, `${icon} ${p.name}${amt(p.cents)}${p.autoPay ? ' · addebito automatico' : ''}`, { rrule: RR[p.recurrence], alarms: days, desc: p.autoPay ? 'Verifica l\'addebito e segna il pagamento nell\'app.' : 'Segna il pagamento nell\'app.', cancelled: !live });
  }
  for (const t of state.invoiceTemplates) {
    ev(`fp-invoice-${t.id}`, nextDay(today, t.invoiceDay), `🧾 Emetti fattura: ${t.client}${amt(t.cents)}`, { rrule: 'FREQ=MONTHLY', alarms: [1, 0], cancelled: t.active === false });
  }
  for (const r of state.receivables) {
    const live = r.status === 'expected' || r.status === 'partial';
    if (!live && r.expectedDate < addDays(today, -120)) continue;         // storico remoto: non serve riemetterlo
    if (live && r.expectedDate < addDays(today, -7)) continue;
    ev(`fp-receivable-${r.id}`, live && r.expectedDate < today ? today : r.expectedDate, `💶 Controlla incasso: ${r.client}${amt(r.expectedCents)}`, { alarms: [0], cancelled: !live });
  }
  for (const f of state.funds) {
    if (f.kind !== 'goal' || !f.goal?.deadline) continue;
    ev(`fp-goal-${f.id}`, f.goal.deadline, `${f.icon ?? '⭐'} Scadenza obiettivo: ${f.name}${amt(f.goal.targetCents)}`, { alarms: [7, 0], cancelled: !!f.archived || f.goal.deadline < today });
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
function nextDay(today, day) {
  const [y, m] = today.split('-').map(Number);
  const mk = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(day, new Date(Date.UTC(yy, mm, 0)).getUTCDate())).padStart(2, '0')}`;
  const cand = mk(y, m);
  if (cand >= today) return cand;
  return m === 12 ? mk(y + 1, 1) : mk(y, m + 1);
}
