// The Costs tab: budget, summary, what the budget allows, and the editable price table.
import { estimate, money, COST_GROUPS, DEFAULT_PRICES, ITEM_PRICES, costSettings, displayFx, BASE_CURRENCY } from './costs.js';
import { estimateCsv } from './costExport.js';
import { download, fileSlug } from './download.js';
import { request } from './backend.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// shown until rates have been downloaded once (the ECB list is used after that)
const CURRENCIES = ['EUR', 'CZK', 'PLN', 'HUF', 'CHF', 'GBP', 'USD'];

const downloadRates = (refresh) => request('GET', `api/rates${refresh ? '?refresh=1' : ''}`);
const GROUP_COLORS = { shell: '#7a8699', openings: '#4a90d9', finishes: '#c9a46a', services: '#e08a3c', fittings: '#8bb174', furniture: '#b48ead', site: '#5aa59a', fees: '#a3a3a3' };

export function createCostsView(container, store, onPrint) {
  const settings = () => (store.house.costs ||= {});

  function setSetting(key, value) {
    settings()[key] = value;
    store.changed();
  }

  let rateMessage = '';
  // Download the ECB rates and keep them in the house (so the estimate is reproducible).
  async function updateRates(refresh) {
    rateMessage = 'Downloading exchange rates…';
    render();
    try {
      const data = await downloadRates(refresh);
      settings().rates = { base: data.base, date: data.date, source: data.source, values: data.values };
      rateMessage = data.stale ? `Could not reach the ECB (${data.error}); using the last downloaded rates of ${data.date}.` : '';
      store.changed();
    } catch (err) {
      rateMessage = `Could not download exchange rates: ${err.message}. Type the rate yourself.`;
      render();
    }
  }

  function render() {
    if (container.classList.contains('hidden')) return;
    const e = estimate(store.house);
    const s = costSettings(store.house);
    // all amounts are EUR; show them in the display currency
    const fx = displayFx(store.house);
    const rate = fx.rate || 1;
    const shown = fx.rate ? fx.currency : BASE_CURRENCY;
    const m = (v) => money(v * rate, shown);
    const toShown = (eur) => Math.round(eur * rate * 100) / 100;
    const currencies = [BASE_CURRENCY, ...Object.keys(s.rates?.values || {}).sort()];
    const options = currencies.length > 1 ? currencies : CURRENCIES;
    if (!options.includes(fx.currency)) options.push(fx.currency);
    const over = e.remaining !== null && e.remaining < 0;
    const scale = Math.max(e.total, e.budget || 0) || 1;

    const verdict = !e.budget
      ? 'Enter your budget to see how much house it allows.'
      : over
        ? `Over budget by <b>${m(-e.remaining)}</b>: about <b>${Math.abs(e.headroomM2).toFixed(0)} m²</b> less living area, or switch off optional lines below (pool, greenhouse, furniture…).`
        : `<b>${m(e.remaining)}</b> left: room for about <b>${e.headroomM2.toFixed(0)} m²</b> more living area (≈ ${m(e.perM2)} per extra m²), or for upgrades and the optional items below.`;

    const byGroup = Object.keys(COST_GROUPS).map((g) => ({ g, lines: e.lines.filter((l) => l.group === g) })).filter((x) => x.lines.length);

    container.innerHTML = `
      <div class="costs">
        <div class="cost-settings">
          <label>Budget (${esc(shown)})<input type="number" min="0" step="1000" data-budget value="${e.budget ? Math.round(e.budget * rate) : ''}" placeholder="e.g. ${Math.round(350000 * rate)}"></label>
          <label>Show in<select data-currency>${options.map((c) => `<option ${c === fx.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          ${fx.currency === BASE_CURRENCY
            ? ''
            : `<label>Rate: 1 EUR =<input type="number" min="0" step="any" data-rate value="${fx.rate ?? ''}" placeholder="rate" class="${fx.manual ? 'custom' : ''}"></label>`}
          <label>Design &amp; fees %<input type="number" min="0" max="50" step="0.5" data-set="designPct" value="${s.designPct}"></label>
          <label>Contingency %<input type="number" min="0" max="50" step="0.5" data-set="contingencyPct" value="${s.contingencyPct}"></label>
          <label>Glazing<select data-set="glazing">
            <option value="triple" ${s.glazing !== 'double' ? 'selected' : ''}>Triple (U ≈ 0.6–0.8)</option>
            <option value="double" ${s.glazing === 'double' ? 'selected' : ''}>Double (U ≈ 1.0–1.1)</option>
          </select></label>
          <label class="check"><input type="checkbox" data-set="includeFurniture" ${s.includeFurniture ? 'checked' : ''}> Include loose furniture</label>
        </div>
        ${fx.currency === BASE_CURRENCY
          ? `<p class="fx-note">All prices are kept and calculated in EUR. Choose another currency to see the estimate converted.</p>`
          : `<p class="fx-note ${fx.rate ? '' : 'bad'}">
              ${fx.rate
                ? fx.manual
                  ? `Your own rate: 1 EUR = ${fx.rate} ${esc(fx.currency)}${fx.downloaded ? ` (ECB ${esc(fx.date)}: ${fx.downloaded})` : ''}. <button class="link" id="fx-reset">Use the downloaded rate</button>`
                  : `ECB reference rate of ${esc(fx.date)}: 1 EUR = ${fx.rate} ${esc(fx.currency)}. Type another rate to override it, e.g. your bank's.`
                : `No exchange rate for ${esc(fx.currency)} yet; amounts are shown in EUR.`}
              <button class="link" id="fx-update">${s.rates ? 'Update rates' : 'Download rates'}</button>
              · Prices and the budget are still stored in EUR.
              ${rateMessage ? `<br><span class="bad">${esc(rateMessage)}</span>` : ''}
            </p>`}

        <div class="cost-cards">
          <div class="card"><small>Estimated total</small><b>${m(e.total)}</b></div>
          <div class="card"><small>Budget</small><b>${e.budget ? m(e.budget) : '—'}</b></div>
          <div class="card ${over ? 'bad' : e.budget ? 'good' : ''}"><small>${over ? 'Over budget' : 'Left'}</small><b>${e.remaining === null ? '—' : m(Math.abs(e.remaining))}</b></div>
          <div class="card"><small>Per m² of living area</small><b>${m(e.perLiving)}</b><span>${e.living.toFixed(1)} m² living</span></div>
        </div>
        <p class="verdict ${over ? 'bad' : ''}">${verdict}</p>

        <div class="cost-bar" title="Cost by category${e.budget ? ' against the budget' : ''}">
          ${e.groups.filter((g) => g.total > 0).map((g) => `<span style="width:${(g.total / scale) * 100}%;background:${GROUP_COLORS[g.id]}" title="${esc(g.label)}: ${m(g.total)}"></span>`).join('')}
          ${e.budget ? `<i class="budget-mark" style="left:${(e.budget / scale) * 100}%"><em>budget</em></i>` : ''}
        </div>
        <div class="cost-legend">${e.groups.filter((g) => g.total > 0).map((g) => `<span><i style="background:${GROUP_COLORS[g.id]}"></i>${esc(g.label)} ${m(g.total)}</span>`).join('')}</div>

        <table class="cost-table">
          <thead><tr><th></th><th>Item</th><th class="num">Quantity</th><th>Unit</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead>
          ${byGroup
            .map(
              ({ g, lines }) => `<tbody>
                <tr class="group"><td colspan="5">${esc(COST_GROUPS[g])}</td><td class="num">${m(lines.reduce((a, l) => a + l.total, 0))}</td></tr>
                ${lines
                  .map(
                    (l) => `<tr class="${l.included ? '' : 'off'}">
                      <td><input type="checkbox" data-include="${esc(l.id)}" ${l.included ? 'checked' : ''} title="${l.included ? 'Leave out of the estimate' : 'Include in the estimate'}"></td>
                      <td>${esc(l.label)}</td>
                      <td class="num">${l.percent ? '' : l.qty.toLocaleString()}</td>
                      <td>${l.percent ? '' : esc(l.unit)}</td>
                      <td class="num">${l.percent ? `${l.qty} %` : `<input type="number" min="0" step="any" data-price="${esc(l.key)}" value="${toShown(l.price)}" class="${l.key in (s.prices || {}) ? 'custom' : ''}">`}</td>
                      <td class="num">${m(l.total)}</td>
                    </tr>`,
                  )
                  .join('')}
              </tbody>`,
            )
            .join('')}
          <tfoot><tr><td></td><td colspan="4"><b>Total</b></td><td class="num"><b>${m(e.total)}</b></td></tr></tfoot>
        </table>

        <p class="cost-note">Quantities come from your plan (walls, slabs, roof, openings, finishes, utility points, fittings, site).
          The unit prices are <b>example values</b> (rough central-European level incl. VAT) so you can start; replace them with quotes from
          your builder, and the estimate updates. Prices you changed are highlighted.
          <button class="link" id="reset-prices">Reset prices to the examples</button></p>
        <p class="cost-note"><button class="ghost small" id="costs-csv">Download as spreadsheet (.csv)</button>
          <button class="ghost small" id="costs-print">Print or save as PDF…</button></p>
      </div>`;

    const furnitureIds = e.lines.filter((l) => l.group === 'furniture').map((l) => l.id);
    container.querySelectorAll('[data-set]').forEach((el) =>
      el.addEventListener('change', () => {
        const key = el.dataset.set;
        // the furniture switch turns every furniture line on or off
        if (key === 'includeFurniture' && el.checked) settings().exclude = (settings().exclude || []).filter((id) => !furnitureIds.includes(id));
        if (el.type === 'checkbox') return setSetting(key, el.checked);
        if (el.type === 'number') return setSetting(key, Math.max(0, Number(el.value) || 0));
        setSetting(key, el.value);
      }),
    );
    container.querySelectorAll('[data-price]').forEach((el) =>
      el.addEventListener('change', () => {
        const key = el.dataset.price;
        const prices = (settings().prices ||= {});
        // typed in the display currency, stored in EUR
        const v = Math.round((Math.max(0, Number(el.value) || 0) / rate) * 100) / 100;
        const def = key.startsWith('item:') ? ITEM_PRICES[key.slice(5)] : DEFAULT_PRICES[key]?.[2];
        if (Math.abs(v - def) < 0.01) delete prices[key];
        else prices[key] = v;
        store.changed();
      }),
    );
    const budgetEl = container.querySelector('[data-budget]');
    budgetEl.addEventListener('change', () => setSetting('budget', Math.round(Math.max(0, Number(budgetEl.value) || 0) / rate)));
    container.querySelector('[data-currency]').addEventListener('change', (ev) => {
      const cur = ev.target.value;
      setSetting('currency', cur);
      const s2 = costSettings(store.house);
      if (cur !== BASE_CURRENCY && !s2.rates?.values?.[cur] && !s2.rateOverride?.[cur]) updateRates(false);
    });
    const rateEl = container.querySelector('[data-rate]');
    if (rateEl)
      rateEl.addEventListener('change', () => {
        const v = Number(rateEl.value);
        const over = { ...(settings().rateOverride || {}) };
        if (v > 0 && v !== fx.downloaded) over[fx.currency] = v;
        else delete over[fx.currency];
        settings().rateOverride = over;
        if (!Object.keys(over).length) delete settings().rateOverride;
        store.changed();
      });
    container.querySelector('#fx-update')?.addEventListener('click', () => updateRates(true));
    container.querySelector('#fx-reset')?.addEventListener('click', () => {
      const over = { ...(settings().rateOverride || {}) };
      delete over[fx.currency];
      settings().rateOverride = over;
      if (!Object.keys(over).length) delete settings().rateOverride;
      store.changed();
    });
    container.querySelectorAll('[data-include]').forEach((el) =>
      el.addEventListener('change', () => {
        const ex = new Set(settings().exclude || []);
        // ticking one piece of furniture while furniture is off includes just that piece
        if (el.checked && furnitureIds.includes(el.dataset.include) && !s.includeFurniture) {
          settings().includeFurniture = true;
          for (const id of furnitureIds) ex.add(id);
        }
        if (el.checked) ex.delete(el.dataset.include);
        else ex.add(el.dataset.include);
        settings().exclude = [...ex];
        store.changed();
      }),
    );
    container.querySelector('#costs-csv').onclick = () => download(`${fileSlug(store.house.name)}-costs.csv`, estimateCsv(store.house), 'text/csv');
    container.querySelector('#costs-print').onclick = () => onPrint?.('costs');
    container.querySelector('#reset-prices').onclick = () => {
      if (!confirm('Reset all unit prices to the example values? (You can undo this.)')) return;
      delete settings().prices;
      store.changed();
    };
  }

  store.on((reason) => {
    if (['house', 'saved'].includes(reason)) render();
  });
  return { render };
}
