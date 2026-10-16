// Cost estimate from the model's own quantities × an editable price list.
// house.costs = { currency, budget, prices: { key: unit price }, exclude: [line keys],
//                 includeFurniture, designPct, contingencyPct, rates, rateOverride }
// Everything is stored and calculated in EUR. `currency` is only the display currency, converted
// with `rateOverride[currency]` (typed by the user) or else the downloaded `rates.values[currency]`
// (ECB reference rates: 1 EUR = rate × currency).
// The default prices are rough EXAMPLE values (EUR incl. VAT, central-European level) so the
// tool works out of the box. Replace them with real quotes for your region.
import { totals, exteriorEdges, interiorEdges, placeDoor, placeOpening, curvedWalls } from './geometry.js';
import { floorWalls } from './walls.js';
import { sortedFloors } from './stairs.js';
import { roofZones, roofArea, roofParts, openEdges, ROOF_COVERINGS, covering, atticRoof, atticRoofForOpening, kneeWall, isGableEnd, roundRoofs, coneArea, isTerraceOnPosts, terraceRailEdges, sitePosts } from './roof.js';
import { ITEMS, roomAt } from './items.js';
import { measure } from './shapes.js';
import { facadeQuantities } from './facade.js';

export const COST_GROUPS = {
  shell: 'Shell construction',
  openings: 'Windows & doors',
  finishes: 'Interior finishes',
  services: 'Utilities & heating',
  fittings: 'Kitchen, bathroom & appliances',
  furniture: 'Loose furniture',
  site: 'Site & outdoor',
  fees: 'Design, fees & contingency',
};

// key: [label, unit, price, group]
export const DEFAULT_PRICES = {
  foundations: ['Foundations & ground slab', 'm²', 140, 'shell'],
  'wall-exterior': ['Exterior walls incl. insulation & render', 'm²', 190, 'shell'],
  'wall-bearing': ['Interior load-bearing walls', 'm²', 95, 'shell'],
  'wall-partition': ['Partition walls', 'm²', 55, 'shell'],
  beam: ['Beams over openings (steel or reinforced concrete, incl. bearings)', 'm', 260, 'shell'],
  'wall-glass': ['Glass partitions', 'm²', 280, 'shell'],
  railing: ['Railings', 'm', 220, 'shell'],
  slab: ['Floor slabs between storeys', 'm²', 120, 'shell'],
  'roof-pitched': ['Pitched roof: structure & insulation', 'm² roof', 115, 'shell'],
  'roof-flat': ['Flat roof incl. insulation & waterproofing', 'm²', 200, 'shell'],
  stairs: ['Staircase (per flight)', 'pc', 5000, 'shell'],
  'roof-mansard': ['Mansard roof: structure & insulation', 'm² roof', 150, 'shell'],
  'roof-cone': ['Cone roofs (towers, bays): structure & insulation', 'm² roof', 190, 'shell'],
  'roof-terrace': ['Roof terrace (waterproofing, insulation, paving)', 'm²', 260, 'shell'],
  balustrade: ['Balustrades / railings on roof terraces', 'm', 420, 'shell'],
  dormer: ['Dormers', 'pc', 3200, 'shell'],
  chimney: ['Chimneys', 'pc', 2400, 'shell'],
  rustication: ['Rusticated render on the ground floor (bosáž)', 'm²', 28, 'shell'],
  shutters: ['Shutters (pair, timber or aluminium)', 'pair', 650, 'openings'],
  juliet: ['Juliet balconies (wrought iron)', 'pc', 900, 'openings'],
  balcony: ['Small cantilevered balconies (slab with thermal break, waterproofing, iron railing)', 'm²', 1300, 'openings'],
  surround: ['Window surrounds (stone look, keystone)', 'pc', 280, 'openings'],
  cornice: ['Cornice under the roof', 'm', 95, 'shell'],
  bands: ['Bands between floors', 'm', 45, 'shell'],
  plinth: ['Stone base', 'm', 70, 'shell'],
  quoins: ['Corner stones', 'm', 140, 'shell'],
  window: ['Windows (triple glazed)', 'm²', 480, 'openings'],
  'window-large': ['Large / sliding glazing', 'm²', 700, 'openings'],
  'window-double': ['Windows (double glazed)', 'm²', 360, 'openings'],
  'window-large-double': ['Large glazing (double glazed)', 'm²', 560, 'openings'],
  'door-entrance': ['Entrance door', 'pc', 2800, 'openings'],
  'door-exterior': ['Other exterior doors', 'pc', 1300, 'openings'],
  'door-terrace': ['Glazed terrace doors', 'pc', 1900, 'openings'],
  'door-sliding-ext': ['Sliding terrace doors (lift-and-slide)', 'm²', 850, 'openings'],
  'door-interior': ['Interior doors', 'pc', 380, 'openings'],
  'door-sliding': ['Sliding interior doors', 'pc', 700, 'openings'],
  'door-passage': ['Open passages (lining)', 'pc', 90, 'openings'],
  screed: ['Floor build-up (insulation & screed)', 'm²', 45, 'finishes'],
  'floor-standard': ['Floor covering, not chosen yet (laminate level)', 'm²', 45, 'finishes'],
  'floor-color': ['Floor covering, single colour (vinyl/wood level)', 'm²', 60, 'finishes'],
  'floor-tiles': ['Floor tiles incl. laying', 'm²', 75, 'finishes'],
  'wall-paint': ['Interior plaster & paint', 'm²', 28, 'finishes'],
  'wall-tiles': ['Wall tiles incl. laying', 'm²', 80, 'finishes'],
  'el-point': ['Electrical points (socket, switch, light, data)', 'pc', 80, 'services'],
  'el-400': ['400 V / appliance connections', 'pc', 160, 'services'],
  'el-board': ['Distribution board', 'pc', 1600, 'services'],
  'el-circuit': ['Circuits (cabling & protection)', 'pc', 140, 'services'],
  'water-point': ['Water & drain points', 'pc', 190, 'services'],
  'gas-point': ['Gas points', 'pc', 260, 'services'],
  meters: ['Meters & main valves', 'pc', 600, 'services'],
  heating: ['Heating (heat pump + underfloor)', 'm² living', 100, 'services'],
  ventilation: ['Ventilation with heat recovery', 'm² living', 55, 'services'],
  connections: ['Connections to the grid, water and sewer', 'lump sum', 9000, 'services'],
  'site-garage': ['Garage', 'm²', 650, 'site'],
  'site-terrace': ['Terrace', 'm²', 160, 'site'],
  'site-pool': ['Swimming pool', 'm² water', 1300, 'site'],
  'site-greenhouse': ['Greenhouse', 'm²', 420, 'site'],
  'site-driveway': ['Driveway', 'm²', 65, 'site'],
  'site-path': ['Paths', 'm²', 55, 'site'],
  'site-shed': ['Garden shed', 'm²', 420, 'site'],
  'site-garden': ['Garden beds', 'm²', 20, 'site'],
  'site-carport': ['Carport', 'm²', 380, 'site'],
  'site-terrace-on-posts': ['Roof terrace on pillars (RC slab and pillars, waterproofing, paving)', 'm²', 720, 'site'],
  'pillar-column': ['Round columns with base and capital (cast stone)', 'pc', 650, 'site'],
  'pillar-arcade': ['Arcade: rendered piers with stone arches and mouldings', 'pc', 1800, 'site'],
  balustrade: ['Stone balustrade (cast stone)', 'm', 480, 'site'],
  'site-pergola': ['Pergola / terrace cover', 'm²', 240, 'site'],
  'site-tree': ['Trees (planted, ~3 m tall)', 'pc', 180, 'site'],
  'site-conifer': ['Conifers', 'pc', 120, 'site'],
  'site-bush': ['Bushes', 'pc', 35, 'site'],
  'site-hedge': ['Hedges', 'm', 45, 'site'],
  fence: ['Fence around the plot', 'm', 65, 'site'],
  'allow-electrical': ['Electrical installation allowance (utilities not generated yet)', 'm² living', 60, 'services'],
  'allow-plumbing': ['Plumbing & drainage allowance (utilities not generated yet)', 'm² living', 40, 'services'],
  'allow-kitchen': ['Kitchen allowance (no kitchen items placed yet)', 'pc', 12000, 'fittings'],
  'allow-bathroom': ['Bathroom fittings allowance (per bathroom without fittings)', 'pc', 5500, 'fittings'],
};
// one price line per roof covering (see ROOF_COVERINGS in roof.js)
for (const [k, c] of Object.entries(ROOF_COVERINGS)) DEFAULT_PRICES[`roof-cover:${k}`] = [`Roof covering: ${c.label.toLowerCase()}`, 'm² roof', c.price, 'shell'];

// Fittings and appliances that are part of the build (fixed); the rest is loose furniture.
export const ITEM_PRICES = {
  'kitchen-base': 800, 'kitchen-wall': 450, 'kitchen-tall': 900, 'kitchen-island': 2600, 'sink-kitchen': 500, hob: 750, oven: 650, fridge: 950, dishwasher: 650,
  'sofa-3': 1300, 'sofa-corner': 2200, armchair: 450, 'coffee-table': 220, 'tv-unit': 450, 'dining-6': 1300, 'dining-4': 950, bookshelf: 280,
  'bed-double': 1000, 'bed-queen': 900, 'bed-single': 380, nightstand: 130, wardrobe: 1300, dresser: 420, desk: 380,
  bathtub: 950, shower: 950, 'shower-walkin': 1400, wc: 480, washbasin: 380, 'vanity-double': 800, 'towel-rail': 280,
  'sofa-u': 3200, shelving: 350, 'storage-unit': 650, projector: 900, 'projector-screen': 450, 'closet-shelving': 480,
  'heat-pump-outdoor': 0, 'ufh-manifold': 0, 'hrv-unit': 0,
  washer: 650, dryer: 750, 'boiler-gas': 2600, 'heat-pump': 0, 'water-heater': 1300, 'utility-sink': 320, car: 0, 'ev-charger': 1300,
};
const FIXED = new Set(['kitchen', 'bathroom', 'utility']);
// priced per metre of run (by the item's width), so a run split into pieces costs the same
const PER_METRE = new Set(['kitchen-base', 'kitchen-wall']);
const isFixed = (type) => FIXED.has(ITEMS[type]?.cat) || ITEMS[type]?.builtIn || ['ev-charger'].includes(type);

export const costSettings = (house) => ({
  currency: 'EUR',
  budget: 0,
  prices: {},
  exclude: [],
  includeFurniture: false,
  glazing: 'triple', // 'double' prices the windows as double glazed
  designPct: 6,
  contingencyPct: 10,
  ...(house.costs || {}),
});

export function priceOf(house, key) {
  const s = costSettings(house);
  if (key in s.prices) return s.prices[key];
  if (key.startsWith('item:')) return ITEM_PRICES[key.slice(5)] ?? 0;
  return DEFAULT_PRICES[key]?.[2] ?? 0;
}

// Wall area of a room up to `height`, minus doors and windows (approximate).
export function wallArea(house, floor, room, height) {
  let m2 = 2 * (room.w + room.h) * height;
  const inner = interiorEdges(floor);
  for (const d of floor.doors || []) {
    if (!d.between.includes(room.id) || d.type === 'opening') continue;
    const p = placeDoor(floor, d, inner);
    if (p) m2 -= (p.to - p.from) * Math.min(d.height ?? 2.1, height);
  }
  const edges = exteriorEdges(floor);
  for (const o of floor.openings || []) {
    const p = placeOpening(floor, o, edges);
    if (!p) continue;
    const mid = (p.from + p.to) / 2;
    if (roomAt(floor, p.horizontal ? mid : p.x1 + (o.facade === 'W' ? 0.3 : -0.3), p.horizontal ? p.y1 + (o.facade === 'N' ? 0.3 : -0.3) : mid) !== room) continue;
    const overlap = Math.max(0, Math.min(height, (o.sill ?? 0) + (o.height ?? 1.4)) - (o.sill ?? 0));
    m2 -= (p.to - p.from) * overlap;
  }
  return Math.max(0, m2);
}

const fixQty = (v) => Math.round(v * 10) / 10;

export function estimate(house) {
  const s = costSettings(house);
  const excluded = new Set(s.exclude);
  const lines = [];
  const add = (key, qty, extra = {}) => {
    if (!qty) return;
    const def = DEFAULT_PRICES[key];
    const price = priceOf(house, extra.priceKey || key);
    const id = extra.id || key;
    const line = {
      id,
      key: extra.priceKey || key,
      label: extra.label || def?.[0] || key,
      unit: extra.unit || def?.[1] || 'pc',
      group: extra.group || def?.[3] || 'shell',
      qty: fixQty(qty),
      price,
      included: !excluded.has(id),
    };
    line.total = line.included ? line.qty * line.price : 0;
    const same = lines.find((l) => l.id === id);
    if (same) {
      same.qty = fixQty(same.qty + line.qty);
      same.total = same.included ? same.qty * same.price : 0;
    } else lines.push(line);
  };

  const floors = sortedFloors(house);
  const t = totals(house);
  const byFloor = new Map(t.floors.map((f) => [f.id, f]));
  const voidArea = (f) => f.rooms.filter((r) => r.type === 'void').reduce((a, r) => a + r.w * r.h, 0);
  const lowest = floors[0];

  // ---- shell
  if (lowest) add('foundations', byFloor.get(lowest.id)?.gross || 0);
  floors.slice(1).forEach((f) => add('slab', (byFloor.get(f.id)?.gross || 0) - voidArea(f)));
  for (const floor of floors) {
    const H = floor.height ?? 2.8;
    const edges = exteriorEdges(floor);
    let ext = edges.reduce((a, e) => a + e.length * H, 0);
    // curved walls of round rooms: outside walls where they face out, partitions otherwise
    for (const cw of curvedWalls(floor)) {
      if (cw.exterior) ext += cw.length * H;
      else add('wall-partition', cw.length * H);
    }
    for (const o of floor.openings || []) if (placeOpening(floor, o, edges)) ext -= o.width * Math.min(o.height ?? 1.4, H);
    // an attic's outer walls are the roof slopes (priced with the roof), apart from a knee wall
    if (!floor.underRoof) add('wall-exterior', ext);
    else if (kneeWall(floor)) add('wall-exterior', edges.reduce((a, e) => a + e.length, 0) * kneeWall(floor));
    const inner = interiorEdges(floor);
    const doorArea = new Map();
    for (const d of floor.doors || []) {
      const p = placeDoor(floor, d, inner);
      if (!p) continue;
      const key = [...d.between].sort().join('|');
      doorArea.set(key, (doorArea.get(key) || 0) + (p.to - p.from) * Math.min(d.height ?? 2.1, H));
    }
    for (const w of floorWalls(house, floor).inner) {
      const len = w.to - w.from;
      const { type, loadBearing, beam } = w.props;
      if (beam) add('beam', len);
      if (type === 'none') continue;
      if (type === 'railing') add('railing', len);
      else {
        const m2 = Math.max(0, len * H - (doorArea.get(w.desc.between.join('|')) || 0));
        add(type === 'glass' ? 'wall-glass' : loadBearing ? 'wall-bearing' : 'wall-partition', m2);
      }
    }
    add('stairs', floor.rooms.filter((r) => r.type === 'stairs').length);
  }
  for (const { zone, geom: g } of roofZones(house)) {
    if (g.type === 'flat' && g.cfg.walkable) {
      // roof terrace: waterproofing + paving, and a balustrade on its open sides
      add('roof-terrace', g.outer.w * g.outer.h);
      add('balustrade', openEdges(house, g).reduce((s, [x1, y1, x2, y2]) => s + Math.hypot(x2 - x1, y2 - y1), 0));
    } else if (g.type === 'flat') add('roof-flat', roofArea(g));
    else {
      add(g.type === 'mansard' ? 'roof-mansard' : 'roof-pitched', roofArea(g));
      const parts = roofParts(g);
      add(`roof-cover:${covering(g.cfg)}`, parts.main);
      add(`roof-cover:${covering(g.cfg, 'top')}`, parts.top);
    }
    add('chimney', (zone?.chimneys || []).length);
  }
  // cone roofs over round rooms (towers, bays)
  for (const c of roundRoofs(house)) {
    add('roof-cone', coneArea(c));
    add(`roof-cover:${c.material}`, coneArea(c));
  }
  const fq = facadeQuantities(house, { exteriorEdges, placeOpening, sortedFloors });
  add('shutters', fq.shutters);
  add('juliet', fq.juliet);
  add('balcony', fq.balconyM2);
  add('surround', fq.surround);
  add('cornice', fq.cornice);
  add('bands', fq.bands);
  add('plinth', fq.plinth);
  add('quoins', fq.quoinsM);
  add('rustication', fq.rusticationM2);
  // attic windows are dormers, except those in the gable end walls
  add('dormer', floors.filter((f) => f.underRoof).reduce((s, f) => {
    const edges = exteriorEdges(f);
    return s + (f.openings || []).filter((o) => {
      if (o.type !== 'window') return false;
      const p = placeOpening(f, o, edges);
      return !isGableEnd(p ? atticRoofForOpening(house, f, p) : atticRoof(house, f), o.facade);
    }).length;
  }, 0));

  // ---- openings
  const dbl = s.glazing === 'double' ? '-double' : '';
  for (const floor of floors) {
    for (const o of floor.openings || []) {
      if (o.type === 'door') add(o.id === 'entrance' || /entr/i.test(o.id) ? 'door-entrance' : 'door-exterior', 1);
      else if (o.type === 'terrace-door') add('door-terrace', 1);
      else if (o.type === 'sliding-door') add('door-sliding-ext', o.width * (o.height ?? 2.2));
      else add(((o.sill ?? 1) <= 0.05 ? 'window-large' : 'window') + dbl, o.width * (o.height ?? 1.4));
    }
    for (const d of floor.doors || []) {
      const voidSide = d.between.some((id) => floor.rooms.find((r) => r.id === id)?.type === 'void');
      if (voidSide) continue; // gap in a railing
      add(d.type === 'sliding' ? 'door-sliding' : d.type === 'opening' ? 'door-passage' : 'door-interior', 1);
    }
  }
  // the first exterior door counts as the entrance if none is named so
  if (!lines.some((l) => l.id === 'door-entrance')) {
    const ext = lines.find((l) => l.id === 'door-exterior');
    if (ext) {
      ext.qty -= 1;
      ext.total = ext.included ? ext.qty * ext.price : 0;
      if (ext.qty <= 0) lines.splice(lines.indexOf(ext), 1);
      add('door-entrance', 1);
    }
  }

  // ---- finishes
  for (const floor of floors) {
    const H = floor.height ?? 2.8;
    for (const r of floor.rooms) {
      if (r.type === 'void' || r.type === 'stairs') continue;
      const m2 = r.w * r.h;
      add('screed', m2);
      const zones = r.zones || [];
      const zoneArea = zones.reduce((a, z) => a + z.w * z.h, 0);
      const kindKey = (f) => (f?.kind === 'tiles' ? 'floor-tiles' : f?.kind === 'color' ? 'floor-color' : 'floor-standard');
      add(kindKey(r.finish?.floor), m2 - zoneArea);
      for (const z of zones) add(kindKey(z.finish), z.w * z.h);
      const clear = H - 0.3;
      const walls = wallArea(house, floor, r, clear);
      const tiledH = r.finish?.walls ? Math.min(r.finish.walls.height ?? clear, clear) : 0;
      const tiled = r.finish?.walls ? wallArea(house, floor, r, tiledH) : 0;
      if (r.finish?.walls?.kind === 'tiles') {
        add('wall-tiles', tiled);
        add('wall-paint', walls - tiled);
      } else add('wall-paint', walls);
    }
  }

  // ---- services
  const count = (kinds) => floors.reduce((a, f) => a + (f.points || []).filter((p) => kinds.includes(p.kind)).length, 0);
  add('el-point', count(['socket', 'socket-counter', 'switch', 'light', 'light-wall', 'data']));
  add('el-400', count(['socket-400', 'outlet']));
  add('el-board', count(['board']));
  add('el-circuit', (house.electrical?.circuits || []).length);
  add('water-point', count(['water-cold', 'water-hot', 'drain']));
  add('gas-point', count(['gas']));
  add('meters', count(['meter-water', 'meter-gas']));
  if (!floors.some((f) => (f.points || []).length)) {
    add('allow-electrical', t.net);
    add('allow-plumbing', t.net);
  }
  add('heating', t.net);
  add('ventilation', t.net);
  add('connections', 1);

  // ---- fittings, appliances, furniture
  for (const floor of floors)
    for (const it of floor.items || []) {
      const fixed = isFixed(it.type);
      const id = `item:${it.type}`;
      const perM = PER_METRE.has(it.type);
      add(id, perM ? it.w : 1, {
        id: fixed ? id : `furniture:${it.type}`,
        priceKey: id,
        label: perM ? `${ITEMS[it.type].label}s` : ITEMS[it.type]?.label || it.type,
        unit: perM ? 'm' : 'pc',
        group: fixed ? 'fittings' : 'furniture',
      });
    }
  // allowances until the kitchen and bathrooms are furnished in the plan
  const allItems = floors.flatMap((f) => (f.items || []).map((it) => ({ f, it })));
  if (!allItems.some(({ it }) => ITEMS[it.type]?.cat === 'kitchen')) add('allow-kitchen', 1);
  for (const f of floors)
    for (const r of f.rooms.filter((x) => x.type === 'bathroom' || x.type === 'wc')) {
      const fitted = (f.items || []).some((it) => ITEMS[it.type]?.cat === 'bathroom' && roomAt(f, it.x + 0.1, it.y + 0.1) === r);
      if (!fitted) add('allow-bathroom', 1);
    }
  if (!s.includeFurniture) for (const l of lines) if (l.group === 'furniture') (l.included = false), (l.total = 0);

  // ---- site
  for (const el of house.site) {
    const m = measure(el);
    const unit = DEFAULT_PRICES[`site-${el.type}`]?.[1];
    // plants are counted per piece, hedges per metre, everything else per m²
    const qty = el.type === 'plot' ? m.perimeter : unit === 'pc' ? 1 : unit === 'm' ? Math.max(el.w, el.h) : m.area;
    if (el.type === 'plot') add('fence', qty);
    else if (isTerraceOnPosts(el)) {
      add('site-terrace-on-posts', m.area, { id: `site:${el.id}`, label: el.name, priceKey: 'site-terrace-on-posts' });
      add(el.railing === 'balustrade' ? 'balustrade' : 'railing', terraceRailEdges(el).reduce((a, [x1, y1, x2, y2]) => a + Math.hypot(x2 - x1, y2 - y1), 0));
      if (el.postStyle === 'column' || el.postStyle === 'arcade') add(`pillar-${el.postStyle}`, sitePosts(el).length);
    } else if (DEFAULT_PRICES[`site-${el.type}`])
      add(`site-${el.type}`, qty, ['tree', 'conifer', 'bush', 'hedge'].includes(el.type) ? {} : { id: `site:${el.id}`, label: el.name, priceKey: `site-${el.type}` });
  }

  // ---- fees
  const build = lines.filter((l) => l.group !== 'furniture').reduce((a, l) => a + l.total, 0);
  const pct = (id, label, p) => {
    const included = !excluded.has(id);
    lines.push({ id, key: id, label: `${label} (${p} % of construction)`, unit: '%', group: 'fees', qty: p, price: build / 100, included, total: included ? (build * p) / 100 : 0, percent: true });
  };
  pct('fees:design', 'Design, permits & site supervision', s.designPct);
  pct('fees:contingency', 'Contingency', s.contingencyPct);

  const total = lines.reduce((a, l) => a + l.total, 0);
  const groups = Object.keys(COST_GROUPS).map((g) => ({ id: g, label: COST_GROUPS[g], total: lines.filter((l) => l.group === g).reduce((a, l) => a + l.total, 0) }));

  // what one more m² of living area costs here: building cost (without site, furniture and
  // lump sums) per m², plus the percentage fees
  const perM2Groups = ['shell', 'openings', 'finishes', 'services'];
  const perM2Base = lines.filter((l) => perM2Groups.includes(l.group) && l.id !== 'connections').reduce((a, l) => a + l.total, 0);
  const perM2 = t.net ? (perM2Base / t.net) * (1 + (s.designPct + s.contingencyPct) / 100) : 0;
  const budget = Number(s.budget) || 0;
  const remaining = budget ? budget - total : null;
  return {
    currency: s.currency,
    lines,
    groups,
    total,
    living: t.net,
    perLiving: t.net ? total / t.net : 0,
    perM2,
    budget,
    remaining,
    headroomM2: budget && perM2 ? remaining / perM2 : null,
  };
}

export const BASE_CURRENCY = 'EUR';

// The display currency and its rate. rate is null when a non-EUR currency has no rate yet.
export function displayFx(house) {
  const s = costSettings(house);
  const currency = s.currency || BASE_CURRENCY;
  if (currency === BASE_CURRENCY) return { currency, rate: 1, manual: false };
  const downloaded = s.rates?.values?.[currency] ?? null;
  const override = s.rateOverride?.[currency];
  const manual = typeof override === 'number' && override > 0;
  return { currency, rate: manual ? override : downloaded, manual, downloaded, date: s.rates?.date || null, source: s.rates?.source || null };
}

// Formatter for EUR amounts in the house's display currency (falls back to EUR without a rate).
export function moneyFor(house) {
  const fx = displayFx(house);
  return fx.rate ? (eur) => money(eur * fx.rate, fx.currency) : (eur) => money(eur, BASE_CURRENCY);
}

export function money(v, currency = 'EUR') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${Math.round(v).toLocaleString()} ${currency}`;
  }
}
