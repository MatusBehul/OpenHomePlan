import { ROOM_TYPES, SITE_TYPES } from './catalog.js';
import {
  area, bbox, fmt, fmtArea, round, totals, DOOR_TYPES, exteriorEdges, neighbours,
  placeDoor, placeOpening, livingRange,
} from './geometry.js';
import { createPlan } from './plan2d.js';
import { resolveTarget, roomName, doorName, openingName, FACADES, OPENING_TYPES, OPENING_DEFAULTS, isHinged, fixDuplicateIds } from './model.js';
import { analyzeStairs, fixStairs, allStairIssues, sortedFloors } from './stairs.js';
import { WALL_TYPES, MATERIALS, floorWalls, setWallProps, resetWall, pruneWalls, sameLine } from './walls.js';
import { structureIssues, structureRules } from './structure.js';
import { ROOF_TYPES, roofInfo, siteRoof, roofText, SITE_ROOFED, SITE_ROOF_DEFAULT, ROOF_DEFAULTS, roofZones, toRoofZones, syncRoofZones, ROOF_COVERINGS, covering } from './roof.js';
import { collectIssues } from './issues.js';
import { ITEMS, ITEM_CATEGORIES, itemInfo, newItem, rotateItem, footprint, roomAt } from './items.js';
import { POINT_KINDS, GROUPS, generateUtilities, generateCircuits, loadSummary, pointGroup } from './utilities.js';
import { houseToDxf } from './dxf.js';
import { buildBrief, briefMarkdown } from './brief.js';
import { download, fileSlug } from './download.js';
import { createCostsView } from './costsView.js';
import { estimateCsv } from './costExport.js';
import { FACADE_DEFAULTS, facadeSettings } from './facade.js';
import { isShaped, SHAPED, toShape, toRect, measure, syncBox } from './shapes.js';
import { estimate, moneyFor } from './costs.js';
import { request, DEMO, DEMO_NOTICE, INSTALL_URL, houseFiles } from './backend.js';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- api ----------

const api = request;

// ---------- houses ----------

// Every house lives in its own folder on the server; the open one is in the URL (?house=…).
// Paths are relative so the same files also work as the online demo under /demo/.
const houseApi = (path) => `api/houses/${encodeURIComponent(store.slug)}/${path}`;
export const assetUrl = (file) => `${houseFiles(store.slug)}${file}`;

function rememberHouse(slug) {
  try {
    localStorage.setItem('openhomeplan:last-house', slug);
  } catch {}
}

function openHouse(slug) {
  if (store.dirty && !confirm('You have unsaved changes. Leave this house without saving?')) return false;
  store.saved = JSON.stringify(store.house); // don't trigger the unload warning again
  rememberHouse(slug);
  location.search = `?house=${encodeURIComponent(slug)}`;
  return true;
}

async function renderHousePicker() {
  const houses = await api('GET', 'api/houses');
  const picker = $('#house-picker');
  picker.innerHTML =
    houses.map((h) => `<option value="${esc(h.slug)}" ${h.slug === store.slug ? 'selected' : ''} title="${esc(h.description || '')}">${esc(h.name)}</option>`).join('') +
    (DEMO ? '' : '<option value="__new">＋ New house…</option>');
  picker.onchange = () => {
    if (picker.value === '__new') {
      picker.value = store.slug;
      newHouseDialog();
    } else if (!openHouse(picker.value)) picker.value = store.slug;
  };
  return houses;
}

async function newHouseDialog() {
  const { templates, housesDir } = await api('GET', 'api/config');
  const dlg = $('#new-house');
  const source = $('#new-house-source', dlg);
  source.innerHTML =
    templates.map((t) => `<option value="template:${esc(t.id)}">Template: ${esc(t.name)}${t.description ? ` — ${esc(t.description)}` : ''}</option>`).join('') +
    (store.slug ? `<option value="duplicate:${esc(store.slug)}">Copy of the current house (${esc(store.house?.name || store.slug)}, last saved version)</option>` : '');
  $('#new-house-dir', dlg).textContent = housesDir;
  $('#new-house-name', dlg).value = '';
  dlg.showModal();
  $('#new-house-create', dlg).onclick = async (e) => {
    e.preventDefault();
    const name = $('#new-house-name', dlg).value.trim();
    if (!name) return toast('Give the house a name', true);
    const [kind, id] = source.value.split(':');
    try {
      const { slug } = await api('POST', 'api/houses', kind === 'duplicate' ? { name, duplicate: id } : { name, template: id });
      dlg.close();
      openHouse(slug);
    } catch (err) {
      toast(`Could not create the house: ${err.message}`, true);
    }
  };
  $('#new-house-cancel', dlg).onclick = () => dlg.close();
}

// ---------- store ----------

const listeners = new Set();
const LAYER_DEFAULTS = { furniture: true, electrical: false, water: false, finishes: false, circuits: false, roofs: false };
function loadLayers() {
  try {
    return { ...LAYER_DEFAULTS, ...JSON.parse(localStorage.getItem('openhomeplan:layers') || localStorage.getItem('house-planner:layers') || '{}') };
  } catch {
    return { ...LAYER_DEFAULTS };
  }
}

export const store = {
  layers: loadLayers(),
  assetUrl: (file) => assetUrl(file),
  slug: null,
  house: null,
  saved: '',
  selected: 'house',
  floorId: 'ground',
  comments: [],
  view: 'plan',
  on(fn) {
    listeners.add(fn);
  },
  emit(reason) {
    for (const fn of listeners) fn(reason);
  },
  get dirty() {
    return JSON.stringify(this.house) !== this.saved;
  },
  // Undo history holds JSON snapshots. `last` is the state after the previous change;
  // a batch (a drag gesture) records a single undo step however many changes it makes.
  history: { undo: [], redo: [] },
  last: '',
  batch: null,
  changed() {
    // roofs follow the building (roof areas placed by hand stay put)
    syncRoofZones(this.house);
    const now = JSON.stringify(this.house);
    if (now !== this.last) {
      if (!this.batch?.pushed) {
        this.history.undo.push(this.last);
        if (this.history.undo.length > 300) this.history.undo.shift();
        this.history.redo = [];
      }
      if (this.batch) this.batch.pushed = true;
      else this.last = now;
    }
    this.emit('house');
  },
  beginBatch() {
    this.batch = { pushed: false };
  },
  endBatch() {
    if (!this.batch) return;
    this.batch = null;
    this.last = JSON.stringify(this.house);
  },
  restore(json) {
    this.house = JSON.parse(json);
    this.last = json;
    if (!this.house.floors.some((f) => f.id === this.floorId)) this.floorId = this.house.floors[0]?.id;
    if (!this.resolve(this.selected)) this.selected = 'house';
    this.emit('house');
    this.emit('floor');
    this.emit('selection');
  },
  undo() {
    if (this.batch || !this.history.undo.length) return false;
    this.history.redo.push(JSON.stringify(this.house));
    this.restore(this.history.undo.pop());
    return true;
  },
  redo() {
    if (this.batch || !this.history.redo.length) return false;
    this.history.undo.push(JSON.stringify(this.house));
    this.restore(this.history.redo.pop());
    return true;
  },
  select(target) {
    const t = this.resolve(target);
    if (t?.floor && t.floor.id !== this.floorId) {
      this.floorId = t.floor.id;
      this.emit('floor');
    }
    this.selected = t ? target : 'house';
    this.emit('selection');
  },
  floor(id = this.floorId) {
    return this.house.floors.find((f) => f.id === id) || this.house.floors[0];
  },
  resolve(target) {
    return resolveTarget(this.house, target);
  },
  openComments(target) {
    return this.comments.filter((c) => c.status === 'open' && c.target === target).length;
  },
};

// ---------- toast ----------

let toastTimer;
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 5000 : 2500);
}

// ---------- save / discard ----------

function describeChanges(before, after) {
  const changes = [];
  const diffList = (oldList, newList, nameOf = (r) => r.name) => {
    const oldMap = new Map(oldList.map((r) => [r.id, r]));
    const newMap = new Map(newList.map((r) => [r.id, r]));
    for (const [id, r] of newMap) {
      const o = oldMap.get(id);
      if (!o) changes.push(`add ${nameOf(r)}`);
      else if (!('w' in r)) {
        if (JSON.stringify(o) !== JSON.stringify(r)) changes.push(`edit ${nameOf(r)}`);
      }
      else if (o.x !== r.x || o.y !== r.y || o.w !== r.w || o.h !== r.h) {
        changes.push(`${o.w !== r.w || o.h !== r.h ? 'resize' : 'move'} ${nameOf(r)}`);
      } else if (JSON.stringify(o) !== JSON.stringify(r)) changes.push(`edit ${nameOf(r)}`);
    }
    for (const [id, o] of oldMap) if (!newMap.has(id)) changes.push(`remove ${nameOf(o)}`);
  };
  for (const f of after.floors) {
    const old = before.floors.find((x) => x.id === f.id) || {};
    diffList(old.rooms || [], f.rooms);
    diffList(old.doors || [], f.doors || [], (d) => doorName(f, d).toLowerCase());
    diffList(old.openings || [], f.openings || [], (o) => openingName(f, o).toLowerCase());
    if (JSON.stringify(old.walls || []) !== JSON.stringify(f.walls || [])) changes.push(`edit walls on ${f.name.toLowerCase()}`);
    diffList(old.items || [], f.items || [], (i) => (i.name || itemInfo(i).label).toLowerCase());
    const pts = (x) => JSON.stringify(x.points || []);
    if (pts(old) !== pts(f)) changes.push(`update utilities on ${f.name.toLowerCase()}`);
  }
  if (before.name !== after.name) changes.push(`rename house to "${after.name}"`);
  if ((before.description || '') !== (after.description || '')) changes.push('edit description');
  if (JSON.stringify(before.roofs || []) !== JSON.stringify(after.roofs || [])) changes.push('change roofs');
  if (JSON.stringify(before.facade || {}) !== JSON.stringify(after.facade || {})) changes.push('change facade');
  if (JSON.stringify(before.roof) !== JSON.stringify(after.roof)) changes.push(`change roof to ${ROOF_TYPES[after.roof?.type]?.toLowerCase() || after.roof?.type}`);
  diffList(before.site, after.site);
  if (!changes.length) return 'Update house plan';
  const shown = changes.slice(0, 4).join(', ');
  return `Plan: ${shown}${changes.length > 4 ? ` and ${changes.length - 4} more` : ''}`;
}

async function save() {
  if (DEMO) return toast(DEMO_NOTICE, true);
  if (!store.dirty) return;
  const btn = $('#save');
  btn.disabled = true;
  try {
    const message = describeChanges(JSON.parse(store.saved), store.house);
    const { commit } = await api('PUT', houseApi('house'), { house: store.house, message });
    store.saved = JSON.stringify(store.house);
    toast(commit ? `Saved and committed ${commit}` : 'Saved (no changes to commit)');
    renderHousePicker();
    store.emit('saved');
    loadHistory();
  } catch (err) {
    toast(`Save failed: ${err.message}`, true);
  } finally {
    updateTopbar();
  }
}

function discard() {
  if (!store.dirty || !confirm('Discard unsaved changes? (You can still undo this.)')) return;
  store.house = JSON.parse(store.saved);
  if (!store.resolve(store.selected)) store.selected = 'house';
  store.changed();
  store.emit('floor');
  store.emit('selection');
}

// ---------- top bar ----------

function renderFloorTabs() {
  const floors = sortedFloors(store.house);
  $('#plan-floors').innerHTML = floors
    .map((f) => `<button data-floor="${esc(f.id)}" class="${f.id === store.floorId ? 'active' : ''}">${esc(f.name)}</button>`)
    .join('');
  if (mode3d !== 'whole' && !floors.some((f) => f.id === mode3d)) mode3d = 'whole';
  $('#view3d-modes').innerHTML =
    `<button data-mode="whole" class="${mode3d === 'whole' ? 'active' : ''}">Whole house</button>` +
    floors.map((f) => `<button data-mode="${esc(f.id)}" class="${mode3d === f.id ? 'active' : ''}">${esc(f.name)} cut-away</button>`).join('');
}

function updateTopbar() {
  const t = totals(store.house);
  const issues = collectIssues(store.house).length;
  $('#totals').innerHTML =
    t.floors.map((f) => `<span>${esc(f.name)} <b>${fmtArea(f.net)}</b> m²</span>`).join('') +
    `<span class="${t.inRange ? 'ok' : 'bad'}" title="Target ${livingRange(store.house).join('–')} m²">Living area <b>${fmtArea(t.net)} m²</b></span>` +
    (issues ? `<button class="warn-btn" id="issues-btn" title="Show what needs attention">⚠ ${issues} issue${issues > 1 ? 's' : ''}</button>` : '');
  if ($('#issues-pop') && !$('#issues-pop').hidden) renderIssues();
  const cost = estimate(store.house);
  if (cost.budget)
    $('#totals').insertAdjacentHTML(
      'beforeend',
      `<span class="${cost.remaining < 0 ? 'bad' : 'ok'}" title="Estimated cost against your budget (see the Costs tab)">Cost <b>${moneyFor(store.house)(cost.total)}</b> / ${moneyFor(store.house)(cost.budget)}</span>`,
    );
  $('#undo').disabled = !store.history.undo.length;
  $('#redo').disabled = !store.history.redo.length;
  $('#save').disabled = DEMO || !store.dirty;
  $('#discard').disabled = !store.dirty;
  document.title = `${store.dirty ? '● ' : ''}${store.house.name || 'House'} · OpenHomePlan`;
}

// ---------- issues popover ----------

function renderIssues() {
  const list = collectIssues(store.house);
  const pop = $('#issues-pop');
  pop.innerHTML = `<div class="pop-head"><b>${list.length ? `${list.length} thing${list.length > 1 ? 's' : ''} to look at` : 'No issues'}</b><button class="link" id="issues-close">close</button></div>
    <ul>${list
      .map((i) => `<li><span class="kind">${esc(i.kind)}</span><span>${esc(i.text)}</span><button class="small" data-show="${esc(i.target)}">Show</button></li>`)
      .join('') || '<li class="empty">Everything checks out.</li>'}</ul>`;
  $('#issues-close', pop).onclick = () => (pop.hidden = true);
  pop.querySelectorAll('[data-show]').forEach((b) =>
    (b.onclick = () => {
      if (store.view !== 'plan') showView('plan');
      store.select(b.dataset.show);
    }),
  );
}

// ---------- selection panel ----------

function uniqueId(base, taken) {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

const floorIds = (floor) => new Set([...floor.rooms, ...(floor.doors || []), ...(floor.openings || []), ...(floor.items || []), ...(floor.points || [])].map((x) => x.id));

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

function addFloor(where) {
  const floors = sortedFloors(store.house);
  const ref = where === 'above' ? floors[floors.length - 1] : floors[0];
  const b = bbox(ref.rooms);
  const height = 2.8;
  const elevation = round(where === 'above' ? (ref.elevation ?? 0) + (ref.height ?? height) : (ref.elevation ?? 0) - height);
  const ids = new Set(store.house.floors.map((f) => f.id));
  const base = where === 'above' ? `floor-${floors.length + 1}` : 'basement';
  const floor = {
    id: uniqueId(base, ids),
    name: where === 'above' ? `Floor ${floors.length + 1}` : 'Basement',
    elevation,
    height,
    rooms: [{ id: 'room', name: 'New room', type: 'other', x: b.x, y: b.y, w: b.w || 6, h: b.h || 6 }],
    openings: [],
    doors: [],
  };
  store.house.floors.push(floor);
  store.house.floors.sort((p, q) => (p.elevation ?? 0) - (q.elevation ?? 0));
  store.floorId = floor.id;
  store.changed();
  store.emit('floor');
  store.select('house');
  toast(`Added ${floor.name.toLowerCase()} with one room covering the footprint — split it into rooms.`);
}

function deleteFloor(floor) {
  if (store.house.floors.length < 2) return toast('A house needs at least one floor', true);
  if (!confirm(`Delete ${floor.name} with all its rooms? (You can undo this.)`)) return;
  store.house.floors.splice(store.house.floors.indexOf(floor), 1);
  if (store.floorId === floor.id) store.floorId = store.house.floors[0].id;
  store.changed();
  store.emit('floor');
  store.select('house');
}

// Changing a floor's height moves every floor above it by the same amount.
function setFloorValue(floor, key, value) {
  if (key === 'height') {
    const delta = round(value - (floor.height ?? 2.8));
    for (const f of store.house.floors) if ((f.elevation ?? 0) > (floor.elevation ?? 0)) f.elevation = round((f.elevation ?? 0) + delta);
  }
  floor[key] = value;
  if (key === 'elevation') store.house.floors.sort((p, q) => (p.elevation ?? 0) - (q.elevation ?? 0));
  store.changed();
  store.emit('floor');
}

function floorsHtml() {
  const floors = sortedFloors(store.house);
  return `<div class="subhead">Floors</div>
    <div class="floor-table">
      <span>Name</span><span>Level (m)</span><span>Floor-to-floor (m)</span><span title="Attic: the floor lies under the roof; its windows become dormers (or gable windows). The number is the knee wall: the height of the outer wall below the eaves.">Attic · knee (m)</span><span></span>
      ${floors
        .map(
          (f) => `<input data-floor-id="${esc(f.id)}" data-fkey="name" value="${esc(f.name)}">
            <input type="number" step="0.05" data-floor-id="${esc(f.id)}" data-fkey="elevation" value="${fmt(f.elevation ?? 0)}">
            <input type="number" step="0.05" data-floor-id="${esc(f.id)}" data-fkey="height" value="${fmt(f.height ?? 2.8)}">
            <span class="attic-cell"><input type="checkbox" data-floor-id="${esc(f.id)}" data-fkey="underRoof" ${f.underRoof ? 'checked' : ''} title="Under the roof (attic)">${f.underRoof ? `<input type="number" step="0.05" min="0" max="2" data-floor-id="${esc(f.id)}" data-fkey="kneeWall" value="${fmt(f.kneeWall ?? 0)}" title="Knee wall: the outer wall between the attic floor and the eaves (m)">` : ''}</span>
            <button class="small danger" data-delete-floor="${esc(f.id)}" title="Delete floor" ${floors.length < 2 ? 'disabled' : ''}>✕</button>`,
        )
        .join('')}
    </div>
    <div class="row" style="margin-top:6px">
      <button class="small" id="add-floor-above">+ Floor above</button>
      <button class="small" id="add-floor-below">+ Basement</button>
    </div>`;
}

function addRoom() {
  const floor = store.floor();
  const b = bbox(floor.rooms);
  const id = uniqueId('room', floorIds(floor));
  // New rooms go just outside the east facade, so they never overlap; drag them into place.
  floor.rooms.push({ id, name: 'New room', type: 'other', x: round(b.x + b.w), y: round(b.y), w: 3, h: 3 });
  store.changed();
  store.select(`${floor.id}/${id}`);
}

function splitRoom(floor, room) {
  const vertical = room.w >= room.h; // split across the longer side
  const half = round((vertical ? room.w : room.h) / 2, 0.05);
  const id = uniqueId(`${room.id}-b`, floorIds(floor));
  const copy = { ...room, id, name: `${room.name} (2)` };
  if (vertical) {
    copy.x = round(room.x + half);
    copy.w = round(room.w - half);
    room.w = half;
  } else {
    copy.y = round(room.y + half);
    copy.h = round(room.h - half);
    room.h = half;
  }
  floor.rooms.push(copy);
  store.changed();
  store.select(`${floor.id}/${id}`);
}

function addSiteElement(type) {
  const plot = store.house.site.find((s) => s.type === 'plot');
  const id = uniqueId(slug(type), new Set(store.house.site.map((s) => s.id)));
  const label = (SITE_TYPES[type]?.label || 'Element').replace(/ \(.*\)$/, '');
  // sensible starting sizes (crown diameter for plants), placed in the garden
  const size = { tree: [5, 5, 7], conifer: [3, 3, 8], bush: [1.5, 1.5, 1.4], hedge: [6, 0.8, 1.6], carport: [3.5, 5.5, 2.4], pergola: [4, 3, 2.5], shed: [3, 2.5, 2.5], greenhouse: [3, 4, 2.6] }[type] || [3, 3];
  const x = plot ? round(plot.x + plot.w - 3 - size[0]) : 15;
  const y = plot ? round(plot.y + plot.h - 3 - size[1]) : 15;
  store.house.site.push({ id, name: label, type, x, y, w: size[0], h: size[1], ...(size[2] ? { height: size[2] } : {}) });
  store.changed();
  store.select(`site/${id}`);
}

// Options for adding a door or window to a room: every neighbouring room, and every
// facade where the room touches an exterior wall.
function doorOptions(floor, room) {
  const idx = floor.rooms.indexOf(room);
  const opts = [];
  for (const j of neighbours(floor, idx)) {
    const other = floor.rooms[j];
    opts.push({ value: `door:${other.id}`, label: `Door to ${other.name}` });
    opts.push({ value: `opening:${other.id}`, label: `Open passage to ${other.name}` });
  }
  for (const e of exteriorEdges(floor)) {
    const on = { N: Math.abs(e.y1 - room.y), S: Math.abs(e.y1 - room.y - room.h), W: Math.abs(e.x1 - room.x), E: Math.abs(e.x1 - room.x - room.w) }[e.side] < 0.01;
    if (!on) continue;
    const [a, b] = e.horizontal ? [Math.max(e.x1, room.x), Math.min(e.x2, room.x + room.w)] : [Math.max(e.y1, room.y), Math.min(e.y2, room.y + room.h)];
    if (b - a < 0.6) continue;
    for (const type of Object.keys(OPENING_TYPES)) {
      const value = `ext-${type}:${e.side}:${a}:${b}`;
      if (!opts.some((o) => o.value.startsWith(`ext-${type}:${e.side}:`)))
        opts.push({ value, label: `${OPENING_TYPES[type]} on ${FACADES[e.side]} wall` });
    }
  }
  return opts;
}

function addDoor(floor, room, value) {
  const [type, ...rest] = value.split(':');
  const ids = floorIds(floor);
  if (type === 'door' || type === 'opening') {
    const other = rest[0];
    const d = { id: uniqueId(slug(`d-${room.id}-${other}`), ids), type, between: [room.id, other], offset: 0, width: type === 'opening' ? 1.0 : 0.8, height: 2.1 };
    if (type === 'door') Object.assign(d, { swing: room.id, hinge: 'start' });
    const p = placeDoor(floor, d);
    if (p) d.offset = round(Math.max(0, (p.wallTo - p.wallFrom - d.width) / 2), 0.05);
    (floor.doors ||= []).push(d);
    store.changed();
    store.select(`${floor.id}/${d.id}`);
  } else {
    const [facade, a, b] = [rest[0], Number(rest[1]), Number(rest[2])];
    const kind = type.replace(/^ext-/, '');
    const def = OPENING_DEFAULTS[kind] || OPENING_DEFAULTS.window;
    const width = round(Math.min(def.width, b - a - 0.3), 0.05);
    const start = round(a + (b - a - width) / 2, 0.05);
    const o = { id: uniqueId(`${kind === 'window' ? 'w' : 'd'}-${room.id}-${facade.toLowerCase()}`, ids), type: kind, facade };
    o[facade === 'N' || facade === 'S' ? 'x' : 'y'] = start;
    Object.assign(o, { width, sill: def.sill, height: def.height });
    if (isHinged(o)) Object.assign(o, { hinge: 'start', swing: kind === 'door' ? 'in' : 'out' });
    if (kind === 'sliding-door') o.hinge = 'end';
    (floor.openings ||= []).push(o);
    store.changed();
    store.select(`${floor.id}/${o.id}`);
  }
}

// Doors and windows that belong to a room (interior doors naming it, exterior ones on its walls).
function roomOpenings(floor, room) {
  const out = (floor.doors || []).filter((d) => d.between.includes(room.id)).map((d) => ({ item: d, name: doorName(floor, d) }));
  const edges = exteriorEdges(floor);
  for (const o of floor.openings || []) {
    const p = placeOpening(floor, o, edges);
    if (!p) continue;
    const mid = (p.from + p.to) / 2;
    const inside = p.horizontal ? mid > room.x && mid < room.x + room.w : mid > room.y && mid < room.y + room.h;
    const onWall = { N: Math.abs(p.y1 - room.y), S: Math.abs(p.y1 - room.y - room.h), W: Math.abs(p.x1 - room.x), E: Math.abs(p.x1 - room.x - room.w) }[o.facade] < 0.01;
    if (inside && onWall) out.push({ item: o, name: openingName(floor, o) });
  }
  return out;
}

function numberField(key, label, value, step = 0.05) {
  return `<label>${label}<input type="number" step="${step}" data-key="${key}" value="${fmt(value)}"></label>`;
}

function renderSelection() {
  const panel = $('#selection-panel');
  const focused = document.activeElement?.dataset?.key;
  const t = store.resolve(store.selected);
  if (t.kind === 'house') {
    const tot = totals(store.house);
    const floorRows = tot.floors
      .map(
        (f) =>
          `<div class="stat">${esc(f.name)}: <b>${fmtArea(f.net)} m²</b> rooms, ${fmtArea(f.gross)} m² gross</div>` +
          '',
      )
      .join('');
    panel.innerHTML = `
      <h2>Selection</h2>
      <div class="fields house-meta">
        <label class="wide">House name<input data-meta="name" value="${esc(store.house.name || '')}" placeholder="Name of the house"></label>
        <label class="wide">Description<textarea data-meta="description" rows="2" placeholder="A few words about the house, for you and the professionals">${esc(store.house.description || '')}</textarea></label>
      </div>
      <div class="sub">Whole house. Click a room or site element to edit it. The name appears in the house list, on the printed sheets and in the brief.</div>
      ${floorRows}
      ${collectIssues(store.house)
        .map((i) => `<div class="warnbox">${esc(i.kind)}: ${esc(i.text)} <button class="link" data-select="${esc(i.target)}">Show</button></div>`)
        .join('')}
      <div class="stat">Living area: <b>${fmtArea(tot.net)} m²</b> · gross ${fmtArea(tot.gross)} m²</div>
      <div class="stat">Roof: <b>${esc(store.house.roofs?.length ? `${store.house.roofs.length} roof areas` : ROOF_TYPES[store.house.roof?.type] || 'none')}</b>${roofInfo(store.house).text ? ` · ${esc(roofInfo(store.house).text)}` : ''}
        <button class="link" data-select="roof">Edit roof</button></div>
      <div class="fields">
        <label>Target min (m²)<input type="number" step="1" data-target-key="0" value="${livingRange(store.house)[0]}"></label>
        <label>Target max (m²)<input type="number" step="1" data-target-key="1" value="${livingRange(store.house)[1]}"></label>
      </div>
      ${floorsHtml()}
      ${facadeHtml()}
      ${utilitiesHtml()}
      <div class="row" style="margin-top:10px">
        <button class="small" id="add-room">+ Room on ${esc(store.floor().name.toLowerCase())}</button>
        <select class="small" id="add-site">
          <option value="">+ Site element…</option>
          ${Object.entries(SITE_TYPES)
            .filter(([k]) => k !== 'plot')
            .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`)
            .join('')}
        </select>
      </div>
      ${
        store.house.assumptions?.length
          ? `<details style="margin-top:10px"><summary class="sub" style="cursor:pointer">Assumptions</summary>
             <ul class="assumptions">${store.house.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></details>`
          : ''
      }`;
    panel.querySelectorAll('[data-meta]').forEach((el) =>
      el.addEventListener('change', () => {
        const key = el.dataset.meta;
        const v = el.value.trim();
        if (key === 'name' && !v) {
          el.value = store.house.name || '';
          return toast('A house needs a name', true);
        }
        if (v) store.house[key] = v;
        else delete store.house[key];
        store.changed();
      }),
    );
    $('#add-room', panel).onclick = addRoom;
    $('#add-floor-above', panel).onclick = () => addFloor('above');
    $('#add-floor-below', panel).onclick = () => addFloor('below');
    panel.querySelectorAll('[data-delete-floor]').forEach((b) => (b.onclick = () => deleteFloor(store.house.floors.find((f) => f.id === b.dataset.deleteFloor))));
    panel.querySelectorAll('[data-select]').forEach((b) => (b.onclick = () => store.select(b.dataset.select)));
    panel.querySelectorAll('[data-fkey]').forEach((input) =>
      input.addEventListener('change', () => {
        const floor = store.house.floors.find((f) => f.id === input.dataset.floorId);
        const key = input.dataset.fkey;
        if (key === 'name') return setFloorValue(floor, key, input.value.trim() || floor.name);
        if (key === 'underRoof') {
          if (input.checked) floor.underRoof = true;
          else delete floor.underRoof;
          store.changed();
          if (input.checked) toast('Its outer walls are now the roof, and its windows are dormers. Make sure a roof area sits on the floor below it.');
          return;
        }
        const v = round(Number(input.value));
        if (!Number.isFinite(v) || (key === 'height' && v < 2)) {
          input.value = fmt(floor[key] ?? 0);
          return toast('Floor-to-floor height must be at least 2 m', true);
        }
        setFloorValue(floor, key, v);
      }),
    );
    panel.querySelectorAll('[data-target-key]').forEach((input) =>
      input.addEventListener('change', () => {
        const range = [...livingRange(store.house)];
        range[Number(input.dataset.targetKey)] = Math.max(0, Math.round(Number(input.value) || 0));
        store.house.targets = { ...(store.house.targets || {}), livingArea: range };
        store.changed();
      }),
    );
    $('#add-site', panel).onchange = (e) => e.target.value && addSiteElement(e.target.value);
    bindUtilities(panel);
    bindFacade(panel);
    return;
  }

  if (t.kind === 'door' || t.kind === 'opening') return renderOpeningPanel(panel, t, focused);
  if (t.kind === 'wall') return renderWallPanel(panel, t);
  if (t.kind === 'roof') return renderRoofPanel(panel);
  if (t.kind === 'roofzone') return renderRoofZonePanel(panel, t);
  if (t.kind === 'item') return renderItemPanel(panel, t, document.activeElement?.dataset?.ikey);
  if (t.kind === 'point') return renderPointPanel(panel, t);

  const { item, kind, floor } = t;
  const types = kind === 'room' ? ROOM_TYPES : SITE_TYPES;
  const hasHeight = kind === 'site' && ['garage', 'greenhouse', 'shed', 'carport', 'pergola', 'tree', 'conifer', 'bush', 'hedge', 'slope', 'other'].includes(item.type);
  const shaped = kind === 'site' && isShaped(item);
  const shapeable = kind === 'site' && item.type in SHAPED;
  panel.innerHTML = `
    <h2>Selection</h2>
    <h3>${esc(item.name)}</h3>
    <div class="sub">${kind === 'room' ? esc(floor.name) : 'Site'} · ${esc(types[item.type]?.label || item.type)} ·
      <b>${fmtArea(kind === 'site' ? measure(item).area : area(item))} m²</b></div>
    <div class="fields">
      <label class="wide">Name<input data-key="name" value="${esc(item.name)}"></label>
      <label class="wide">Type<select data-key="type">
        ${Object.entries(types)
          .map(([k, v]) => `<option value="${k}" ${k === item.type ? 'selected' : ''}>${esc(v.label)}</option>`)
          .join('')}
      </select></label>
      ${kind === 'room' && item.type !== 'stairs'
        ? `<label class="wide">Shape<select id="room-round">
            ${[['', 'Rectangle'], ['S', 'Rounded on the south side'], ['N', 'Rounded on the north side'], ['E', 'Rounded on the east side'], ['W', 'Rounded on the west side'], ['all', 'Round / oval']]
              .map(([v, l]) => `<option value="${v}" ${(item.round || '') === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select></label>
          ${item.round ? `<div class="sub wide">The rounded side is as wide as the room; make the room deeper than half its width for a D-shaped tower. Windows on the curve: add a window on that facade. A round room open to the sky gets its own conical roof${item.round === 'all' ? '' : ' (half-cone over the rounded part)'}.</div>${numberField('roofPitch', 'Cone roof pitch (°)', item.roofPitch ?? (item.round === 'all' ? 50 : 40), 1)}` : ''}`
        : ''}
      ${shaped
        ? item.type === 'plot'
          ? ''
          : numberField('width', 'Width (m)', item.width ?? 3)
        : `${numberField('x', 'X (m, east)', item.x)}
           ${numberField('y', 'Y (m, south)', item.y)}
           ${numberField('w', ['tree', 'conifer', 'bush'].includes(item.type) ? 'Crown width (m)' : 'Width (m)', item.w)}
           ${numberField('h', ['tree', 'conifer', 'bush'].includes(item.type) ? 'Crown depth (m)' : 'Depth (m)', item.h)}`}
      ${hasHeight ? numberField('height', item.type in SITE_ROOFED ? (['carport', 'pergola'].includes(item.type) ? 'Clear height (m)' : 'Wall height (m)') : 'Height (m)', item.height ?? SITE_ROOFED[item.type] ?? 2.5, 0.1) : ''}
    </div>
    ${shapeable
      ? shaped
        ? `<div class="sub">${item.type === 'plot' ? `${Math.round(measure(item).area)} m², boundary ${fmt(measure(item).perimeter, 1)} m. ` : `${fmt(measure(item).length, 1)} m long, ${fmtArea(measure(item).area)} m². `}
            In the plan: drag a round point to move it, drag a small + to add a point, double-click a point to remove it, drag the shape itself to move all of it.</div>
           <div class="row" style="margin-bottom:8px"><button class="small" id="shape-rect">Back to a rectangle</button></div>`
        : `<div class="row" style="margin-bottom:8px"><button class="small" id="shape-edit">${item.type === 'plot' ? 'Irregular shape (drag the corners)' : 'Make it curved'}</button></div>`
      : ''}
    ${kind === 'site' && item.type !== 'plot'
      ? `<div class="fields">${numberField('base', 'Raised by (m, e.g. on a roof)', item.base ?? 0, 0.1)}${item.type === 'slope'
          ? `<label>Rises towards<select data-key="up">${[['N', 'North'], ['S', 'South'], ['E', 'East'], ['W', 'West']].map(([v, l]) => `<option value="${v}" ${v === (item.up || 'S') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`
          : ''}</div>`
      : ''}
    ${kind === 'site' && item.type === 'plot'
      ? `<div class="fields"><label>Street side<select data-key="street">
          ${[['N', 'North'], ['S', 'South'], ['E', 'East'], ['W', 'West']].map(([v, l]) => `<option value="${v}" ${v === (item.street || 'N') ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label></div>`
      : ''}
    ${kind === 'site' && item.type in SITE_ROOFED
      ? `<div class="subhead">Roof</div><div class="sub">${esc(roofText(siteRoof(item)))}</div>${roofFieldsHtml(item.roof, SITE_ROOF_DEFAULT)}`
      : ''}
    ${kind === 'room' && item.type === 'stairs' ? stairsHtml(floor, item) : ''}
    ${kind === 'room' ? roomOpeningsHtml(floor, item) : ''}
    ${kind === 'room' ? roomItemsHtml(floor, item) + roomPointsHtml(floor, item) + roomFinishesHtml(floor, item) : ''}
    <div class="row">
      ${kind === 'room' ? '<button class="small" id="split">Split in two</button>' : ''}
      <button class="small danger" id="delete">Delete</button>
      <button class="small" id="deselect">Back to whole house</button>
    </div>`;

  panel.querySelectorAll('[data-key]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.key;
      if (input.type === 'number') {
        const v = round(Number(input.value));
        if (!Number.isFinite(v) || ((key === 'w' || key === 'h' || key === 'height') && v <= 0)) {
          input.value = fmt(item[key]);
          return toast('Enter a positive number', true);
        }
        item[key] = v;
        if (key === 'width' && isShaped(item)) syncBox(item);
      } else {
        // a default name follows the type (e.g. "Garden bed" → "Garden shed"); a custom name stays
        if (key === 'type') {
          const labels = kind === 'room' ? ROOM_TYPES : SITE_TYPES;
          const old = [labels[item.type]?.label, 'Garden bed', 'Shed', 'New room'];
          if (old.includes(item.name)) item.name = labels[input.value]?.label?.replace(/ \(.*\)$/, '') || item.name;
        }
        item[key] = input.value.trim() || item[key];
      }
      store.changed();
    });
  });
  if (focused) panel.querySelector(`[data-key="${focused}"]`)?.focus();
  if (kind === 'site' && item.type in SITE_ROOFED) bindRoofFields(panel, () => (item.roof ||= { ...SITE_ROOF_DEFAULT }));
  const shapeEdit = $('#shape-edit', panel);
  if (shapeEdit)
    shapeEdit.onclick = () => {
      toShape(item);
      store.changed();
      store.emit('selection');
      toast(item.type === 'plot' ? 'Drag the corners; drag a + to add a corner.' : 'Drag the round points to bend it; drag a + to add a point.');
    };
  const shapeRect = $('#shape-rect', panel);
  if (shapeRect)
    shapeRect.onclick = () => {
      toRect(item);
      store.changed();
      store.emit('selection');
    };
  $('#delete', panel).onclick = () => {
    if (!confirm(`Delete ${item.name}?`)) return;
    const list = kind === 'room' ? floor.rooms : store.house.site;
    list.splice(list.indexOf(item), 1);
    if (kind === 'room' && floor.doors) floor.doors = floor.doors.filter((d) => !d.between.includes(item.id));
    if (kind === 'room') pruneWalls(floor);
    store.changed();
    store.select('house');
  };
  $('#deselect', panel).onclick = () => store.select('house');
  if (kind === 'room') {
    const roundSel = $('#room-round', panel);
    if (roundSel)
      roundSel.onchange = () => {
        if (roundSel.value) item.round = roundSel.value;
        else delete item.round;
        store.changed();
        store.emit('selection');
      };
    $('#split', panel).onclick = () => splitRoom(floor, item);
    $('#add-door', panel).onchange = (e) => e.target.value && addDoor(floor, item, e.target.value);
    const storageBox = $('#stairs-storage', panel);
    if (storageBox)
      storageBox.onchange = () => {
        if (storageBox.checked) item.storage = true;
        else delete item.storage;
        store.changed();
        store.emit('selection');
      };
    const windersBox = $('#stairs-winders', panel);
    if (windersBox)
      windersBox.onchange = () => {
        if (windersBox.checked) delete item.winders;
        else item.winders = false;
        store.changed();
        store.emit('selection');
      };
    const fix = $('#fix-stairs', panel);
    if (fix)
      fix.onclick = () => {
        const { actions, remaining } = fixStairs(store.house, floor, item);
        if (actions.length) store.changed();
        toast(actions.length ? actions.join(' ') : remaining.length ? 'Nothing could be fixed automatically — see the notes.' : 'Stairs are already fine.', !actions.length && remaining.length > 0);
        store.emit('selection');
      };
    panel.querySelectorAll('[data-select]').forEach((b) => (b.onclick = () => store.select(b.dataset.select)));
    $('#add-item', panel).onchange = (e) => e.target.value && addItem(floor, item, e.target.value);
    $('#add-point', panel).onchange = (e) => e.target.value && addPoint(floor, item, e.target.value);
    bindFinishEditors(panel, floor, item);
  }
}

// ---------- furniture & appliances ----------

function itemsInRoom(floor, room) {
  return (floor.items || []).filter((it) => {
    const f = footprint(it);
    return roomAt(floor, f.x + f.w / 2, f.y + f.h / 2) === room;
  });
}

function addItem(floor, room, type) {
  const id = uniqueId(slug(type), floorIds(floor));
  const it = newItem(type, id, room.x + room.w / 2, room.y + room.h / 2);
  (floor.items ||= []).push(it);
  if (!store.layers.furniture) setLayer('furniture', true);
  store.changed();
  store.select(`${floor.id}/${id}`);
  toast('Drag it into place; press R to rotate.');
}

function addPoint(floor, room, kind) {
  const id = uniqueId(kind, floorIds(floor));
  (floor.points ||= []).push({ id, kind, x: round(room.x + room.w / 2), y: round(room.y + room.h / 2), h: POINT_KINDS[kind].h, room: room.id });
  setLayer(pointGroup(kind) === 'electrical' ? 'electrical' : 'water', true);
  store.changed();
  store.select(`${floor.id}/${id}`);
}

function needsText(type) {
  const n = ITEMS[type]?.needs;
  if (!n) return '';
  const parts = [];
  if (n.power) parts.push(`${n.power >= 1000 ? `${(n.power / 1000).toFixed(1)} kW` : `${n.power} W`} at ${n.voltage} V${n.dedicated ? ', own circuit' : ''}`);
  if (n.water) parts.push(`${n.water.join(' + ')} water`);
  if (n.drain) parts.push(`drain DN${n.drain}`);
  if (n.gas) parts.push('gas');
  if (n.flue) parts.push('flue');
  if (n.data) parts.push('data');
  return parts.join(' · ');
}

function itemOptions() {
  return Object.entries(ITEM_CATEGORIES)
    .map(([cat, label]) => `<optgroup label="${esc(label)}">${Object.entries(ITEMS)
      .filter(([, v]) => v.cat === cat)
      .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`)
      .join('')}</optgroup>`)
    .join('');
}

function roomItemsHtml(floor, room) {
  const list = itemsInRoom(floor, room);
  return `<div class="subhead">Furniture &amp; appliances</div>
    <ul class="mini-list">
      ${list.map((it) => `<li><button class="link" data-select="${esc(floor.id)}/${esc(it.id)}">${esc(it.name || itemInfo(it).label)}</button><span>${fmt(it.w)} × ${fmt(it.d)}</span></li>`).join('') || '<li class="empty">None yet.</li>'}
    </ul>
    <select class="small" id="add-item" style="margin:6px 0 10px"><option value="">+ Add furniture or appliance…</option>${itemOptions()}</select>`;
}

function roomPointsHtml(floor, room) {
  const pts = (floor.points || []).filter((p) => p.room === room.id);
  const counts = {};
  for (const p of pts) counts[p.kind] = (counts[p.kind] || 0) + 1;
  return `<div class="subhead">Utilities in this room</div>
    <div class="sub" style="margin-bottom:4px">${Object.entries(counts).map(([k, c]) => `${c}× ${esc(POINT_KINDS[k]?.label || k)}`).join(', ') || 'None yet. Use “Generate utilities” in the whole-house panel, or add points by hand.'}</div>
    <select class="small" id="add-point" style="margin:2px 0 10px"><option value="">+ Add utility point…</option>
      ${Object.entries(GROUPS).map(([g, label]) => `<optgroup label="${esc(label)}">${Object.entries(POINT_KINDS).filter(([, v]) => v.group === g).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</optgroup>`).join('')}
    </select>`;
}

function renderItemPanel(panel, t, focused) {
  const { item, floor } = t;
  const info = itemInfo(item);
  const needs = needsText(item.type);
  const circuits = house().electrical?.circuits || [];
  panel.innerHTML = `
    <h2>Selection</h2>
    <h3>${esc(t.name)}</h3>
    <div class="sub">${esc(floor.name)} · ${esc(info.label)}${needs ? ` · needs ${esc(needs)}` : ''}</div>
    <div class="fields">
      <label class="wide">Name<input data-ikey="name" value="${esc(item.name || '')}" placeholder="${esc(info.label)}"></label>
      <label>Width (m)<input type="number" step="0.05" data-ikey="w" value="${fmt(item.w)}"></label>
      <label>Depth (m)<input type="number" step="0.05" data-ikey="d" value="${fmt(item.d)}"></label>
      <label>Height (m)<input type="number" step="0.05" data-ikey="h" value="${fmt(item.h ?? info.h)}"></label>
      <label>Facing<select data-ikey="rot">${[[0, 'South (back to north)'], [90, 'West'], [180, 'North'], [270, 'East']]
        .map(([v, l]) => `<option value="${v}" ${v === (item.rot || 0) ? 'selected' : ''}>${l}</option>`)
        .join('')}</select></label>
      <label>X (m)<input type="number" step="0.05" data-ikey="x" value="${fmt(item.x)}"></label>
      <label>Y (m)<input type="number" step="0.05" data-ikey="y" value="${fmt(item.y)}"></label>
      <label>Colour<input type="color" data-ikey="color" value="${esc(item.color || info.color)}"></label>
      ${ITEMS[item.type]?.needs?.power && circuits.length
        ? `<label>Circuit<select data-ikey="circuit"><option value="">—</option>${circuits.map((c) => `<option value="${esc(c.id)}" ${c.id === item.circuit ? 'selected' : ''}>${esc(c.id)} ${esc(c.name)}</option>`).join('')}</select></label>`
        : ''}
    </div>
    <div class="row">
      <button class="small" id="item-rotate" title="R">Rotate 90°</button>
      <button class="small" id="item-copy">Duplicate</button>
      <button class="small danger" id="item-delete" title="Delete">Delete</button>
      <button class="small" id="deselect">Back to whole house</button>
    </div>`;
  panel.querySelectorAll('[data-ikey]').forEach((input) =>
    input.addEventListener('change', () => {
      const key = input.dataset.ikey;
      if (key === 'rot') {
        rotateItem(item, Number(input.value) - (item.rot || 0));
      } else if (input.type === 'number') {
        const v = round(Number(input.value));
        if (!Number.isFinite(v) || (['w', 'd', 'h'].includes(key) && v <= 0)) return toast('Enter a positive number', true);
        item[key] = v;
      } else if (key === 'name') {
        if (input.value.trim()) item.name = input.value.trim();
        else delete item.name;
      } else item[key] = input.value || undefined;
      store.changed();
      store.emit('selection');
    }),
  );
  if (focused) panel.querySelector(`[data-ikey="${focused}"]`)?.focus();
  $('#item-rotate', panel).onclick = () => rotateSelected();
  $('#item-copy', panel).onclick = () => {
    const copy = { ...item, id: uniqueId(item.id.replace(/-\d+$/, ''), floorIds(floor)), x: round(item.x + 0.3), y: round(item.y + 0.3) };
    delete copy.circuit;
    floor.items.push(copy);
    store.changed();
    store.select(`${floor.id}/${copy.id}`);
  };
  $('#item-delete', panel).onclick = () => deleteSelected();
  $('#deselect', panel).onclick = () => store.select('house');
}

function renderPointPanel(panel, t) {
  const { item: p, floor } = t;
  const circuits = house().electrical?.circuits || [];
  const electrical = pointGroup(p.kind) === 'electrical';
  panel.innerHTML = `
    <h2>Selection</h2>
    <h3>${esc(t.name)}</h3>
    <div class="sub">${esc(floor.name)} · ${p.auto ? 'generated proposal (moving or editing it keeps it)' : 'placed by hand'}${p.size ? ` · DN${p.size}` : ''}</div>
    <div class="fields">
      <label class="wide">Kind<select data-pkey="kind">${Object.entries(GROUPS)
        .map(([g, label]) => `<optgroup label="${esc(label)}">${Object.entries(POINT_KINDS).filter(([, v]) => v.group === g).map(([k, v]) => `<option value="${k}" ${k === p.kind ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</optgroup>`)
        .join('')}</select></label>
      ${p.kind === 'light' ? '' : `<label>Mounting height (m)<input type="number" step="0.05" data-pkey="h" value="${fmt(p.h ?? POINT_KINDS[p.kind]?.h ?? 0.3)}"></label>`}
      ${electrical && circuits.length ? `<label>Circuit<select data-pkey="circuit"><option value="">—</option>${circuits.map((c) => `<option value="${esc(c.id)}" ${c.id === p.circuit ? 'selected' : ''}>${esc(c.id)} ${esc(c.name)}</option>`).join('')}</select></label>` : ''}
      <label>X (m)<input type="number" step="0.05" data-pkey="x" value="${fmt(p.x)}"></label>
      <label>Y (m)<input type="number" step="0.05" data-pkey="y" value="${fmt(p.y)}"></label>
    </div>
    <div class="row">
      <button class="small danger" id="point-delete" title="Delete">Delete</button>
      ${p.room ? `<button class="small" data-select="${esc(floor.id)}/${esc(p.room)}">${esc(roomName(floor, p.room))}</button>` : ''}
      <button class="small" id="deselect">Back to whole house</button>
    </div>`;
  panel.querySelectorAll('[data-pkey]').forEach((input) =>
    input.addEventListener('change', () => {
      const key = input.dataset.pkey;
      if (input.type === 'number') {
        const v = round(Number(input.value));
        if (!Number.isFinite(v)) return toast('Enter a number', true);
        p[key] = v;
      } else p[key] = input.value || undefined;
      delete p.auto;
      store.changed();
      store.emit('selection');
    }),
  );
  panel.querySelectorAll('[data-select]').forEach((b) => (b.onclick = () => store.select(b.dataset.select)));
  $('#point-delete', panel).onclick = () => deleteSelected();
  $('#deselect', panel).onclick = () => store.select('house');
}

function rotateSelected() {
  const t = store.resolve(store.selected);
  if (t?.kind !== 'item') return;
  rotateItem(t.item, 90);
  store.changed();
  store.emit('selection');
}

function deleteSelected() {
  const t = store.resolve(store.selected);
  if (t?.kind === 'item') {
    t.floor.items.splice(t.floor.items.indexOf(t.item), 1);
    // generated points that served this appliance go with it
    if (t.floor.points) t.floor.points = t.floor.points.filter((p) => !(p.auto && p.for === t.item.id));
  } else if (t?.kind === 'point') t.floor.points.splice(t.floor.points.indexOf(t.item), 1);
  else return;
  store.changed();
  store.select('house');
}

const house = () => store.house;

// ---------- utilities summary (whole-house panel) ----------

// ---------- facade ----------

function facadeHtml() {
  const f = facadeSettings(store.house);
  const colour = (key, label) => `<label>${label}<input type="color" data-facade="${key}" value="${esc(f[key])}"></label>`;
  const check = (key, label) => `<label class="check"><input type="checkbox" data-facade="${key}" ${f[key] ? 'checked' : ''}> ${label}</label>`;
  return `<div class="subhead">Facade</div>
    <div class="fields" style="margin-top:0">
      ${colour('render', 'Walls')}${colour('trim', 'Trim & stone')}${colour('shutters', 'Shutters')}${colour('plinthColor', 'Base')}
      ${check('cornice', 'Cornice under the roof')}${check('quoins', 'Corner stones')}
      ${check('bands', 'Band between floors')}${check('plinth', 'Stone base')}
      ${check('rustication', 'Rusticated ground floor (bosáž)')}
    </div>
    <div class="row" style="margin-bottom:6px">
      <button class="small" data-facade-all="shutters" title="All windows and French doors (not small ones)">Shutters on all windows</button>
      <button class="small" data-facade-all="juliet" title="Tall upper-floor windows with a low sill">Juliet balconies upstairs</button>
      <button class="small" data-facade-all="surround">Surrounds on all</button>
    </div>
    <div class="sub">Per window or door: select it to switch shutters, a Juliet balcony or a stone surround on or off.</div>`;
}

function bindFacade(panel) {
  panel.querySelectorAll('[data-facade]').forEach((input) =>
    input.addEventListener('change', () => {
      const key = input.dataset.facade;
      const f = (store.house.facade ||= {});
      f[key] = input.type === 'checkbox' ? input.checked : input.value;
      if (f[key] === FACADE_DEFAULTS[key]) delete f[key];
      if (!Object.keys(f).length) delete store.house.facade;
      store.changed();
    }),
  );
  panel.querySelectorAll('[data-facade-all]').forEach((btn) =>
    (btn.onclick = () => {
      const key = btn.dataset.facadeAll;
      const floors = sortedFloors(store.house);
      let n = 0;
      floors.forEach((floor, i) => {
        if (floor.underRoof) return;
        for (const o of floor.openings || []) {
          const big = (o.width ?? 1) >= 0.8 && (o.height ?? 1.4) >= 1.2;
          const ok = key === 'juliet' ? i > 0 && (o.sill ?? 1) <= 0.6 && o.type !== 'door' : key === 'shutters' ? big && o.type !== 'door' && o.type !== 'sliding-door' : big;
          if (ok && !o[key]) {
            o[key] = true;
            n++;
          }
        }
      });
      store.changed();
      toast(n ? `Added to ${n} opening${n > 1 ? 's' : ''}` : 'Nothing to add');
    }),
  );
}

function utilitiesHtml() {
  const sum = loadSummary(store.house);
  const c = sum.counts;
  const circuits = store.house.electrical?.circuits || [];
  const kw = (w) => `${(w / 1000).toFixed(1)} kW`;
  return `<div class="subhead">Utilities</div>
    <div class="sub">${(c.socket || 0) + (c['socket-counter'] || 0)} sockets, ${c.light || 0} lights, ${c.switch || 0} switches,
      ${(c['water-cold'] || 0) + (c['water-hot'] || 0)} water points, ${c.drain || 0} drains, ${c.gas || 0} gas points, ${circuits.length} circuits.</div>
    ${circuits.length
      ? `<div class="stat">Installed load <b>${kw(sum.installed)}</b> · per phase L1 ${kw(sum.phase.L1)}, L2 ${kw(sum.phase.L2)}, L3 ${kw(sum.phase.L3)}</div>
         <div class="stat">Rough peak ${kw(sum.demand)} per phase → main breaker about <b>3 × ${sum.breaker} A</b></div>
         <details><summary class="sub" style="cursor:pointer">Circuits</summary>
           <table class="mini-table"><tr><th>Id</th><th>Circuit</th><th>Breaker</th><th>Phase</th><th>Load</th></tr>
           ${circuits.map((x) => `<tr><td>${esc(x.id)}</td><td>${esc(x.name)}</td><td>${esc(x.breaker)}${x.rcd ? ' + RCD' : ''}</td><td>${esc(x.phase || '')}</td><td>${x.load ? kw(x.load) : ''}</td></tr>`).join('')}
           </table></details>`
      : ''}
    <div class="row" style="margin-top:6px">
      <button class="small" id="gen-utilities">${circuits.length ? 'Regenerate utilities' : 'Generate utilities'}</button>
      ${circuits.length ? '<button class="small" id="clear-utilities">Remove generated</button>' : ''}
    </div>
    <div class="sub" style="margin-top:6px">A starting proposal from your rooms and appliances: sockets, switches, lights, circuits balanced over three phases,
      water, drains and gas. Points you placed or moved yourself are kept. Your electrician and plumber design the real installation.</div>`;
}

function bindUtilities(panel) {
  $('#gen-utilities', panel).onclick = () => {
    generateUtilities(store.house);
    setLayer('electrical', true);
    setLayer('water', true);
    store.changed();
    toast('Utilities proposal generated. Toggle the Electrical / Water layers to see it.');
  };
  const clear = $('#clear-utilities', panel);
  if (clear)
    clear.onclick = () => {
      for (const f of store.house.floors) if (f.points) f.points = f.points.filter((p) => !p.auto);
      if (store.house.electrical) store.house.electrical.circuits = store.house.electrical.circuits.filter((c) => !c.auto);
      store.changed();
    };
}

// ---------- finishes ----------

const finishTargets = (room) => ({ floor: room.finish?.floor, walls: room.finish?.walls });

function finishEditor(path, finish, { walls = false } = {}) {
  const f = finish || { kind: 'none' };
  const tiles = f.kind === 'tiles';
  const cm = (v, d) => Math.round((v ?? d) * 1000) / 10;
  return `<div class="finish" data-fin="${esc(path)}">
    <div class="fields" style="margin:4px 0">
      <label>Finish<select data-fkey2="kind">
        ${[['none', 'Not set'], ['color', 'Single colour'], ['tiles', 'Tiles']].map(([v, l]) => `<option value="${v}" ${v === (f.kind || 'none') ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
      ${f.kind === 'color' || tiles ? `<label>${tiles ? 'Tile colour' : 'Colour'}<input type="color" data-fkey2="color" value="${esc(f.color || (tiles ? '#e0dcd4' : '#d9cbb3'))}"></label>` : ''}
      ${walls && f.kind && f.kind !== 'none' ? `<label>Up to height (m)<input type="number" step="0.05" min="0.1" data-fkey2="height" value="${fmt(f.height ?? 2.6)}"></label>` : ''}
      ${tiles
        ? `<label>Tile width (cm)<input type="number" step="0.5" min="2" data-fkey2="tileW" value="${cm(f.tileW, 0.6)}"></label>
           <label>Tile length (cm)<input type="number" step="0.5" min="2" data-fkey2="tileH" value="${cm(f.tileH, 0.6)}"></label>
           <label>Grout (mm)<input type="number" step="0.5" min="0" data-fkey2="groutWidth" value="${Math.round((f.groutWidth ?? 0.003) * 10000) / 10}"></label>
           <label>Grout colour<input type="color" data-fkey2="grout" value="${esc(f.grout || '#bdbdbd')}"></label>
           <label>Pattern<select data-fkey2="pattern">${[['straight', 'Straight'], ['brick', 'Brick (½ offset)'], ['diagonal', 'Diagonal 45°']].map(([v, l]) => `<option value="${v}" ${v === (f.pattern || 'straight') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
           <label>Start laying at<select data-fkey2="start">${[['NW', 'North-west corner'], ['NE', 'North-east corner'], ['SW', 'South-west corner'], ['SE', 'South-east corner'], ['center', 'Centre']].map(([v, l]) => `<option value="${v}" ${v === (f.start || 'NW') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
           <div class="dropzone wide" data-drop>
             ${f.texture ? `<img src="${esc(assetUrl(f.texture))}" alt="">` : ''}
             <span>${f.texture ? esc(f.texture.replace('assets/', '')) : 'Drop a photo of the tile here, or'} <label class="link-label">choose a file<input type="file" accept="image/*" hidden data-upload></label></span>
             ${f.texture ? '<button class="link" data-remove-texture type="button">remove</button>' : ''}
           </div>`
        : ''}
    </div></div>`;
}

function roomFinishesHtml(floor, room) {
  const { floor: fl, walls } = finishTargets(room);
  const zones = room.zones || [];
  return `<div class="subhead">Floor finish</div>
    ${finishEditor('floor', fl)}
    <div class="subhead">Wall finish</div>
    ${finishEditor('walls', walls, { walls: true })}
    <div class="subhead">Tile zones (laid in order)</div>
    <ul class="mini-list zones">
      ${zones
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(
          (z) => `<li class="zone"><details><summary><b>${z.order ?? ''}.</b> ${esc(z.name || 'Zone')} <span>${fmt(z.w)} × ${fmt(z.h)} m</span></summary>
            <div class="fields" data-zone="${esc(z.id)}">
              <label class="wide">Name<input data-zkey="name" value="${esc(z.name || '')}"></label>
              <label>Order<input type="number" step="1" min="1" data-zkey="order" value="${z.order ?? 1}"></label>
              <label>X (m)<input type="number" step="0.05" data-zkey="x" value="${fmt(z.x)}"></label>
              <label>Y (m)<input type="number" step="0.05" data-zkey="y" value="${fmt(z.y)}"></label>
              <label>Width (m)<input type="number" step="0.05" data-zkey="w" value="${fmt(z.w)}"></label>
              <label>Depth (m)<input type="number" step="0.05" data-zkey="h" value="${fmt(z.h)}"></label>
              <button class="small danger" data-zone-delete="${esc(z.id)}" type="button">Delete zone</button>
            </div>
            ${finishEditor(`zone:${z.id}`, z.finish)}
          </details></li>`,
        )
        .join('') || '<li class="empty">No zones: the floor finish covers the whole room.</li>'}
    </ul>
    <button class="small" id="add-zone" style="margin:6px 0 10px">+ Zone</button>`;
}

function finishAt(room, path) {
  room.finish ||= {};
  if (path === 'floor') return [room.finish, 'floor'];
  if (path === 'walls') return [room.finish, 'walls'];
  const z = (room.zones || []).find((x) => `zone:${x.id}` === path);
  return [z, 'finish'];
}

async function uploadTexture(file) {
  if (DEMO) throw new Error(DEMO_NOTICE);
  const res = await fetch(houseApi(`assets?name=${encodeURIComponent(file.name)}`), { method: 'POST', body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.file;
}

function bindFinishEditors(panel, floor, room) {
  panel.querySelectorAll('.finish').forEach((box) => {
    const path = box.dataset.fin;
    const set = (changes) => {
      const [owner, key] = finishAt(room, path);
      if (!owner) return;
      if (changes.kind === 'none') delete owner[key];
      else owner[key] = { ...(owner[key] || {}), ...changes };
      if (room.finish && !room.finish.floor && !room.finish.walls) delete room.finish;
      if (!store.layers.finishes) setLayer('finishes', true);
      store.changed();
      store.emit('selection');
    };
    box.querySelectorAll('[data-fkey2]').forEach((input) =>
      input.addEventListener('change', () => {
        const key = input.dataset.fkey2;
        let v = input.value;
        if (key === 'tileW' || key === 'tileH') v = Math.max(0.02, Number(v) / 100);
        else if (key === 'groutWidth') v = Math.max(0, Number(v) / 1000);
        else if (key === 'height') v = Math.max(0.1, Number(v));
        set({ [key]: v });
      }),
    );
    const upload = async (file) => {
      if (!file) return;
      if (!/^image\//.test(file.type)) return toast('Please use an image file', true);
      try {
        toast('Uploading…');
        set({ texture: await uploadTexture(file) });
        toast('Texture added');
      } catch (err) {
        toast(`Upload failed: ${err.message}`, true);
      }
    };
    const drop = box.querySelector('[data-drop]');
    if (drop) {
      drop.addEventListener('dragover', (e) => {
        e.preventDefault();
        drop.classList.add('over');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        upload(e.dataTransfer.files[0]);
      });
      drop.querySelector('[data-upload]').addEventListener('change', (e) => upload(e.target.files[0]));
      const rm = drop.querySelector('[data-remove-texture]');
      if (rm)
        rm.onclick = () => {
          const [owner, key] = finishAt(room, path);
          delete owner[key].texture;
          store.changed();
          store.emit('selection');
        };
    }
  });
  panel.querySelectorAll('[data-zone] [data-zkey]').forEach((input) =>
    input.addEventListener('change', () => {
      const z = room.zones.find((x) => x.id === input.closest('[data-zone]').dataset.zone);
      const key = input.dataset.zkey;
      z[key] = input.type === 'number' ? round(Number(input.value)) : input.value;
      store.changed();
    }),
  );
  panel.querySelectorAll('[data-zone-delete]').forEach((b) =>
    (b.onclick = () => {
      room.zones = room.zones.filter((z) => z.id !== b.dataset.zoneDelete);
      if (!room.zones.length) delete room.zones;
      store.changed();
      store.emit('selection');
    }),
  );
  $('#add-zone', panel).onclick = () => {
    const zones = (room.zones ||= []);
    const n = zones.length + 1;
    zones.push({ id: `z${Date.now().toString(36)}`, name: `Zone ${n}`, order: n, x: room.x, y: room.y, w: round(Math.min(room.w, 2)), h: round(Math.min(room.h, 2)), finish: { kind: 'tiles', tileW: 0.6, tileH: 0.6, pattern: 'straight', start: 'NW' } });
    setLayer('finishes', true);
    store.changed();
    store.emit('selection');
  };
}

// ---------- layers ----------

function setLayer(name, on) {
  store.layers[name] = on;
  try {
    localStorage.setItem('openhomeplan:layers', JSON.stringify(store.layers));
  } catch {}
  document.querySelectorAll('#plan-layers [data-layer]').forEach((b) => b.classList.toggle('active', !!store.layers[b.dataset.layer]));
  store.emit('layers');
}

function stairsHtml(floor, room) {
  const a = analyzeStairs(store.house, floor, room);
  const up = a.flight.up;
  return `<div class="subhead">Stairs check</div>
    <div class="fields" style="margin-top:0">
      <label>Shape<select data-key="shape">
        ${[['straight', 'Straight'], ['U', 'U-shaped (half turn)']].map(([v, l]) => `<option value="${v}" ${v === (room.shape || 'straight') ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
      <label>Climbs towards<select data-key="up">
        ${[['N', 'North'], ['S', 'South'], ['E', 'East'], ['W', 'West']].map(([v, l]) => `<option value="${v}" ${v === up ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
      ${room.shape === 'U'
        ? `<label>Turns<select data-key="turn">
            ${[['right', 'Right'], ['left', 'Left']].map(([v, l]) => `<option value="${v}" ${v === (room.turn || 'right') ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>`
        : ''}
    </div>
    ${room.shape === 'U'
      ? `<label class="check-line"><input type="checkbox" id="stairs-winders" ${room.winders !== false ? 'checked' : ''}> Winders at the turn (shorter than a half landing)</label>`
      : `<label class="check-line"><input type="checkbox" id="stairs-storage" ${room.storage ? 'checked' : ''}> Storage under the stairs (add a door to it from a neighbouring room)</label>`}
    <ul class="checks">
      ${a.ok.map((t) => `<li class="ok">✓ ${esc(t)}</li>`).join('')}
      ${a.issues.map((i) => `<li class="bad">⚠ ${esc(i.text)}</li>`).join('')}
    </ul>
    <div class="row" style="margin:6px 0 4px">
      <button class="small" id="fix-stairs" ${a.issues.length ? '' : 'disabled'}>${a.issues.length ? 'Auto-fix stairs' : 'Stairs look fine'}</button>
    </div>
    <div class="sub">Rules: riser ≤ ${a.rules.maxRiser * 1000} mm, tread ≥ ${a.rules.minTread * 1000} mm, 2·riser + tread ≈ ${a.rules.stepRule * 1000} mm,
      width ≥ ${a.rules.minWidth} m. Planning values only; change them in house.json under rules.stairs. Your architect decides.</div>`;
}

function roomOpeningsHtml(floor, room) {
  const list = roomOpenings(floor, room);
  const opts = doorOptions(floor, room);
  return `<div class="subhead">Doors &amp; windows</div>
    <ul class="mini-list">
      ${list.map(({ item, name }) => `<li><button class="link" data-select="${esc(floor.id)}/${esc(item.id)}">${esc(name)}</button><span>${fmt(item.width)} m</span></li>`).join('') || '<li class="empty">None yet.</li>'}
    </ul>
    <select class="small" id="add-door" style="margin:6px 0 10px">
      <option value="">+ Add door, passage or window…</option>
      ${opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}
    </select>`;
}

function renderOpeningPanel(panel, t, focused) {
  const { item, kind, floor } = t;
  const isDoor = kind === 'door';
  const p = isDoor ? placeDoor(floor, item) : placeOpening(floor, item);
  const along = isDoor ? null : item.facade === 'N' || item.facade === 'S' ? 'x' : 'y';
  const field = (key, label, value, step = 0.05) =>
    `<label>${label}<input type="number" step="${step}" data-key="${key}" value="${fmt(value)}"></label>`;
  const select = (key, label, options, value, wide = true) =>
    `<label class="${wide ? 'wide' : ''}">${label}<select data-key="${key}">${options
      .map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`)
      .join('')}</select></label>`;
  const [a, b] = isDoor ? item.between : [];
  const horiz = p?.horizontal;
  panel.innerHTML = `
    <h2>Selection</h2>
    <h3>${esc(t.name)}</h3>
    <div class="sub">${esc(floor.name)} · ${fmt(item.width)} m wide${p ? '' : ' · <b style="color:var(--warn)">not on a wall</b>'}</div>
    <div class="fields">
      ${
        isDoor
          ? select('type', 'Type', Object.entries(DOOR_TYPES), item.type) +
            field('offset', `From ${horiz ? 'west' : 'north'} end of wall (m)`, item.offset ?? 0) +
            field('width', 'Width (m)', item.width) +
            field('height', 'Height (m)', item.height ?? 2.1) +
            (item.type === 'door'
              ? select('swing', 'Opens into', [[a, roomName(floor, a)], [b, roomName(floor, b)]], item.swing || b, false) +
                select('hinge', 'Hinge', [['start', horiz ? 'West side' : 'North side'], ['end', horiz ? 'East side' : 'South side']], item.hinge || 'start', false)
              : '')
          : select('type', 'Type', Object.entries(OPENING_TYPES), item.type) +
            (isHinged(item)
              ? select('hinge', 'Hinge side', [['start', horiz ? 'West' : 'North'], ['end', horiz ? 'East' : 'South']], item.hinge || 'start', false) +
                select('swing', 'Opens', [['in', 'Inwards'], ['out', 'Outwards']], item.swing || 'in', false)
              : item.type === 'sliding-door'
                ? select('hinge', 'Slides open towards', [['start', horiz ? 'West' : 'North'], ['end', horiz ? 'East' : 'South']], item.hinge || 'end', false)
                : '') +
            field(along, `Start ${along === 'x' ? 'X (m, east)' : 'Y (m, south)'}`, p ? p.from : item[along] ?? 0) +
            field('width', 'Width (m)', item.width) +
            (floor.underRoof && item.type === 'window' ? select('dormer', 'Dormer', [['gable', 'Triangle top'], ['arch', 'Round top'], ['flat', 'Flat top']], item.dormer || 'gable', false) : '') +
            field('sill', 'Sill height (m)', item.sill ?? 0) +
            field('height', 'Height (m)', item.height ?? 1.4) +
            (floor.underRoof
              ? ''
              : `<label class="wide check"><input type="checkbox" data-detail="shutters" ${item.shutters ? 'checked' : ''}> Shutters</label>
                 <label class="wide check"><input type="checkbox" data-detail="juliet" ${item.juliet ? 'checked' : ''}> Juliet balcony (iron railing in front)</label>
                 <label class="wide check"><input type="checkbox" data-detail="surround" ${item.surround ? 'checked' : ''}> Stone surround with keystone</label>`)
      }
    </div>
    <div class="sub">Tip: drag it along the wall in the 2D plan.</div>
    <div class="row">
      <button class="small danger" id="delete">Delete</button>
      ${isDoor ? `<button class="small" data-select="${esc(floor.id)}/${esc(a)}">${esc(roomName(floor, a))}</button><button class="small" data-select="${esc(floor.id)}/${esc(b)}">${esc(roomName(floor, b))}</button>` : ''}
      <button class="small" id="deselect">Back to whole house</button>
    </div>`;
  panel.querySelectorAll('[data-key]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.key;
      if (input.type === 'number') {
        const v = round(Number(input.value));
        if (!Number.isFinite(v) || (['width', 'height'].includes(key) && v <= 0) || v < 0) {
          input.value = fmt(item[key] ?? 0);
          return toast('Enter a positive number', true);
        }
        item[key] = v;
        if (key === along) delete item.offset;
      } else {
        item[key] = input.value;
        if (key === 'type' && isDoor) {
          if (item.type === 'door') Object.assign(item, { swing: item.swing || b, hinge: item.hinge || 'start' });
          else (delete item.swing, delete item.hinge);
        }
        if (key === 'type' && !isDoor) {
          const def = OPENING_DEFAULTS[item.type];
          Object.assign(item, { sill: def.sill, height: def.height });
          if (isHinged(item)) Object.assign(item, { hinge: item.hinge || 'start', swing: item.swing || (item.type === 'door' ? 'in' : 'out') });
          else if (item.type === 'sliding-door') item.hinge = item.hinge || 'end';
          else (delete item.hinge, delete item.swing);
        }
      }
      store.changed();
      if (key === 'type') store.emit('selection');
    });
  });
  if (focused) panel.querySelector(`[data-key="${focused}"]`)?.focus();
  panel.querySelectorAll('[data-detail]').forEach((box) =>
    box.addEventListener('change', () => {
      if (box.checked) item[box.dataset.detail] = true;
      else delete item[box.dataset.detail];
      store.changed();
    }),
  );
  panel.querySelectorAll('[data-select]').forEach((btn) => (btn.onclick = () => store.select(btn.dataset.select)));
  $('#deselect', panel).onclick = () => store.select('house');
  $('#delete', panel).onclick = () => {
    const list = isDoor ? floor.doors : floor.openings;
    list.splice(list.indexOf(item), 1);
    store.changed();
    store.select(isDoor ? `${floor.id}/${a}` : 'house');
  };
}

function renderWallPanel(panel, t) {
  const { floor, wall } = t;
  const p = wall.props;
  const ext = wall.desc.exterior;
  const length = wall.to - wall.from;
  const materials = MATERIALS.includes(p.material) || !p.material ? MATERIALS : [p.material, ...MATERIALS];
  const sides = ext ? [wall.desc.room] : wall.desc.between;
  const doorsHere = ext ? [] : (floor.doors || []).filter((d) => [...d.between].sort().join('|') === wall.desc.between.join('|'));
  panel.innerHTML = `
    <h2>Selection</h2>
    <h3>${esc(t.name)}</h3>
    <div class="sub">${esc(floor.name)} · ${fmt(length)} m long · ${p.loadBearing ? '<b>load-bearing</b>' : 'not load-bearing'}</div>
    <div class="fields">
      ${ext ? '' : `<label class="wide">Type<select data-wkey="type">${Object.entries(WALL_TYPES)
        .map(([k, v]) => `<option value="${k}" ${k === p.type ? 'selected' : ''} ${p.loadBearing && k !== 'wall' ? 'disabled' : ''}>${esc(v)}</option>`)
        .join('')}</select></label>`}
      <label class="wide check"><input type="checkbox" data-wkey="loadBearing" ${p.loadBearing ? 'checked' : ''}> Load-bearing (carries floors or roof above)</label>
      ${ext || p.type !== 'wall' ? '' : `<label>Thickness (m)<input type="number" step="0.025" data-wkey="thickness" value="${fmt(p.thickness, 3)}"></label>`}
      ${p.type === 'wall' ? `<label class="${ext ? 'wide' : ''}">Material<select data-wkey="material">${materials
        .map((m) => `<option ${m === p.material ? 'selected' : ''}>${esc(m)}</option>`)
        .join('')}</select></label>` : ''}
    </div>
    ${doorsHere.length ? `<div class="sub">Openings in this wall: ${doorsHere.map((d) => `<button class="link" data-select="${esc(floor.id)}/${esc(d.id)}">${esc(DOOR_TYPES[d.type])}</button>`).join(', ')}</div>` : ''}
    <div class="row">
      <button class="small" id="wall-line" title="Copy these settings to every wall on the same straight line">Apply to whole wall line</button>
      ${ext ? '' : '<button class="small" id="wall-door">+ Door here</button><button class="small" id="wall-passage">+ Passage here</button>'}
      <button class="small" id="wall-reset">Reset to default</button>
    </div>
    <div class="row" style="margin-top:6px">
      ${sides.map((id) => `<button class="small" data-select="${esc(floor.id)}/${esc(id)}">${esc(roomName(floor, id))}</button>`).join('')}
      <button class="small" id="deselect">Back to whole house</button>
    </div>
    <div class="sub" style="margin-top:8px">Tip: drag a wall to move it; click it to edit it.
      Load-bearing walls get ${fmt(store.house.wall?.loadBearing ?? 0.25)} m by default and are checked against the walls below and slab spans (max ${structureRules(store.house).maxSlabSpan} m).</div>`;

  panel.querySelectorAll('[data-wkey]').forEach((input) =>
    input.addEventListener('change', () => {
      const key = input.dataset.wkey;
      let value = input.type === 'checkbox' ? input.checked : input.value;
      if (key === 'thickness') {
        value = round(Number(value), 0.005);
        if (!(value >= 0.05 && value <= 1)) return toast('Thickness must be between 0.05 and 1 m', true);
      }
      const changes = { [key]: value };
      if (key === 'loadBearing' && value) {
        changes.type = 'wall';
        if (!ext && (wall.props.thickness ?? 0) < (store.house.wall?.loadBearing ?? 0.25)) changes.thickness = store.house.wall?.loadBearing ?? 0.25;
        if (!ext && /11\.5|plasterboard|Drywall/i.test(wall.props.material || '')) changes.material = 'Ceramic block 25 cm';
      }
      if (key === 'loadBearing' && !value && !ext) changes.thickness = store.house.wall?.interior ?? 0.15;
      setWallProps(store.house, floor, wall.desc, changes);
      store.changed();
      store.emit('selection');
    }),
  );
  panel.querySelectorAll('[data-select]').forEach((b) => (b.onclick = () => store.select(b.dataset.select)));
  $('#deselect', panel).onclick = () => store.select('house');
  $('#wall-reset', panel).onclick = () => {
    resetWall(floor, wall.desc);
    store.changed();
    store.emit('selection');
  };
  $('#wall-line', panel).onclick = () => {
    const line = sameLine(store.house, floor, wall);
    const { type, loadBearing, thickness, material } = wall.props;
    for (const w of line) setWallProps(store.house, floor, w.desc, ext ? { loadBearing, material } : { type, loadBearing, thickness, material });
    store.changed();
    store.emit('selection');
    toast(`Applied to ${line.length} wall segment${line.length > 1 ? 's' : ''} on this line`);
  };
  if (!ext) {
    const [a, b] = wall.desc.between;
    const roomA = floor.rooms.find((r) => r.id === a);
    $('#wall-door', panel).onclick = () => addDoor(floor, roomA, `door:${b}`);
    $('#wall-passage', panel).onclick = () => addDoor(floor, roomA, `opening:${b}`);
  }
}

// Roof fields shared by the house roof and garden buildings (garage, shed, greenhouse).
function roofFieldsHtml(roof, defaults, { withWalkable = false } = {}) {
  const r = { ...defaults, ...roof };
  const type = r.type || 'gable';
  const pitched = type !== 'flat';
  return `<div class="fields" data-roof>
      <label class="wide">Shape<select data-rkey="type">
        ${Object.entries(ROOF_TYPES).map(([k, v]) => `<option value="${k}" ${k === type ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select></label>
      ${pitched ? `<label>${type === 'mansard' ? 'Upper pitch (°)' : 'Pitch (°)'}<input type="number" step="1" min="3" max="60" data-rkey="pitch" value="${r.pitch ?? 35}"></label>` : ''}
      ${type === 'mansard'
        ? `<label>Lower pitch (°)<input type="number" step="1" min="45" max="85" data-rkey="lowerPitch" value="${r.lowerPitch ?? 72}"></label>
           <label>Break height (m)<input type="number" step="0.1" min="1" max="4" data-rkey="breakHeight" value="${fmt(r.breakHeight ?? 2.6)}"></label>`
        : ''}
      ${type === 'flat' && withWalkable ? `<label class="wide check"><input type="checkbox" data-rkey="walkable" ${r.walkable ? 'checked' : ''}> Walkable roof terrace with a balustrade</label>` : ''}
      ${type === 'gable' || type === 'hip'
        ? `<label>Ridge runs<select data-rkey="ridge"><option value="x" ${r.ridge !== 'y' ? 'selected' : ''}>East–west</option><option value="y" ${r.ridge === 'y' ? 'selected' : ''}>North–south</option></select></label>`
        : ''}
      ${type === 'shed'
        ? `<label>Slopes down to<select data-rkey="low">${[['S', 'South'], ['N', 'North'], ['E', 'East'], ['W', 'West']]
            .map(([v, l]) => `<option value="${v}" ${(r.low || 'S') === v ? 'selected' : ''}>${l}</option>`)
            .join('')}</select></label>`
        : ''}
      ${pitched
        ? `<label class="wide">${type === 'mansard' ? 'Covering (steep slopes)' : 'Covering'}<select data-rkey="material">
            ${Object.entries(ROOF_COVERINGS).map(([k, c]) => `<option value="${k}" ${k === covering(r) ? 'selected' : ''}>${esc(c.label)} (≈ €${c.price}/m²)</option>`).join('')}
          </select></label>`
        : ''}
      ${type === 'mansard'
        ? `<label class="wide">Covering (shallow top)<select data-rkey="topMaterial">
            ${Object.entries(ROOF_COVERINGS).map(([k, c]) => `<option value="${k}" ${k === covering(r, 'top') ? 'selected' : ''}>${esc(c.label)} (≈ €${c.price}/m²)</option>`).join('')}
          </select></label>`
        : ''}
      <label>Overhang (m)<input type="number" step="0.05" min="0" max="2" data-rkey="overhang" value="${fmt(r.overhang ?? 0.5)}"></label>
      ${type === 'flat' && !r.walkable ? `<label>Parapet (m)<input type="number" step="0.05" min="0" max="1.5" data-rkey="parapet" value="${fmt(r.parapet ?? 0.3)}"></label>` : ''}
    </div>`;
}

// getRoof() returns the roof object to edit, creating it (from defaults) on first change.
function bindRoofFields(panel, getRoof) {
  panel.querySelectorAll('[data-roof] [data-rkey]').forEach((input) =>
    input.addEventListener('change', () => {
      const roof = getRoof();
      const key = input.dataset.rkey;
      let value = input.type === 'checkbox' ? input.checked : input.value;
      if (input.type === 'number') {
        value = Number(value);
        if (!Number.isFinite(value) || value < 0) return toast('Enter a positive number', true);
        if (key === 'pitch') value = Math.min(Math.max(Math.round(value), 3), 60);
      }
      roof[key] = value;
      if (key === 'type') roof.pitch = { shed: 10, gable: 35, hip: 30, mansard: 20 }[value] ?? roof.pitch;
      if (key === 'type' && value === 'mansard') Object.assign(roof, { lowerPitch: roof.lowerPitch ?? 72, breakHeight: roof.breakHeight ?? 2.6, overhang: Math.min(roof.overhang ?? 0.15, 0.2) });
      store.changed();
      store.emit('selection');
    }),
  );
}

function renderRoofPanel(panel) {
  const info = roofInfo(store.house);
  if (Array.isArray(store.house.roofs) && store.house.roofs.length) return renderRoofAreasPanel(panel, info);
  panel.innerHTML = `
    <h2>Selection</h2>
    <h3>Roof</h3>
    <div class="sub">${esc(info.text || '')}</div>
    ${roofFieldsHtml(store.house.roof, { type: 'gable', pitch: 35, ridge: 'x', overhang: 0.5 })}
    <div class="sub">Local zoning rules often prescribe the roof shape, pitch and maximum height; check them before you settle on one.
      Garage, shed and greenhouse roofs are set on those elements.</div>
    <div class="row"><button class="small" id="deselect">Back to whole house</button></div>`;
  bindRoofFields(panel, () => (store.house.roof ||= { type: 'gable', pitch: 35, ridge: 'x', overhang: 0.5 }));
  panel.querySelector('.row').insertAdjacentHTML('afterbegin', '<button class="small" id="split-roof" title="For wings, roof terraces, balconies and mansards">Split into roof areas</button>');
  $('#split-roof', panel).onclick = () => {
    toRoofZones(store.house);
    setLayer('roofs', true);
    store.changed();
    store.emit('selection');
  };
  $('#deselect', panel).onclick = () => store.select('house');
}

function renderRoofAreasPanel(panel, info) {
  const floors = sortedFloors(store.house);
  panel.innerHTML = `
    <h2>Selection</h2>
    <h3>Roofs</h3>
    <div class="sub">${esc(info.text || '')}</div>
    <ul class="mini-list">
      ${store.house.roofs
        .map((z) => `<li><button class="link" data-select="roofs/${esc(z.id)}">${esc(z.name || z.id)}</button><span>${esc(ROOF_TYPES[z.type]?.split(' (')[0] || z.type)}${z.walkable ? ' terrace' : ''} on ${esc(floors.find((f) => f.id === z.on)?.name.toLowerCase() || '?')}</span></li>`)
        .join('')}
    </ul>
    <label class="check-line"><input type="checkbox" id="roof-auto-all" ${store.house.roofAuto === false ? '' : 'checked'}> Fit roofs to the building automatically</label>
    <div class="row" style="margin:8px 0">
      <select class="small" id="add-roof"><option value="">+ Roof area on…</option>${floors.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select>
    </div>
    <div class="sub">Each roof area covers a rectangle of the plan and sits on top of a floor. Use one per building part:
      the main roof, a lower wing, a bay, a balcony or roof terrace (flat and walkable). Turn on the <b>Roofs</b> layer to
      see, move and resize them in the plan. Mark a floor as an attic in the floors table to put it under a roof; its windows become dormers.</div>
    <div class="row"><button class="small" id="deselect">Back to whole house</button></div>`;
  panel.querySelectorAll('[data-select]').forEach((b) => (b.onclick = () => store.select(b.dataset.select)));
  $('#add-roof', panel).onchange = (e) => addRoofZone(e.target.value);
  $('#roof-auto-all', panel).onchange = (e) => {
    if (e.target.checked) delete store.house.roofAuto;
    else store.house.roofAuto = false;
    store.changed();
    store.emit('selection');
  };
  $('#deselect', panel).onclick = () => store.select('house');
}

function addRoofZone(floorId) {
  const floor = store.house.floors.find((f) => f.id === floorId);
  if (!floor) return;
  const b = bbox(floor.rooms);
  const id = uniqueId('roof', new Set((store.house.roofs || []).map((z) => z.id)));
  (store.house.roofs ||= []).push({ id, name: `Roof on ${floor.name.toLowerCase()}`, on: floor.id, x: b.x, y: b.y, w: b.w, h: b.h, ...ROOF_DEFAULTS });
  setLayer('roofs', true);
  store.changed();
  store.select(`roofs/${id}`);
}

function renderRoofZonePanel(panel, t) {
  const z = t.item;
  const floors = sortedFloors(store.house);
  const g = roofZones(store.house).find((x) => x.zone === z)?.geom;
  panel.innerHTML = `
    <h2>Selection</h2>
    <h3>${esc(z.name || 'Roof area')}</h3>
    <div class="sub">${esc(roofText(g))}</div>
    <div class="sub">${store.house.roofAuto === false
      ? 'Roofs are placed by hand for this house.'
      : z.fixed
        ? 'Placed by hand: it stays here when rooms change. <button class="link" id="roof-auto">Fit it automatically again</button>'
        : 'Fits the building automatically. Moving or resizing it places it by hand.'}</div>
    <div class="fields">
      <label class="wide">Name<input data-zkey="name" value="${esc(z.name || '')}"></label>
      <label class="wide">Sits on<select data-zkey="on">${floors.map((f) => `<option value="${esc(f.id)}" ${f.id === z.on ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <label>X (m, east)<input type="number" step="0.05" data-zkey="x" value="${fmt(z.x)}"></label>
      <label>Y (m, south)<input type="number" step="0.05" data-zkey="y" value="${fmt(z.y)}"></label>
      <label>Width (m)<input type="number" step="0.05" data-zkey="w" value="${fmt(z.w)}"></label>
      <label>Depth (m)<input type="number" step="0.05" data-zkey="h" value="${fmt(z.h)}"></label>
    </div>
    ${roofFieldsHtml(z, ROOF_DEFAULTS, { withWalkable: true })}
    <div class="subhead">Chimneys</div>
    <ul class="mini-list">
      ${(z.chimneys || [])
        .map((c, i) => `<li><span>Chimney ${i + 1}</span><span><input type="number" step="0.05" data-chim="${i}" data-ck="x" value="${fmt(c.x)}" title="X"> <input type="number" step="0.05" data-chim="${i}" data-ck="y" value="${fmt(c.y)}" title="Y"> <button class="link" data-chim-del="${i}">remove</button></span></li>`)
        .join('') || '<li class="empty">None.</li>'}
    </ul>
    <div class="row" style="margin:6px 0 10px">
      <button class="small" id="add-chimney">+ Chimney</button>
      ${z.fixed || store.house.roofAuto === false ? '<button class="small danger" id="roof-del">Delete roof area</button>' : ''}
    </div>
    <div class="row"><button class="small" data-select="roof">All roofs</button><button class="small" id="deselect">Back to whole house</button></div>`;
  bindRoofFields(panel, () => z);
  panel.querySelectorAll('[data-zkey]').forEach((input) =>
    input.addEventListener('change', () => {
      const key = input.dataset.zkey;
      if (input.type === 'number') {
        const v = round(Number(input.value));
        if (!Number.isFinite(v) || ((key === 'w' || key === 'h') && v <= 0.5)) return toast('Enter a size above 0.5 m', true);
        z[key] = v;
        z.fixed = true; // typed position/size: keep it
      } else z[key] = input.value.trim() || z[key];
      store.changed();
      store.emit('selection');
    }),
  );
  const auto = $('#roof-auto', panel);
  if (auto)
    auto.onclick = () => {
      delete z.fixed;
      store.changed();
      store.emit('selection');
    };
  panel.querySelectorAll('[data-chim]').forEach((input) =>
    input.addEventListener('change', () => {
      z.chimneys[Number(input.dataset.chim)][input.dataset.ck] = round(Number(input.value) || 0);
      store.changed();
    }),
  );
  panel.querySelectorAll('[data-chim-del]').forEach((b) =>
    (b.onclick = () => {
      z.chimneys.splice(Number(b.dataset.chimDel), 1);
      if (!z.chimneys.length) delete z.chimneys;
      store.changed();
      store.emit('selection');
    }),
  );
  $('#add-chimney', panel).onclick = () => {
    (z.chimneys ||= []).push({ x: round(z.x + z.w / 2 - 0.35), y: round(z.y + z.h / 2 - 0.45), w: 0.7, h: 0.9 });
    store.changed();
    store.emit('selection');
  };
  const del = $('#roof-del', panel);
  if (del) del.onclick = () => {
    store.house.roofs.splice(store.house.roofs.indexOf(z), 1);
    store.changed();
    store.select('roof');
  };
  panel.querySelectorAll('[data-select]').forEach((b) => (b.onclick = () => store.select(b.dataset.select)));
  $('#deselect', panel).onclick = () => store.select('house');
}

// ---------- comments ----------

function splitResolution(body) {
  const i = body.search(/^##\s+Resolution/m);
  return i < 0 ? [body, ''] : [body.slice(0, i).trim(), body.slice(i).replace(/^##\s+Resolution\s*/, '').trim()];
}

function commentItem(c, clickable) {
  const [body, resolution] = splitResolution(c.body);
  const when = c.created ? new Date(c.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return `<li class="${clickable ? 'clickable' : ''}" data-target="${esc(c.target)}">
    <div class="meta"><span>${clickable ? `<b>${esc(c.target_name)}</b> · ` : ''}${esc(when)}</span>
      <span class="badge ${c.status === 'resolved' ? 'resolved' : ''}">${esc(c.status)}</span></div>
    <div class="body">${esc(body)}</div>
    ${resolution ? `<div class="resolution"><b>Resolution:</b> ${esc(resolution)}</div>` : ''}
  </li>`;
}

function renderComments() {
  const t = store.resolve(store.selected);
  const mine = store.comments.filter((c) => c.target === store.selected);
  const panel = $('#comments-panel');
  const draft = $('#comment-text', panel)?.value || '';
  panel.innerHTML = `
    <h2>Comments on ${esc(t.name)}</h2>
    <ul class="comment-list">${mine.map((c) => commentItem(c, false)).join('') || '<li class="empty">No comments yet.</li>'}</ul>
    ${DEMO ? `<p class="empty">Comments are saved as files next to your house, so they need the <a href="${INSTALL_URL}" target="_blank" rel="noopener">installed app</a>.</p>` : `<div style="margin-top:10px">
      <textarea id="comment-text" placeholder="Write a comment about ${esc(t.name)}…">${esc(draft)}</textarea>
      <div class="row" style="justify-content:flex-end;margin-top:6px">
        <button class="primary" id="comment-add">Add comment</button>
      </div>
    </div>`}`;
  if ($('#comment-add', panel)) $('#comment-add', panel).onclick = async () => {
    const text = $('#comment-text', panel).value.trim();
    if (!text) return toast('Write something first', true);
    try {
      const { comment, commit } = await api('POST', houseApi('comments'), {
        target: store.selected,
        target_name: t.name,
        text,
      });
      $('#comment-text', panel).value = '';
      toast(`Comment saved as ${comment.file}${commit ? ` (commit ${commit})` : ''}`);
      await loadComments();
      loadHistory();
    } catch (err) {
      toast(`Could not save comment: ${err.message}`, true);
    }
  };

  const filter = $('#comment-filter .active').dataset.filter;
  const all = store.comments.filter((c) => c.status === filter || (filter === 'resolved' && c.folder === 'resolved'));
  const unique = [...new Map(all.map((c) => [c.id, c])).values()];
  $('#all-comments').innerHTML = unique.map((c) => commentItem(c, true)).join('') || `<li class="empty">No ${filter} comments.</li>`;
}

async function loadComments() {
  store.comments = await api('GET', houseApi('comments'));
  store.emit('comments');
}

async function loadHistory() {
  try {
    const log = await api('GET', houseApi('history?n=20'));
    $('#history').innerHTML =
      log
        .map(
          (e) => `<li><code>${esc(e.hash)}</code><span>${esc(e.subject)}</span>
            <span class="when">${esc(new Date(e.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))} · ${esc(e.author)}</span></li>`,
        )
        .join('') || `<li class="empty">${DEMO ? 'The online demo keeps no history.' : 'No commits yet.'}</li>`;
  } catch (err) {
    $('#history').innerHTML = `<li class="empty">History unavailable: ${esc(err.message)}</li>`;
  }
}

// ---------- views ----------

let view3d = null;
let costsView = null;
let mode3d = 'whole';
async function showView(view) {
  store.view = view;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#plan').classList.toggle('hidden', view !== 'plan');
  $('#view3d').classList.toggle('hidden', view !== '3d');
  $('#costs').classList.toggle('hidden', view !== 'costs');
  $('#hint').classList.toggle('hidden', view === 'costs');
  $('#plan-floors').classList.toggle('hidden', view !== 'plan');
  $('#plan-layers').classList.toggle('hidden', view !== 'plan');
  $('#add-room-btn').classList.toggle('hidden', view !== 'plan');
  $('#view3d-modes').classList.toggle('hidden', view !== '3d');
  $('#hint').textContent =
    view === 'costs'
      ? ''
      : view === 'plan'
      ? 'Drag a wall to move it (rooms on both sides follow) · drag rooms to move · Shift+drag a handle resizes one room only · drag doors/windows along walls · scroll to zoom'
      : 'Drag to orbit · right-drag to pan · scroll to zoom · click a room or element to select it';
  if (view === 'costs') costsView.render();
  if (view === '3d') {
    if (!view3d) {
      const { create3D } = await import('./view3d.js');
      view3d = create3D($('#view3d'), store);
      if (mode3d !== 'whole') view3d.setMode(mode3d);
    }
    view3d.resize();
  }
}

// ---------- boot ----------

// The online demo says up front, and keeps saying, that nothing is kept.
function demoBanner() {
  document.body.classList.add('demo');
  $('#save').textContent = 'Saving off';
  $('#save').title = DEMO_NOTICE;
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div class="demo-banner" role="note"><b>Online demo.</b> Explore and change anything, but nothing is saved: your changes are lost when you reload or close this tab. Exports download to your own computer. <a href="${INSTALL_URL}" target="_blank" rel="noopener">Install OpenHomePlan (free)</a> to keep your houses.</div>`,
  );
}

async function boot() {
  if (DEMO) demoBanner();
  const houses = await api('GET', 'api/houses');
  let last = null;
  try {
    last = localStorage.getItem('openhomeplan:last-house') || localStorage.getItem('house-planner:last-house');
  } catch {}
  const wanted = new URLSearchParams(location.search).get('house') || last;
  store.slug = (houses.find((h) => h.slug === wanted) || houses[0])?.slug;
  if (!store.slug) {
    document.body.classList.add('no-house');
    return newHouseDialog();
  }
  rememberHouse(store.slug);
  if (new URLSearchParams(location.search).get('house') !== store.slug) history.replaceState(null, '', `?house=${encodeURIComponent(store.slug)}`);
  renderHousePicker();
  store.house = await api('GET', houseApi('house'));
  store.saved = JSON.stringify(store.house);
  const renamed = fixDuplicateIds(store.house);
  if (renamed) setTimeout(() => toast(`Fixed ${renamed} duplicate id${renamed > 1 ? 's' : ''} in this house. Save to keep it.`), 300);
  if (syncRoofZones(store.house)) setTimeout(() => toast('The roofs were re-fitted to the building. Save to keep it.'), 300);
  store.last = JSON.stringify(store.house);
  store.floorId = (sortedFloors(store.house).find((f) => (f.elevation ?? 0) >= -0.5) || store.house.floors[0])?.id;

  createPlan($('#plan'), store);
  costsView = createCostsView($('#costs'), store, (only) => openPrint(only));

  store.on((reason) => {
    if (reason === 'house' || reason === 'saved') {
      updateTopbar();
      renderSelection();
      renderFloorTabs();
    }
    if (reason === 'house') renderComments();
    if (reason === 'selection') {
      renderSelection();
      renderComments();
    }
    if (reason === 'comments') renderComments();
    if (reason === 'floor') {
      renderFloorTabs();
      if (store.selected === 'house') renderSelection();
    }
  });

  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  $('#plan-floors').onclick = (e) => {
    const id = e.target.closest('button')?.dataset.floor;
    if (!id) return;
    store.floorId = id;
    renderFloorTabs();
    store.emit('floor');
  };
  $('#view3d-modes').onclick = (e) => {
    const mode = e.target.closest('button')?.dataset.mode;
    if (!mode) return;
    document.querySelectorAll('#view3d-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    mode3d = mode;
    view3d?.setMode(mode);
  };
  document.querySelectorAll('#plan-layers [data-layer]').forEach((b) => {
    b.classList.toggle('active', !!store.layers[b.dataset.layer]);
    b.onclick = () => setLayer(b.dataset.layer, !store.layers[b.dataset.layer]);
  });
  $('#comment-filter').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#comment-filter button').forEach((b) => b.classList.toggle('active', b === btn));
    renderComments();
  };
  $('#all-comments').onclick = (e) => {
    const li = e.target.closest('li[data-target]');
    if (!li) return;
    if (store.resolve(li.dataset.target)) store.select(li.dataset.target);
    else toast('That item no longer exists in the plan', true);
  };
  async function openPrint(only) {
    // the demo can't save, so the print tab reads the plan as it is now from this window
    if (DEMO) window.openhomeplanHouse = JSON.parse(JSON.stringify(store.house));
    else if (store.dirty) {
      if (!confirm('The printout is made from the saved version. Save your changes first?')) return;
      await save();
    }
    window.open(`print.html?house=${encodeURIComponent(store.slug)}${only ? `&only=${only}` : ''}`, '_blank');
  }
  $('#export-menu').addEventListener('click', async (e) => {
    const kind = e.target.closest('[data-export]')?.dataset.export;
    if (!kind) return;
    $('#export-menu').open = false;
    if (kind === 'dxf') return download(`${fileSlug(store.house.name)}.dxf`, houseToDxf(store.house), 'application/dxf');
    if (kind === 'csv') return download(`${fileSlug(store.house.name)}-costs.csv`, estimateCsv(store.house), 'text/csv');
    if (kind === 'md') {
      const { text } = await api('GET', houseApi('brief'));
      return download(`${fileSlug(store.house.name)}-brief.md`, briefMarkdown(buildBrief(store.house, { comments: store.comments, briefText: text })), 'text/markdown');
    }
    openPrint(kind === 'costs' ? 'costs' : null);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#export-menu')) $('#export-menu').open = false;
  });
  $('#totals').addEventListener('click', (e) => {
    if (!e.target.closest('#issues-btn')) return;
    const pop = $('#issues-pop');
    pop.hidden = !pop.hidden;
    if (!pop.hidden) renderIssues();
  });
  $('#add-room-btn').onclick = () => addRoom();
  $('#save').onclick = save;
  $('#undo').onclick = () => store.undo();
  $('#redo').onclick = () => store.redo();
  $('#discard').onclick = discard;
  window.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select');
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    } else if (mod && !typing && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      store.redo();
    } else if (mod && !typing && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      store.undo();
    } else if (!typing && !mod && (e.key === 'r' || e.key === 'R')) {
      rotateSelected();
    } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
      const k = store.resolve(store.selected)?.kind;
      if (k === 'item' || k === 'point') {
        e.preventDefault();
        deleteSelected();
      }
    } else if (e.key === 'Escape' && !e.target.closest('input, textarea, select')) {
      store.select('house');
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (store.dirty) e.preventDefault();
  });

  renderFloorTabs();
  updateTopbar();
  renderSelection();
  renderComments();
  showView('plan');
  store.emit('floor');
  await loadComments();
  loadHistory();
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#c2410c">Failed to start: ${esc(err.stack || err.message)}</pre>`;
});
