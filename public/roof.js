// Roof shapes. A house has either one roof (house.roof, over the top floor) or several roof
// areas (house.roofs), each over a rectangle of wall axes on a given floor:
//   { id, name, on: floorId, x, y, w, h, type, pitch, ridge, low, overhang, parapet,
//     walkable (flat roof terrace with a balustrade), lowerPitch & breakHeight (mansard),
//     chimneys: [{ x, y, w, h }] }
// type: flat | shed (mono-pitch) | gable | hip | mansard; ridge 'x' east–west | 'y' north–south.
import { bbox, exteriorEdges, round, roundShape, inRoom, inRoundPart } from './geometry.js';
import { sortedFloors } from './stairs.js';

export const ROOF_TYPES = {
  flat: 'Flat',
  shed: 'Mono-pitch (one slope)',
  gable: 'Gable (two slopes, triangle ends)',
  hip: 'Hip (four slopes)',
  mansard: 'Mansard (steep lower + shallow upper slopes)',
};

export const ROOF_DEFAULTS = { type: 'gable', pitch: 35, ridge: 'x', overhang: 0.5 };
const deg = (v) => (v * Math.PI) / 180;

// Shape of a roof over the rectangle `outer` (outer faces of the walls) with eaves at `eave`.
export function roofShape(outer, eave, cfg, ext, defaults = {}) {
  cfg = { ...defaults, ...(cfg || {}) };
  const type = ROOF_TYPES[cfg.type] ? cfg.type : 'gable';
  const t = Math.tan(((cfg.pitch ?? 35) * Math.PI) / 180);
  let rise = 0;
  if (type === 'gable' || type === 'hip') rise = ((cfg.ridge === 'y' ? outer.w : outer.h) / 2) * t;
  if (type === 'hip') rise = Math.min(rise, (Math.min(outer.w, outer.h) / 2) * t);
  if (type === 'shed') rise = (cfg.low === 'E' || cfg.low === 'W' ? outer.w : outer.h) * t;
  let mansard = null;
  if (type === 'mansard') {
    // steep lower slopes up to the break, then a shallow hipped top over the inset rectangle
    const lower = deg(cfg.lowerPitch ?? 72);
    const brk = cfg.breakHeight ?? 2.6;
    const inset = Math.min(brk / Math.tan(lower), Math.min(outer.w, outer.h) / 2 - 0.2);
    const inner = { x: outer.x + inset, y: outer.y + inset, w: outer.w - 2 * inset, h: outer.h - 2 * inset };
    const upper = (Math.min(inner.w, inner.h) / 2) * Math.tan(deg(cfg.pitch ?? 20));
    mansard = { lower, brk, inset, inner, upper };
    rise = brk + upper;
  }
  return { cfg, type, outer, eave, rise, ext, overhang: cfg.overhang ?? 0.5, mansard };
}

// Height of the drawn roof surface above a plan point (null outside the roof), e.g. to make a
// dormer's own roof run back until it meets the main roof.
export function roofHeightAt(g, x, y) {
  const o = g.outer;
  const ov = g.overhang ?? 0;
  const dx = Math.min(x - (o.x - ov), o.x + o.w + ov - x);
  const dy = Math.min(y - (o.y - ov), o.y + o.h + ov - y);
  const d = Math.min(dx, dy);
  if (d < 0) return null;
  const tan = (a) => Math.tan((a * Math.PI) / 180);
  if (g.type === 'mansard') {
    const m = g.mansard;
    const run = m.inset + ov;
    if (d <= run) return g.eave + (m.brk * d) / run;
    const r = m.inner;
    const di = Math.max(0, Math.min(x - r.x, r.x + r.w - x, y - r.y, r.y + r.h - y));
    return g.eave + m.brk + Math.min(di * tan(g.cfg.pitch ?? 20), m.upper);
  }
  const t = tan(g.cfg.pitch ?? 35);
  const low = g.eave - ov * t;
  if (g.type === 'flat') return g.eave;
  if (g.type === 'hip') return Math.min(low + d * t, g.eave + g.rise);
  if (g.type === 'gable') return Math.min(low + (g.cfg.ridge === 'y' ? dx : dy) * t, g.eave + g.rise);
  if (g.type === 'shed') {
    const from = { N: y - (o.y - ov), S: o.y + o.h + ov - y, W: x - (o.x - ov), E: o.x + o.w + ov - x }[g.cfg.low || 'S'];
    return low + from * t;
  }
  return null;
}

// Every roof of the house as { zone, geom } (zone is null for a single legacy roof).
export function roofZones(house) {
  if (!Array.isArray(house.roofs) || !house.roofs.length) {
    const g = roofGeometry(house);
    return g ? [{ zone: null, geom: g, id: 'roof' }] : [];
  }
  const ext = house.wall?.exterior ?? 0.4;
  const floors = sortedFloors(house);
  return house.roofs
    .map((z) => {
      const floor = floors.find((f) => f.id === z.on) || floors[floors.length - 1];
      if (!floor) return null;
      const outer = { x: z.x - ext / 2, y: z.y - ext / 2, w: z.w + ext, h: z.h + ext };
      // over an attic with a knee wall the eaves sit that much above the attic floor
      const attic = floors[floors.indexOf(floor) + 1];
      const cx = z.x + z.w / 2;
      const cy = z.y + z.h / 2;
      const knee = attic?.underRoof && attic.rooms?.some((r) => cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h) ? kneeWall(attic) : 0;
      const eave = (floor.elevation ?? 0) + (floor.height ?? 2.8) + knee;
      return { zone: z, floor, id: z.id, geom: roofShape(outer, eave, z, ext, ROOF_DEFAULTS) };
    })
    .filter(Boolean);
}

// Edges of a flat roof that are open (need a balustrade): those not against a wall of a
// floor that rises above the roof. Returns [[x1, y1, x2, y2], …] on the outer face.
export function openEdges(house, g) {
  const o = g.outer;
  const higher = sortedFloors(house).filter((f) => (f.elevation ?? 0) >= g.eave - 0.01);
  const ext = g.ext;
  const against = (x1, y1, x2, y2) =>
    higher.some((f) =>
      exteriorEdges(f).some((e) =>
        y1 === y2
          ? e.horizontal && Math.abs(e.y1 - y1) < ext && Math.min(e.x2, Math.max(x1, x2)) - Math.max(e.x1, Math.min(x1, x2)) > 0.3
          : !e.horizontal && Math.abs(e.x1 - x1) < ext && Math.min(e.y2, Math.max(y1, y2)) - Math.max(e.y1, Math.min(y1, y2)) > 0.3,
      ),
    );
  return [
    [o.x, o.y, o.x + o.w, o.y],
    [o.x + o.w, o.y, o.x + o.w, o.y + o.h],
    [o.x, o.y + o.h, o.x + o.w, o.y + o.h],
    [o.x, o.y, o.x, o.y + o.h],
  ].filter((e) => !against(...e));
}

// Roof surface area (m²) of one roof geometry, for costs.
// Roof coverings: colour in 3D and price per m² of roof (on top of the structure and insulation).
// A mansard can have a different covering on its shallow top (`topMaterial`), e.g. zinc.
export const ROOF_COVERINGS = {
  'concrete-tile': { label: 'Concrete tiles', price: 55, color: '#45484d' },
  'clay-tile': { label: 'Clay tiles, terracotta', price: 70, color: '#9a5038' },
  'clay-tile-dark': { label: 'Clay tiles, anthracite', price: 75, color: '#3d3f43' },
  'fibre-slate': { label: 'Fibre-cement slates', price: 60, color: '#4a4d53' },
  slate: { label: 'Natural slate', price: 90, color: '#3a3d43' },
  zinc: { label: 'Titanium zinc, standing seam', price: 85, color: '#8f969c', metal: true },
  steel: { label: 'Steel sheet, standing seam', price: 45, color: '#33363a', metal: true },
};
export const defaultCovering = (type) => (type === 'mansard' ? 'slate' : 'concrete-tile');
export function covering(cfg, part = 'main') {
  const key = (part === 'top' && cfg?.topMaterial) || cfg?.material || defaultCovering(cfg?.type);
  return ROOF_COVERINGS[key] ? key : defaultCovering(cfg?.type);
}

// Sloped roof area split into the main slopes and (for a mansard) its shallow top.
export function roofParts(g) {
  if (g.type !== 'mansard') return { main: roofArea(g), top: 0 };
  const top = (g.mansard.inner.w * g.mansard.inner.h) / Math.cos(deg(g.cfg.pitch ?? 20));
  return { main: roofArea(g) - top, top };
}

export function roofArea(g) {
  const ov = g.overhang;
  if (g.type === 'flat') return g.outer.w * g.outer.h;
  if (g.type === 'mansard') {
    const m = g.mansard;
    const slant = m.brk / Math.sin(m.lower);
    const mid = 2 * (g.outer.w + m.inner.w) / 2 + 2 * (g.outer.h + m.inner.h) / 2;
    return mid * slant + (m.inner.w * m.inner.h) / Math.cos(deg(g.cfg.pitch ?? 20)) + 2 * (g.outer.w + g.outer.h) * ov;
  }
  return ((g.outer.w + 2 * ov) * (g.outer.h + 2 * ov)) / Math.cos(deg(g.cfg.pitch ?? 35));
}

// Convert a single legacy roof into roof areas (one over the top floor).
export function toRoofZones(house) {
  if (Array.isArray(house.roofs) && house.roofs.length) return house.roofs;
  const floors = sortedFloors(house);
  const top = floors[floors.length - 1];
  const b = bbox(top.rooms);
  house.roofs = [{ id: 'main', name: 'Main roof', on: top.id, x: b.x, y: b.y, w: b.w, h: b.h, ...ROOF_DEFAULTS, ...(house.roof || {}) }];
  delete house.roof;
  return house.roofs;
}

export function roofGeometry(house) {
  const floors = sortedFloors(house);
  const top = floors[floors.length - 1];
  if (!top || !top.rooms.length) return null;
  const ext = house.wall?.exterior ?? 0.4;
  const b = bbox(top.rooms);
  const outer = { x: b.x - ext / 2, y: b.y - ext / 2, w: b.w + ext, h: b.h + ext };
  const eave = (top.elevation ?? 0) + (top.height ?? 2.8);
  return roofShape(outer, eave, house.roof, ext, { type: 'gable', pitch: 35 });
}

// Garden buildings with their own roof (stored on the site element as `roof`).
export const SITE_ROOFED = { garage: 3.0, shed: 2.5, greenhouse: 2.6, carport: 2.4, pergola: 2.5 };

// A carport (or pergola) whose flat roof is a walkable terrace: a slab on concrete pillars with a
// railing on its open sides. `attached` lists the sides that rest on the house or join another
// deck (e.g. 'S', or 'WN' for a balcony along a west wall that meets a terrace in the north).
export const isTerraceOnPosts = (s) => (s.type === 'carport' || s.type === 'pergola') && s.roof?.type === 'flat' && !!s.roof.walkable;
export const POST_SIZE = (s) => (isTerraceOnPosts(s) ? 0.3 : 0.15);

// Post centres: `s.posts` ([[x, y], …]) if given, else round the edges, at most `max` apart,
// leaving out the attached side.
export function sitePosts(s, max = isTerraceOnPosts(s) ? 3.5 : 5) {
  if (Array.isArray(s.posts) && s.posts.length) return s.posts.map(([x, y]) => [x, y]);
  const p = POST_SIZE(s) / 2;
  const along = (a, b) => {
    const n = Math.max(1, Math.ceil((b - a) / max));
    return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  };
  const xs = along(s.x + p, s.x + s.w - p);
  const ys = along(s.y + p, s.y + s.h - p);
  const out = new Map();
  const put = (x, y) => out.set(`${x.toFixed(3)},${y.toFixed(3)}`, [x, y]);
  const a = s.attached || '';
  if (!a.includes('N')) for (const x of xs) put(x, ys[0]);
  if (!a.includes('S')) for (const x of xs) put(x, ys[ys.length - 1]);
  if (!a.includes('W')) for (const y of ys) put(xs[0], y);
  if (!a.includes('E')) for (const y of ys) put(xs[xs.length - 1], y);
  return [...out.values()];
}

// Open edges of a terrace on posts (everything but the attached side): [[x1, y1, x2, y2], …]
export function terraceRailEdges(s) {
  const e = { N: [s.x, s.y, s.x + s.w, s.y], S: [s.x, s.y + s.h, s.x + s.w, s.y + s.h], W: [s.x, s.y, s.x, s.y + s.h], E: [s.x + s.w, s.y, s.x + s.w, s.y + s.h] };
  return Object.entries(e).filter(([side]) => !(s.attached || '').includes(side)).map(([, v]) => v);
}
export const SITE_ROOF_DEFAULT = { type: 'flat', parapet: 0, overhang: 0.1 };

export function siteRoof(el) {
  if (!(el.type in SITE_ROOFED)) return null;
  const eave = el.height ?? SITE_ROOFED[el.type];
  return roofShape({ x: el.x, y: el.y, w: el.w, h: el.h }, eave, el.roof, 0.25, SITE_ROOF_DEFAULT);
}

export function roofText(g) {
  if (!g) return '';
  const top = g.type === 'flat' ? g.eave + (g.cfg.walkable ? 1.0 : g.cfg.parapet ?? 0.3) : g.eave + g.rise;
  const cover = g.type === 'flat' ? '' : `${ROOF_COVERINGS[covering(g.cfg)].label.toLowerCase()}${g.type === 'mansard' && covering(g.cfg, 'top') !== covering(g.cfg) ? ` (top: ${ROOF_COVERINGS[covering(g.cfg, 'top')].label.toLowerCase()})` : ''}, `;
  return `${g.type === 'flat' ? '' : `${g.cfg.pitch ?? 35}°, `}${cover}highest point ${top.toFixed(1)} m above ground`;
}

export function roofInfo(house) {
  const zones = roofZones(house);
  if (!zones.length) return { text: '' };
  const tops = zones.map(({ geom: g }) => (g.type === 'flat' ? g.eave + (g.cfg.walkable ? 1.0 : g.cfg.parapet ?? 0.3) : g.eave + g.rise));
  const top = Math.max(...tops);
  const main = zones[tops.indexOf(top)].geom;
  const kinds = [...new Set(zones.map((z) => ROOF_TYPES[z.geom.type]?.split(' (')[0]))].join(', ');
  const pitch = zones.length === 1 && main.type !== 'flat' ? `${main.cfg.pitch ?? 35}°, ` : zones.length > 1 ? `${zones.length} roof areas (${kinds}), ` : '';
  return { ...main, top, zones, text: `${pitch}highest point ${top.toFixed(1)} m above ground floor level` };
}

// ---------- roofs that follow the building ----------

// Re-fit the roof areas to the building: every part of a floor that has no (non-attic) floor
// above it needs a roof. The top of the building gets the main roof shape, lower parts open to
// the sky become flat roofs (or keep being terraces). Roof areas placed by hand (`fixed`) stay
// where they are. Returns true when something changed. Turn off with house.roofAuto = false.
export function syncRoofZones(house) {
  if (!Array.isArray(house.roofs) || !house.roofs.length || house.roofAuto === false) return false;
  const before = JSON.stringify(house.roofs);
  const STEP = 0.05;
  const floors = sortedFloors(house).filter((f) => f.rooms.length);
  // cell indices are offset so rooms at negative coordinates still encode as positive keys
  const OFF = 20000;
  const idx = (v) => Math.round(v / STEP) + OFF;
  const at = (k) => round((k - OFF) * STEP);
  // rounded parts of round rooms get their own cone roof (roundRoofs), not a roof area
  const caps = new Map(floors.map((f) => [f.id, new Set()]));
  const covers = (f) => {
    const s = new Set();
    for (const r of f.rooms) {
      const round = roundShape(r);
      for (let j = idx(r.y); j < idx(r.y + r.h); j++)
        for (let i = idx(r.x); i < idx(r.x + r.w); i++) {
          if (round) {
            const x = (i - OFF + 0.5) * STEP;
            const y = (j - OFF + 0.5) * STEP;
            if (!inRoom(r, x, y)) continue;
            caps.get(f.id).add(j * 100000 + i); // the whole round room: cone (+ gable) roof
          }
          s.add(j * 100000 + i);
        }
    }
    return s;
  };
  const cells = new Map(floors.map((f) => [f.id, covers(f)]));
  const result = [];
  const used = new Set();
  const ids = new Set(house.roofs.map((z) => z.id));
  const newId = (base) => {
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
  // the greedy cover: widest row first, then as far down as the row stays complete
  const cover = (open) => {
    const rects = [];
    for (const c of [...open].sort((a, b) => a - b)) {
      if (!open.has(c)) continue;
      const j0 = Math.floor(c / 100000);
      const i0 = c - j0 * 100000;
      let i1 = i0;
      while (open.has(j0 * 100000 + i1 + 1)) i1++;
      let j1 = j0;
      const rowFull = (jj) => {
        for (let ii = i0; ii <= i1; ii++) if (!open.has(jj * 100000 + ii)) return false;
        return true;
      };
      while (rowFull(j1 + 1)) j1++;
      for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) open.delete(jj * 100000 + ii);
      const r = { x: at(i0), y: at(j0), w: round((i1 - i0 + 1) * STEP), h: round((j1 - j0 + 1) * STEP) };
      if (Math.min(r.w, r.h) >= 0.3) rects.push(r);
    }
    return rects.sort((a, b) => b.w * b.h - a.w * a.h);
  };
  // compare against where each roof area was before this re-fit
  const prev = new Map(house.roofs.map((z) => [z, { x: z.x, y: z.y, w: z.w, h: z.h }]));
  const overlap = (z, r) => {
    const q = prev.get(z) || z;
    return Math.max(0, Math.min(q.x + q.w, r.x + r.w) - Math.max(q.x, r.x)) * Math.max(0, Math.min(q.y + q.h, r.y + r.h) - Math.max(q.y, r.y));
  };
  floors.forEach((f, k) => {
    if (f.underRoof) return;
    const higher = floors.slice(k + 1);
    const above = higher.filter((u) => !u.underRoof);
    const attics = higher.filter((u) => u.underRoof);
    const fixed = house.roofs.filter((z) => z.on === f.id && z.fixed);
    // "main": the building's top (or under an attic) gets the main roof shape;
    // "open": lower parts open to the sky get flat roofs / terraces
    const main = new Set();
    const open = new Set();
    for (const c of cells.get(f.id)) {
      if (above.some((u) => cells.get(u.id).has(c))) continue;
      if (caps.get(f.id).has(c)) continue;
      const j = Math.floor(c / 100000);
      const i = c - j * 100000;
      const x = (i - OFF + 0.5) * STEP;
      const y = (j - OFF + 0.5) * STEP;
      if (fixed.some((z) => x > z.x && x < z.x + z.w && y > z.y && y < z.y + z.h)) continue;
      const underAttic = attics.some((u) => cells.get(u.id).has(c));
      (higher.length === 0 || underAttic ? main : open).add(c);
    }
    const mine = house.roofs.filter((z) => z.on === f.id && !z.fixed);
    const pitchedLike = mine.find((m) => m.type !== 'flat') || house.roofs.find((m) => m.type !== 'flat');
    for (const [group, rects] of [['main', cover(main)], ['open', cover(open)]]) {
      // a lower part keeps whatever roof it had (a flat terrace or e.g. a pitched garage roof)
      const pool = group === 'main' ? mine.filter((m) => m.type !== 'flat' || !higher.length) : mine;
      for (const r of rects) {
        // keep the settings of the roof area that covered most of this part before
        const z = pool.filter((m) => !used.has(m)).sort((a, b) => overlap(b, r) - overlap(a, r))[0];
        if (z && (overlap(z, r) > 0 || pool.length === 1)) {
          used.add(z);
          Object.assign(z, r);
          result.push(z);
          continue;
        }
        // a new piece inherits from the roof area it was part of (e.g. stays a walkable terrace)
        const parent = pool.slice().sort((a, b) => overlap(b, r) - overlap(a, r)).find((m) => overlap(m, r) > 0);
        const like = parent || (group === 'main' ? pitchedLike : null);
        const settings = like
          ? { type: like.type, pitch: like.pitch, ridge: like.ridge, low: like.low, overhang: like.overhang, lowerPitch: like.lowerPitch, breakHeight: like.breakHeight, walkable: like.walkable, material: like.material, topMaterial: like.topMaterial }
          : { type: group === 'main' ? ROOF_DEFAULTS.type : 'flat', overhang: 0.1 };
        const nz = { id: newId(group === 'main' ? 'roof' : parent?.walkable ? 'terrace' : 'flat-roof'), name: parent?.name || (group === 'main' ? 'Roof' : 'Flat roof'), on: f.id, ...r, ...settings };
        for (const key of Object.keys(nz)) if (nz[key] === undefined) delete nz[key];
        result.push(nz);
      }
    }
    result.push(...fixed);
  });
  // roof areas on floors that no longer exist are dropped; order stays stable by id
  const order = (z) => {
    const i = house.roofs.indexOf(z);
    return i < 0 ? Infinity : i;
  };
  house.roofs = result.sort((a, b) => order(a) - order(b));
  return JSON.stringify(house.roofs) !== before;
}

// Height of an attic's knee wall: the short outer wall between the attic floor and the eaves.
export const kneeWall = (floor) => (floor?.underRoof ? Math.max(0, Number(floor.kneeWall) || 0) : 0);

// The roof over a point of an attic floor (a roof area whose eaves sit at the attic floor plus
// its knee wall), or null.
export function atticZoneAt(house, floor, x, y) {
  if (!floor?.underRoof) return null;
  const eave = (floor.elevation ?? 0) + kneeWall(floor);
  // where roof areas overlap (a cross gable over the main roof) the higher one is the ceiling
  const zs = roofZones(house).filter(({ geom: g }) => x > g.outer.x && x < g.outer.x + g.outer.w && y > g.outer.y && y < g.outer.y + g.outer.h && Math.abs(g.eave - eave) < 0.5);
  if (zs.length < 2) return zs[0]?.geom || null;
  return zs.map((z) => z.geom).sort((a, b) => (roofHeightAt(b, x, y) ?? 0) - (roofHeightAt(a, x, y) ?? 0))[0];
}

// The roof that covers an attic floor (at the middle of its rooms), or null.
export function atticRoof(house, floor) {
  if (!floor?.underRoof || !floor.rooms?.length) return null;
  const xs = floor.rooms.flatMap((r) => [r.x, r.x + r.w]);
  const ys = floor.rooms.flatMap((r) => [r.y, r.y + r.h]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return atticZoneAt(house, floor, cx, cy) || floor.rooms.map((r) => atticZoneAt(house, floor, r.x + r.w / 2, r.y + r.h / 2)).find(Boolean) || null;
}

// The roof over an exterior opening of an attic (decides gable-end window vs dormer).
export function atticRoofForOpening(house, floor, p) {
  const mid = (p.from + p.to) / 2;
  const [x, y] = p.horizontal ? [mid, p.y1] : [p.x1, mid];
  const inward = { N: [0, 0.3], S: [0, -0.3], W: [0.3, 0], E: [-0.3, 0] }[p.edge?.side] || [0, 0];
  return atticZoneAt(house, floor, x + inward[0], y + inward[1]) || atticRoof(house, floor);
}

// Facades that are gable ends (vertical triangular walls) of a gable roof: windows there are
// ordinary windows, not dormers.
export function isGableEnd(g, facade) {
  if (!g || g.type !== 'gable') return false;
  return g.cfg.ridge === 'y' ? facade === 'N' || facade === 'S' : facade === 'E' || facade === 'W';
}

// Cone roofs over round rooms that are open to the sky: a full cone over a round room, a
// half cone over the rounded side of a room. { floor, room, shape, eave, rise, pitch,
// overhang, material, half }
export function roundRoofs(house) {
  const floors = sortedFloors(house);
  const main = (house.roofs || []).find((z) => z.type !== 'flat') || house.roof;
  const out = [];
  floors.forEach((f, k) => {
    if (f.underRoof) return;
    const higher = floors.slice(k + 1).filter((u) => !u.underRoof);
    for (const r of f.rooms) {
      const sh = roundShape(r);
      if (!sh) continue;
      // a point well inside the rounded part: is anything built over it?
      const t = (sh.t0 + sh.t1) / 2;
      const p = sh.kind === 'all' ? [sh.cx, sh.cy] : [sh.cx + 0.5 * sh.ax * Math.cos(t), sh.cy + 0.5 * sh.by * Math.sin(t)];
      if (higher.some((u) => u.rooms.some((o) => inRoom(o, p[0], p[1])))) continue;
      // the straight part of a rounded room, if open too, gets a gable continuing the cone
      let straight = null;
      if (sh.kind === 'side') {
        const flat = { S: r.y, N: r.y + r.h, E: r.x, W: r.x + r.w }[sh.side];
        const along = sh.side === 'N' || sh.side === 'S' ? 'y' : 'x';
        const mid = (flat + (along === 'y' ? sh.cy : sh.cx)) / 2;
        const q = along === 'y' ? [sh.cx, mid] : [mid, sh.cy];
        if (Math.abs(flat - (along === 'y' ? sh.cy : sh.cx)) > 0.05 && !higher.some((u) => u.rooms.some((o) => inRoom(o, q[0], q[1])))) straight = { along, from: along === 'y' ? sh.cy : sh.cx, to: flat };
      }
      // a short straight part (a tower against the house): one full cone that runs back into
      // the main roof looks right; a long one gets a gable continuing the half cone
      let full = sh.kind === 'all';
      if (straight && Math.abs(straight.to - straight.from) <= Math.max(sh.ax, sh.by)) {
        full = true;
        straight = null;
      }
      const pitch = r.roofPitch ?? (sh.kind === 'all' ? 50 : 40);
      const overhang = r.roofOverhang ?? 0.3;
      const radius = Math.max(sh.ax, sh.by) + overhang;
      out.push({
        floor: f, room: r, shape: sh, half: !full, straight, pitch, overhang,
        eave: (f.elevation ?? 0) + (f.height ?? 2.8),
        rise: radius * Math.tan((pitch * Math.PI) / 180),
        material: r.roofMaterial || (main ? covering(main) : 'slate'),
      });
    }
  });
  return out;
}

// Sloped area of a cone roof (elliptic base approximated by the mean radius).
export function coneArea(c) {
  const r = (c.shape.ax + c.shape.by) / 2 + c.overhang;
  const area = Math.PI * r * Math.hypot(r, c.rise);
  const gable = c.straight ? Math.abs(c.straight.to - c.straight.from) * 2 * Math.hypot(r, c.rise) : 0;
  return (c.half ? area / 2 : area) + gable;
}
