// Printable plan sheets at true scale (A3/A4) plus the handover brief. "Print / Save as PDF"
// uses the browser's print dialog.
import { createPlan } from './plan2d.js';
import { resolveTarget } from './model.js';
import { bbox } from './geometry.js';
import { sortedFloors } from './stairs.js';
import { buildBrief, briefHtml, briefMarkdown } from './brief.js';
import { houseToDxf } from './dxf.js';
import { download, fileSlug } from './download.js';
import { create3D } from './view3d.js';
import { estimateCsv, estimateHtml } from './costExport.js';
import { request, DEMO } from './backend.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slug = new URLSearchParams(location.search).get('house');
const api = (path) => request('GET', `api/houses/${encodeURIComponent(slug)}/${path}`);
// the online demo can't save, so it hands over the plan as it is in the window that opened us
const openerHouse = () => {
  try {
    return DEMO ? window.opener?.openhomeplanHouse || null : null;
  } catch {
    return null;
  }
};

const PAPER = { A3: { w: 420, h: 297, margin: 10 }, A4: { w: 297, h: 210, margin: 8 } };
const SCALES = [50, 100, 200, 500];
const TITLE_BLOCK = 34; // mm reserved at the bottom for the title block and legend

const SHEETS = {
  site: { label: 'Site plan', layers: {} },
  views: { label: '3D views' },
  plan: { label: 'Floor plans', layers: {} },
  furniture: { label: 'Furniture & finishes', layers: { furniture: true, finishes: true } },
  electrical: { label: 'Electrical', layers: { electrical: true, circuits: true } },
  water: { label: 'Water, drainage & gas', layers: { water: true } },
  brief: { label: 'Handover brief' },
  costs: { label: 'Cost estimate' },
};

const LEGENDS = {
  plan: [['#23262b', 5, 'Load-bearing / exterior wall'], ['#8a8a8a', 3, 'Partition'], ['#555', 1, 'Railing'], ['#4a90d9', 2, 'Glass'], ['#a0591c', 3, 'Beam over an opening']],
  electrical: [['S', 'Socket'], ['K', 'Counter socket'], ['3~', '400 V'], ['A', 'Appliance outlet'], ['⊗', 'Ceiling light'], ['W', 'Wall light'], ['/', 'Switch'], ['RB', 'Distribution board'], ['D', 'Data']],
  water: [['C', 'Cold water'], ['H', 'Hot water'], ['▼', 'Drain'], ['WM', 'Water meter'], ['G', 'Gas'], ['GM', 'Gas meter']],
};

let house;
let comments = [];
let briefText = '';

function sheetBox(floor, kind, ground) {
  if (kind === 'site') {
    const plot = house.site.find((s) => s.type === 'plot');
    const b = bbox([...(plot ? [plot] : house.site), ...floor.rooms]);
    return { x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 };
  }
  const b = bbox(floor.rooms);
  // room for the dimension lines (north and east) and labels
  return { x: b.x - 1.5, y: b.y - 3, w: b.w + 5, h: b.h + 4.5 };
}

function pickScale(box, area, wanted) {
  if (wanted !== 'auto') return Number(wanted);
  return SCALES.find((s) => (box.w * 1000) / s <= area.w && (box.h * 1000) / s <= area.h) || SCALES[SCALES.length - 1];
}

function legendHtml(kind) {
  if (kind === 'electrical' || kind === 'water')
    return LEGENDS[kind].map(([sym, label]) => `<span><b>${esc(sym)}</b>${esc(label)}</span>`).join('');
  if (kind === 'furniture') return '<span>Furniture and appliances at real size; floor finishes and tile zones (numbers = laying order).</span>';
  return LEGENDS.plan.map(([c, h, label]) => `<span><i style="background:${c};height:${h * 0.25}mm"></i>${esc(label)}</span>`).join('');
}

function scaleBar(scale) {
  const len = [1, 2, 5, 10, 20].find((m) => (m * 1000) / scale >= 30) || 20;
  const mm = (len * 1000) / scale;
  return `<svg width="${mm + 10}mm" height="8mm" viewBox="0 0 ${mm + 10} 8"><rect x="0" y="1" width="${mm}" height="1.6" fill="#fff" stroke="#23262b" stroke-width="0.25"/><rect x="0" y="1" width="${mm / 2}" height="1.6" fill="#23262b"/>
    <text x="0" y="6" font-size="2.6">0</text><text x="${mm}" y="6" font-size="2.6" text-anchor="middle">${len} m</text></svg>`;
}

function renderSheet(pages, floor, kind, paperKey, wantedScale, index, total, ground) {
  const paper = PAPER[paperKey];
  const area = { w: paper.w - 2 * paper.margin, h: paper.h - 2 * paper.margin - TITLE_BLOCK };
  const box = sheetBox(floor, kind, ground);
  const scale = pickScale(box, area, wantedScale);
  const vbW = ((paper.w - 2 * paper.margin) * scale) / 1000;
  const vbH = ((paper.h - 2 * paper.margin) * scale) / 1000;
  const viewBox = { x: box.x + box.w / 2 - vbW / 2, y: box.y + box.h / 2 - (area.h * scale) / 1000 / 2, w: vbW, h: vbH };
  const page = document.createElement('section');
  page.className = `sheet ${paperKey}`;
  const title = kind === 'site' ? 'Site plan' : `${floor.name} – ${SHEETS[kind].label.toLowerCase()}`;
  page.innerHTML = `
    <div class="drawing" style="width:${paper.w - 2 * paper.margin}mm;height:${paper.h - 2 * paper.margin}mm;left:${paper.margin}mm;top:${paper.margin}mm"></div>
    <div class="frame"></div>
    <svg class="north" viewBox="-10 -14 20 26"><circle r="8" fill="#fff" stroke="#23262b" stroke-width="0.5"/><path d="M0,-7 L3,4 L0,2 L-3,4 Z" fill="#23262b"/><text y="-9.5" text-anchor="middle" font-size="4" font-weight="700">N</text></svg>
    <div class="legend">${legendHtml(kind)}</div>
    <div class="scalebar">${scaleBar(scale)}</div>
    <div class="titleblock">
      <div class="wide big">${esc(house.name || 'House')}</div>
      <div class="wide"><small>Sheet</small>${esc(title)}</div>
      <div><small>Scale</small>1:${scale} (${paperKey})</div>
      <div><small>Date</small>${new Date().toISOString().slice(0, 10)}</div>
      <div><small>Sheet</small>${index} / ${total}</div>
      <div><small>Units</small>metres, wall axes</div>
      <div class="wide note">Concept study made with OpenHomePlan. Not a construction or permit document; to be designed and verified by authorised professionals.</div>
    </div>`;
  pages.appendChild(page);
  const store = {
    house,
    comments: [],
    selected: 'house',
    layers: { furniture: false, electrical: false, water: false, finishes: false, circuits: false, ...SHEETS[kind].layers },
    floor: () => floor,
    resolve: (t) => resolveTarget(house, t),
    openComments: () => 0,
    assetUrl: (file) => `/houses/${encodeURIComponent(slug)}/${file}`,
  };
  const drawing = page.querySelector('.drawing');
  const { svg } = createPlan(drawing, store, { static: true, viewBox, px: (0.3 * scale) / 1000, layers: store.layers });
  svg.style.width = '100%';
  svg.style.height = '100%';
}

// The 3D views are rendered by an off-screen 3D view of the same house.
// The two outside views look from the street side and from the garden side of the plot.
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
// azimuth 0 looks from the south, 90 from the east, 180 from the north, 270 from the west
const fromSide = (az) => COMPASS[Math.round(((((180 - az) % 360) + 360) % 360) / 45) % 8];
function viewList() {
  const street = house.site.find((s) => s.type === 'plot')?.street || 'N';
  const streetAz = { N: 215, E: 125, S: 35, W: 305 }[street];
  const gardenAz = (streetAz + 180) % 360;
  return [
    { title: `From the garden (${fromSide(gardenAz)})`, mode: 'whole', azimuth: gardenAz, elevation: 25, site: true },
    { title: `From the street (${fromSide(streetAz)})`, mode: 'whole', azimuth: streetAz, elevation: 25, site: true },
    { title: 'Ground floor cut-away', mode: 'ground-floor', azimuth: (gardenAz + 345) % 360, elevation: 55 },
    { title: 'Upper floor cut-away', mode: 'upper-floor', azimuth: (streetAz + 345) % 360, elevation: 55 },
  ];
}
let viewer = null;
let viewImages = null;
async function render3dViews() {
  if (viewImages) return viewImages;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:1600px;height:1000px';
  document.body.appendChild(box);
  const store3d = {
    house, comments: [], selected: 'house', layers: {},
    on() {}, select() {}, beginBatch() {}, endBatch() {}, changed() {},
    openComments: () => 0,
    resolve: (t) => resolveTarget(house, t),
    assetUrl: (file) => `/houses/${encodeURIComponent(slug)}/${file}`,
  };
  viewer ||= create3D(box, store3d);
  const floors = sortedFloors(house);
  const images = [];
  for (const v of viewList()) {
    // the cut-away views use the lowest and the top floor of this house
    const mode = v.mode === 'ground-floor' ? floors[0]?.id : v.mode === 'upper-floor' ? floors[floors.length - 1]?.id : v.mode;
    if (v.mode === 'upper-floor' && floors.length < 2) continue;
    images.push({ title: v.mode === 'ground-floor' ? `${floors[0].name} cut-away` : v.mode === 'upper-floor' ? `${floors[floors.length - 1].name} cut-away` : v.title, url: await viewer.snapshot({ ...v, mode }) });
  }
  viewImages = images;
  return images;
}

function renderViewsSheet(pages, images, paperKey, index, total) {
  const paper = PAPER[paperKey];
  const page = document.createElement('section');
  page.className = `sheet ${paperKey}`;
  page.innerHTML = `
    <div class="views" style="left:${paper.margin}mm;top:${paper.margin}mm;width:${paper.w - 2 * paper.margin}mm;height:${paper.h - 2 * paper.margin - TITLE_BLOCK}mm">
      ${images.map((im) => `<figure><img src="${im.url}" alt=""><figcaption>${esc(im.title)}</figcaption></figure>`).join('')}
    </div>
    <div class="frame"></div>
    <div class="titleblock">
      <div class="wide big">${esc(house.name || 'House')}</div>
      <div class="wide"><small>Sheet</small>3D views (illustrative, not to scale)</div>
      <div><small>Paper</small>${paperKey}</div>
      <div><small>Date</small>${new Date().toISOString().slice(0, 10)}</div>
      <div><small>Sheet</small>${index} / ${total}</div>
      <div><small>Model</small>house.json</div>
      <div class="wide note">Concept study made with OpenHomePlan. Not a construction or permit document; to be designed and verified by authorised professionals.</div>
    </div>`;
  pages.appendChild(page);
}

function chosenSheets() {
  return [...document.querySelectorAll('#sheet-types input:checked')].map((i) => i.value);
}

let rendering = 0;
async function render() {
  const run = ++rendering;
  const pages = $('#pages');
  const kinds = chosenSheets();
  const floors = sortedFloors(house);
  const ground = floors.find((f) => (f.elevation ?? 0) >= -0.5) || floors[0];
  let images = [];
  if (kinds.includes('views')) {
    $('#print').disabled = true;
    $('#print').textContent = 'Rendering 3D views…';
    images = await render3dViews();
    $('#print').disabled = false;
    $('#print').textContent = 'Print / Save as PDF';
    if (run !== rendering) return; // a newer render started meanwhile
  }
  pages.innerHTML = '';
  const list = [];
  if (kinds.includes('site')) list.push([ground, 'site']);
  if (kinds.includes('views') && images.length) list.push([null, 'views']);
  for (const kind of ['plan', 'furniture', 'electrical', 'water']) if (kinds.includes(kind)) for (const f of floors) list.push([f, kind]);
  list.forEach(([floor, kind], i) =>
    kind === 'views' ? renderViewsSheet(pages, images, $('#paper').value, i + 1, list.length) : renderSheet(pages, floor, kind, $('#paper').value, $('#scale').value, i + 1, list.length, ground),
  );
  if (kinds.includes('brief')) {
    const div = document.createElement('section');
    div.className = 'brief';
    div.innerHTML = briefHtml(buildBrief(house, { comments, briefText }));
    pages.appendChild(div);
  }
  if (kinds.includes('costs')) {
    const div = document.createElement('section');
    div.className = 'brief costs-sheet';
    div.innerHTML = estimateHtml(house);
    pages.appendChild(div);
  }
}

async function boot() {
  if (!slug) throw new Error('No house given (?house=…)');
  [house, comments, { text: briefText }] = await Promise.all([openerHouse() || api('house'), api('comments'), api('brief')]);
  document.title = `${house.name || 'House'} – plans`;
  $('#title').textContent = `${house.name || 'House'} – plans`;
  const has = {
    furniture: house.floors.some((f) => (f.items || []).length || f.rooms.some((r) => r.finish || r.zones)),
    electrical: house.floors.some((f) => (f.points || []).some((p) => !/water|drain|gas/.test(p.kind))),
    water: house.floors.some((f) => (f.points || []).some((p) => /water|drain|gas/.test(p.kind))),
  };
  // ?only=costs opens the printout with just that sheet ticked
  const only = new URLSearchParams(location.search).get('only');
  $('#sheet-types').innerHTML = Object.entries(SHEETS)
    .map(([k, v]) => `<label><input type="checkbox" value="${k}" ${(only ? only === k : has[k] !== false) ? 'checked' : ''}> ${esc(v.label)}</label>`)
    .join('');
  // the paper choice: remembered, and it sets the printed page size
  try {
    const saved = localStorage.getItem('openhomeplan:paper');
    if (saved && PAPER[saved]) $('#paper').value = saved;
  } catch {}
  const pageSize = document.head.appendChild(document.createElement('style'));
  const applyPaper = () => {
    const p = $('#paper').value;
    pageSize.textContent = `@page { size: ${p} landscape; margin: 0; }`;
    $('#print-hint').textContent = `In the print dialog choose paper ${p}, landscape, and print at 100 % (“Actual size”, no “fit to page”) so the scale is exact. Choose “Save as PDF” as the printer to get a PDF.`;
    try {
      localStorage.setItem('openhomeplan:paper', p);
    } catch {}
  };
  $('#paper').addEventListener('change', applyPaper);
  applyPaper();
  for (const el of ['#paper', '#scale', '#sheet-types']) $(el).addEventListener('change', render);
  $('#print').onclick = () => window.print();
  $('#dl-md').onclick = () => download(`${fileSlug(house.name)}-brief.md`, briefMarkdown(buildBrief(house, { comments, briefText })), 'text/markdown');
  $('#dl-csv').onclick = () => download(`${fileSlug(house.name)}-costs.csv`, estimateCsv(house), 'text/csv');
  $('#dl-dxf').onclick = () => download(`${fileSlug(house.name)}.dxf`, houseToDxf(house), 'application/dxf');
  render();
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#c2410c">Could not load the plans: ${esc(err.message)}</pre>`;
});
