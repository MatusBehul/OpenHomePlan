// Cost estimate for export: a spreadsheet (CSV) and an HTML table for the printed plans. No DOM.
import { estimate, COST_GROUPS, displayFx, moneyFor, BASE_CURRENCY } from './costs.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const r2 = (v) => Math.round(v * 100) / 100;

// Semicolon-separated with a BOM, so spreadsheet apps in comma-decimal locales open it as columns.
// Amounts are EUR (the currency everything is calculated in), plus the display currency if another.
export function estimateCsv(house) {
  const e = estimate(house);
  const fx = displayFx(house);
  const other = fx.currency !== BASE_CURRENCY && fx.rate ? fx : null;
  const cell = (v) => (typeof v === 'number' ? String(r2(v)) : /[;"\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const head = ['Category', 'Item', 'Included', 'Quantity', 'Unit', 'Unit price EUR', 'Total EUR', ...(other ? [`Total ${other.currency}`] : [])];
  const rows = [head];
  for (const l of e.lines)
    rows.push([COST_GROUPS[l.group] || l.group, l.label, l.included ? 'yes' : 'no', l.qty, l.percent ? '%' : l.unit, l.percent ? '' : l.price, l.total, ...(other ? [l.total * other.rate] : [])]);
  rows.push([]);
  for (const g of e.groups) rows.push([g.label, 'Subtotal', '', '', '', '', g.total, ...(other ? [g.total * other.rate] : [])]);
  rows.push(['', 'Estimated total', '', '', '', '', e.total, ...(other ? [e.total * other.rate] : [])]);
  if (e.budget) rows.push(['', 'Budget', '', '', '', '', e.budget, ...(other ? [e.budget * other.rate] : [])]);
  rows.push(['', 'Living area m²', '', r2(e.living)], ['', 'Per m² of living area', '', '', '', '', e.perLiving]);
  if (other) rows.push(['', `Rate 1 EUR = ${other.rate} ${other.currency} (${other.manual ? "owner's rate" : `ECB ${other.date}`})`]);
  rows.push(['', `${house.name || 'House'}, ${new Date().toISOString().slice(0, 10)}. Quantities from the plan × example or owner's unit prices; not a quote.`]);
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

// Full table of every line, grouped, in the display currency.
export function estimateHtml(house) {
  const e = estimate(house);
  const m = moneyFor(house);
  const fx = displayFx(house);
  const num = (v) => (Math.round(v * 10) / 10).toLocaleString();
  const groups = Object.keys(COST_GROUPS)
    .map((g) => ({ g, lines: e.lines.filter((l) => l.group === g) }))
    .filter((x) => x.lines.length);
  const conv = fx.currency !== BASE_CURRENCY && fx.rate ? ` Converted from EUR at 1 EUR = ${fx.rate} ${esc(fx.currency)} (${fx.manual ? "owner's rate" : `ECB, ${esc(fx.date)}`}).` : '';
  return `
    <h1>${esc(house.name || 'House')} – cost estimate</h1>
    <p class="disclaimer">${new Date().toISOString().slice(0, 10)}. Quantities come from the plan; unit prices are example values or the owner's own figures, not quotes.${conv} Lines marked “not included” are left out of the total.</p>
    <table class="summary">
      <tr><th>Estimated total</th><td>${m(e.total)}</td></tr>
      ${e.budget ? `<tr><th>Budget</th><td>${m(e.budget)} (${e.remaining >= 0 ? `${m(e.remaining)} left` : `${m(-e.remaining)} over`})</td></tr>` : ''}
      <tr><th>Living area</th><td>${num(e.living)} m², ${m(e.perLiving)} per m²</td></tr>
    </table>
    <table>
      <thead><tr><th>Item</th><th class="num">Quantity</th><th>Unit</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead>
      ${groups
        .map(
          ({ g, lines }) => `<tbody>
            <tr class="group"><th colspan="4">${esc(COST_GROUPS[g])}</th><th class="num">${m(lines.reduce((a, l) => a + l.total, 0))}</th></tr>
            ${lines
              .map(
                (l) => `<tr class="${l.included ? '' : 'off'}"><td>${esc(l.label)}${l.included ? '' : ' <em>(not included)</em>'}</td>
                  <td class="num">${l.percent ? `${l.qty} %` : num(l.qty)}</td><td>${l.percent ? '' : esc(l.unit)}</td>
                  <td class="num">${l.percent ? '' : m(l.price)}</td><td class="num">${l.included ? m(l.total) : '–'}</td></tr>`,
              )
              .join('')}
          </tbody>`,
        )
        .join('')}
      <tfoot><tr><th colspan="4">Estimated total</th><th class="num">${m(e.total)}</th></tr></tfoot>
    </table>`;
}
