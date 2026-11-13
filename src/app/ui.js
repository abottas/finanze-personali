// Componenti di presentazione riutilizzabili.
import { html, raw } from './html.js';
import { formatEuro, toInputValue } from '../core/money.js';
import { BANKS, COLOR_KEYS, EMOJIS } from '../core/palette.js';

export const amt = (c, { plus = false, tone = false, symbol = true } = {}) =>
  html`<span class="amt ${tone ? (c < 0 ? 'neg' : c > 0 ? 'pos' : '') : ''}">${formatEuro(c, { plus, symbol })}</span>`;

export function field(name, label, { value = '', type = 'text', hint = '', attrs = '', cls = '' } = {}) {
  return html`<label class="field ${cls}"><span>${label}</span><input name="${name}" type="${type}" value="${value}" autocomplete="off" autocapitalize="sentences" ${raw(attrs)}>${hint ? html`<small class="hint">${hint}</small>` : ''}</label>`;
}
export function moneyField(name, label, cents = null, { hint = '', cls = '', required = true } = {}) {
  return html`<label class="field ${cls}"><span>${label}</span><input class="money" name="${name}" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${cents == null ? '' : toInputValue(Math.abs(cents))}" ${required ? raw('required') : ''}>${hint ? html`<small class="hint">${hint}</small>` : ''}</label>`;
}
export function select(name, label, options, selected = '', { cls = '', hint = '', change = '' } = {}) {
  return html`<label class="field ${cls}"><span>${label}</span><select name="${name}" ${change ? raw(`data-change="${change}"`) : ''}>${options.map(([v, t]) => html`<option value="${v}" ${String(v) === String(selected) ? raw('selected') : ''}>${t}</option>`)}</select>${hint ? html`<small class="hint">${hint}</small>` : ''}</label>`;
}
export function segmented(name, options, selected, dataSet = null) {
  return html`<div class="seg" role="radiogroup">${options.map(([v, t]) => html`<label><input type="radio" name="${name}" value="${v}" ${v === selected ? raw('checked') : ''} ${dataSet ? raw(`data-sets="${dataSet}"`) : ''}><span>${t}</span></label>`)}</div>`;
}
export const empty = (title, text = '') => html`<div class="empty"><b>${title}</b>${text}</div>`;
export const pill = (text, tone = '') => html`<span class="pill ${tone}">${text}</span>`;
export const bar = (pct, tone = '') => html`<div class="bar ${tone}"><i data-w="${Math.max(0, Math.min(100, Math.round(pct)))}"></i></div>`;
export const pctOf = (a, b) => (b > 0 ? (a / b) * 100 : 0);

// ── Tessere riconoscibili (logo/icona + colore) ──
export function tile({ logo = null, icon = null, color = 'gray', mono = '', size = '' } = {}) {
  if (logo) return html`<span class="tile ${size}"><img src="${logo}" alt=""></span>`;
  return html`<span class="tile col-${color} ${size}">${icon || mono}</span>`;
}
export const accountTile = (a, size = '') => {
  const b = BANKS[a.bank];
  return tile({ logo: a.logo, icon: a.emoji, color: a.color || b?.color || 'gray', mono: b?.mono || (a.name || '?').slice(0, 1).toUpperCase(), size });
};
export const fundTile = (f, size = '') => tile({ icon: f.icon, color: f.color, size });
export const catTile = (c, size = '') => tile({ icon: c?.icon ?? '🏷️', color: c?.color ?? 'gray', size });

export function swatches(name, selected, { allowAuto = false } = {}) {
  return html`<div class="swatches" role="radiogroup" aria-label="Colore">${allowAuto ? html`<label><input type="radio" name="${name}" value="" ${!selected ? raw('checked') : ''}><span class="sw auto">auto</span></label>` : ''}${COLOR_KEYS.map((k) => html`<label><input type="radio" name="${name}" value="${k}" ${k === selected ? raw('checked') : ''}><span class="sw col-${k}"></span></label>`)}</div>`;
}
export function emojiPicker(name, selected, { allowNone = false } = {}) {
  return html`<div class="emojis" role="radiogroup" aria-label="Icona">${allowNone ? html`<label><input type="radio" name="${name}" value="" ${!selected ? raw('checked') : ''}><span class="em">–</span></label>` : ''}${EMOJIS.map((e) => html`<label><input type="radio" name="${name}" value="${e}" ${e === selected ? raw('checked') : ''}><span class="em">${e}</span></label>`)}</div>`;
}
export const labeled = (label, inner) => html`<div class="field"><span>${label}</span>${inner}</div>`;
