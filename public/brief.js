// Handover brief for the architect, structural engineer, electrician and plumber: everything
// the planner knows about the house, as Markdown or HTML. No DOM.
import { totals, bbox, area, exteriorEdges, interiorEdges, placeDoor, placeOpening, livingRange, fmt } from './geometry.js';
import { floorWalls } from './walls.js';
import { structureIssues } from './structure.js';
import { analyzeStairs, allStairIssues, sortedFloors } from './stairs.js';
import { ROOF_TYPES, roofInfo, siteRoof, roofText, roofZones } from './roof.js';
import { ITEMS, itemInfo, footprint, roomAt } from './items.js';
import { POINT_KINDS, loadSummary } from './utilities.js';
import { ROOM_TYPES } from './catalog.js';
import { roomName, doorName, FACADES, OPENING_TYPES, isHinged } from './model.js';
import { estimate, moneyFor, displayFx, wallArea } from './costs.js';
import { facadeSettings, facadeQuantities } from './facade.js';

const a1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const kw = (w) => `${(w / 1000).toFixed(1)} kW`;
const cm = (m) => `${Math.round(m * 100)}`;

export function finishText(f) {
  if (!f || f.kind === 'none') return '—';
  if (f.kind === 'color') return `colour ${f.color}`;
  const pattern = { straight: 'straight', brick: 'brick bond', diagonal: 'diagonal 45°' }[f.pattern || 'straight'];
  const start = { NW: 'north-west corner', NE: 'north-east corner', SW: 'south-west corner', SE: 'south-east corner', center: 'centre' }[f.start || 'NW'];
  return `tiles ${cm(f.tileW || 0.6)} × ${cm(f.tileH || 0.6)} cm, ${pattern}, grout ${Math.round((f.groutWidth ?? 0.003) * 1000)} mm, start at ${start}${f.texture ? `, texture ${f.texture.replace('assets/', '')}` : ''}${f.height ? `, up to ${fmt(f.height)} m` : ''}`;
}

const tilesNeeded = (f, m2) => (f?.kind === 'tiles' ? Math.ceil((m2 / ((f.tileW || 0.6) * (f.tileH || 0.6))) * 1.1) : null);

export function buildBrief(house, { comments = [], briefText = '', date = new Date() } = {}) {
  const floors = sortedFloors(house);
  const t = totals(house);
  const sections = [];
  const S = (title, ...blocks) => sections.push({ title, blocks: blocks.filter(Boolean) });
  const P = (text) => ({ type: 'p', text });
  const L = (items) => (items.length ? { type: 'list', items } : null);
  const T = (head, rows) => (rows.length ? { type: 'table', head, rows } : null);

  const plot = house.site.find((s) => s.type === 'plot');
  const roof = roofInfo(house);
  const [lo, hi] = livingRange(house);
  S(
    'Summary',
    T(
      ['Item', 'Value'],
      [
        ...(house.description ? [['Description', house.description]] : []),
        ['Floors', floors.map((f) => `${f.name} (level ${fmt(f.elevation ?? 0)} m, floor-to-floor ${fmt(f.height ?? 2.8)} m)`).join('; ')],
        ['Living area', `${a1(t.net)} m² (target ${lo}–${hi} m²)`],
        ['Gross floor area', `${a1(t.gross)} m²`],
        ...floors.map((f) => {
          const b = bbox(f.rooms);
          return [`Footprint – ${f.name}`, `${fmt(b.w)} × ${fmt(b.h)} m (wall axes)`];
        }),
        ...(plot ? [['Plot', `${fmt(plot.w)} × ${fmt(plot.h)} m = ${Math.round(plot.w * plot.h)} m²`]] : []),
        ['Roof', `${house.roofs?.length ? `${house.roofs.length} roof areas` : ROOF_TYPES[house.roof?.type] || '—'}${roof.text ? `, ${roof.text}` : ''}`],
        ['Walls', `exterior ${fmt(house.wall?.exterior ?? 0.4)} m (${house.wall?.exteriorMaterial || 'not specified'}), interior ${fmt(house.wall?.interior ?? 0.15)} m, load-bearing interior ${fmt(house.wall?.loadBearing ?? 0.25)} m`],
      ],
    ),
  );
  if (briefText.trim()) S("Owner's requirements", { type: 'pre', text: briefText.trim() });
  if (house.assumptions?.length) S('Assumptions made in the plan', L(house.assumptions));

  // rooms & finishes
  for (const floor of floors) {
    S(
      `Rooms – ${floor.name}`,
      T(
        ['Room', 'Type', 'Size (m)', 'Area (m²)', 'Floor finish', 'Wall finish'],
        floor.rooms.map((r) => [r.name, ROOM_TYPES[r.type]?.label || r.type, `${fmt(r.w)} × ${fmt(r.h)}`, r.type === 'void' ? '(void)' : a1(area(r)), finishText(r.finish?.floor), finishText(r.finish?.walls)]),
      ),
    );
  }

  // openings
  const win = [];
  const doors = [];
  for (const floor of floors) {
    const edges = exteriorEdges(floor);
    for (const o of floor.openings || []) {
      const p = placeOpening(floor, o, edges);
      const mid = p ? (p.from + p.to) / 2 : 0;
      const inside = p ? roomAt(floor, p.horizontal ? mid : p.x1 + (o.facade === 'W' ? 0.3 : -0.3), p.horizontal ? p.y1 + (o.facade === 'N' ? 0.3 : -0.3) : mid) : null;
      const how = isHinged(o) ? `, opens ${o.swing === 'out' ? 'outwards' : 'inwards'}` : o.type === 'sliding-door' ? ', sliding' : '';
      win.push([o.id, floor.name, `${OPENING_TYPES[o.type] || 'Window'}${how}`, FACADES[o.facade], inside?.name || '—', `${fmt(o.width)} × ${fmt(o.height ?? 1.4)}`, fmt(o.sill ?? 0)]);
    }
    for (const d of floor.doors || []) doors.push([d.id, floor.name, doorName(floor, d), `${fmt(d.width ?? 0.9)} × ${fmt(d.height ?? 2.1)}`, d.type === 'door' ? `opens into ${roomName(floor, d.swing || d.between[1])}` : '']);
  }
  S('Windows and exterior doors', T(['Id', 'Floor', 'Kind', 'Facade', 'Room', 'W × H (m)', 'Sill (m)'], win));
  S('Interior doors and passages', T(['Id', 'Floor', 'Between', 'W × H (m)', 'Notes'], doors));

  // structure
  const walls = [];
  for (const floor of floors) {
    const { inner } = floorWalls(house, floor);
    for (const w of inner.filter((x) => x.props.loadBearing))
      walls.push([floor.name, w.desc.between.map((id) => roomName(floor, id)).join(' | '), fmt(w.to - w.from), fmt(w.props.thickness), w.props.material || '—']);
  }
  const sIssues = structureIssues(house);
  S(
    'Structure (for the structural engineer)',
    P('All exterior walls are treated as load-bearing unless marked otherwise. Interior load-bearing walls:'),
    T(['Floor', 'Wall between', 'Length (m)', 'Thickness (m)', 'Material'], walls) || P('None marked.'),
    sIssues.length ? P('Warnings from the planner (slab spans over ' + fmt(house.rules?.structure?.maxSlabSpan ?? 6) + ' m, unsupported walls):') : P('No span or support warnings from the planner.'),
    L(sIssues.map((i) => `${i.floor.name}: ${i.text}`)),
  );

  // facade
  {
    const f = facadeSettings(house);
    const q = facadeQuantities(house, { exteriorEdges, placeOpening, sortedFloors });
    const items = [
      `Walls ${f.render}, trim and stone details ${f.trim}${q.shutters ? `, shutters ${f.shutters}` : ''}.`,
      f.cornice ? `Cornice under the roof (≈ ${Math.round(q.cornice)} m).` : '',
      f.bands ? `Band between the floors (≈ ${Math.round(q.bands)} m).` : '',
      f.plinth ? `Stone base (≈ ${Math.round(q.plinth)} m).` : '',
      f.quoins ? 'Corner stones on the outside corners.' : '',
      f.rustication ? `Rusticated render (bosáž) on the ground floor (≈ ${Math.round(q.rusticationM2)} m²).` : '',
      q.shutters ? `${q.shutters} pairs of shutters.` : '',
      q.juliet ? `${q.juliet} Juliet balconies (wrought iron).` : '',
      q.balconies ? `${q.balconies} small cantilevered balcon${q.balconies > 1 ? 'ies' : 'y'} (${q.balconyM2.toFixed(1)} m²).` : '',
      q.surround ? `${q.surround} stone-look window surrounds with keystones.` : '',
    ].filter(Boolean);
    if (items.length > 1 || house.facade) S('Facade', L(items));
  }

  // stairs
  const stairs = [];
  for (const floor of floors)
    for (const r of floor.rooms.filter((x) => x.type === 'stairs')) {
      const s = analyzeStairs(house, floor, r);
      stairs.push([floor.name, r.shape === 'U' ? `${r.name} (U-shaped, ${r.winders === false ? 'half landing' : 'winders'})` : r.name, `${s.risers} × ${Math.round(s.riser * 1000)} mm`, `${Math.round(s.tread * 1000)} mm`, fmt(s.run), fmt(s.width), (s.issues.length ? s.issues.map((i) => i.text).join(' ') : 'OK') + (s.storage ? `; storage below ≈ ${s.storage.area.toFixed(1)} m²` : '')]);
    }
  S('Stairs', T(['Floor', 'Room', 'Risers', 'Tread', 'Run (m)', 'Width (m)', 'Check'], stairs));

  // roof
  if (house.roofs?.length)
    S(
      'Roof',
      T(
        ['Roof area', 'On', 'Shape', 'Details', 'Highest point'],
        roofZones(house).map(({ zone: z, floor, geom: g }) => [
          z.name || z.id,
          floor.name,
          `${ROOF_TYPES[g.type]}${g.type === 'flat' && z.walkable ? ', walkable terrace with balustrade' : ''}`,
          [
            g.type === 'mansard' ? `lower ${z.lowerPitch ?? 72}°, upper ${z.pitch ?? 20}°, break at ${fmt(z.breakHeight ?? 2.6)} m` : g.type !== 'flat' ? `${z.pitch ?? 35}°` : '',
            g.type === 'gable' || g.type === 'hip' ? `ridge ${z.ridge === 'y' ? 'north–south' : 'east–west'}` : '',
            z.chimneys?.length ? `${z.chimneys.length} chimney(s)` : '',
            `${fmt(z.w)} × ${fmt(z.h)} m`,
          ].filter(Boolean).join(', '),
          roofText(g).replace(/^.*highest point /, ''),
        ]),
      ),
      ...(house.floors.some((f) => f.underRoof)
        ? [P(`Attic floor(s) under the roof: ${house.floors.filter((f) => f.underRoof).map((f) => `${f.name} (${(f.openings || []).filter((o) => o.type === 'window').length} dormers)`).join(', ')}.`)]
        : []),
    );
  else if (house.roof)
    S(
      'Roof',
      T(
        ['Item', 'Value'],
        [
          ['Shape', ROOF_TYPES[house.roof.type] || house.roof.type],
          ...(house.roof.type !== 'flat' ? [['Pitch', `${house.roof.pitch ?? 35}°`]] : [['Parapet', `${fmt(house.roof.parapet ?? 0.3)} m`]]),
          ...(house.roof.type === 'gable' || house.roof.type === 'hip' ? [['Ridge', house.roof.ridge === 'y' ? 'north–south' : 'east–west']] : []),
          ...(house.roof.type === 'shed' ? [['Slopes down to', FACADES[house.roof.low || 'S']]] : []),
          ['Overhang', `${fmt(house.roof.overhang ?? 0.5)} m`],
          ['Eave level', roof.eave ? `${fmt(roof.eave)} m` : '—'],
          ['Highest point', roof.top ? `${a1(roof.top)} m above ground-floor level` : '—'],
          ...house.site
            .map((el) => [el, siteRoof(el)])
            .filter(([, g]) => g)
            .map(([el, g]) => [`${el.name} roof`, `${ROOF_TYPES[g.type]}${g.type === 'gable' || g.type === 'hip' ? `, ridge ${g.cfg.ridge === 'y' ? 'north–south' : 'east–west'}` : ''}, ${roofText(g)}`]),
        ],
      ),
    );

  // electrical
  const sum = loadSummary(house);
  const circuits = house.electrical?.circuits || [];
  const appliances = [];
  for (const floor of floors)
    for (const it of floor.items || []) {
      const n = ITEMS[it.type]?.needs;
      if (!n) continue;
      const f = footprint(it);
      const room = roomAt(floor, f.x + f.w / 2, f.y + f.h / 2);
      appliances.push([it.name || itemInfo(it).label, `${floor.name}${room ? `, ${room.name}` : ''}`, n.power ? `${n.power} W / ${n.voltage} V${n.dedicated ? ', own circuit' : ''}` : '', (n.water || []).join(' + '), n.drain ? `DN${n.drain}` : '', n.gas ? 'yes' : '', it.circuit || '']);
    }
  const perRoom = [];
  for (const floor of floors)
    for (const r of floor.rooms) {
      const pts = (floor.points || []).filter((p) => p.room === r.id);
      if (!pts.length) continue;
      const c = (k) => pts.filter((p) => k.includes(p.kind)).length || '';
      perRoom.push([`${r.name} (${floor.name.toLowerCase()})`, c(['socket', 'socket-counter', 'outlet']), c(['socket-400']), c(['light', 'light-wall']), c(['switch']), c(['data']), c(['water-cold']), c(['water-hot']), c(['drain']), c(['gas'])]);
    }
  S(
    'Electrical (proposal for the electrician)',
    circuits.length
      ? P(`Installed load ${kw(sum.installed)}; per phase L1 ${kw(sum.phase.L1)}, L2 ${kw(sum.phase.L2)}, L3 ${kw(sum.phase.L3)}. Rough peak ${kw(sum.demand)} per phase, suggesting a main breaker of about 3 × ${sum.breaker} A. These are planning estimates; the electrician sizes the supply and protection.`)
      : P('No utilities generated yet.'),
    T(['Circuit', 'Name', 'Breaker', 'RCD', 'Phase', 'Load'], circuits.map((c) => [c.id, c.name, c.breaker, c.rcd ? '30 mA' : '', c.phase || '', c.load ? kw(c.load) : ''])),
  );
  S('Points per room', T(['Room', 'Sockets', '400 V', 'Lights', 'Switches', 'Data', 'Cold', 'Hot', 'Drains', 'Gas'], perRoom));
  S('Appliances and fittings with connections', T(['Appliance', 'Where', 'Power', 'Water', 'Drain', 'Gas', 'Circuit'], appliances));

  // finishes and quantities
  const fin = [];
  for (const floor of floors)
    for (const r of floor.rooms) {
      if (r.type === 'void') continue;
      const zones = (r.zones || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const zoneArea = zones.reduce((s, z) => s + z.w * z.h, 0);
      if (r.finish?.floor) {
        const m2 = r.w * r.h - zoneArea;
        fin.push([`${r.name} (${floor.name.toLowerCase()})`, 'Floor', finishText(r.finish.floor), a1(m2), tilesNeeded(r.finish.floor, m2) ?? '']);
      }
      for (const z of zones) {
        const m2 = z.w * z.h;
        fin.push([`${r.name} – ${z.order ?? ''}. ${z.name || 'zone'}`, 'Floor zone', finishText(z.finish), a1(m2), tilesNeeded(z.finish, m2) ?? '']);
      }
      if (r.finish?.walls) {
        const h = Math.min(r.finish.walls.height ?? floor.height ?? 2.8, floor.height ?? 2.8);
        const m2 = wallArea(house, floor, r, h);
        fin.push([`${r.name} (${floor.name.toLowerCase()})`, 'Walls', finishText(r.finish.walls), a1(m2), tilesNeeded(r.finish.walls, m2) ?? '']);
      }
    }
  S('Finishes and quantities', T(['Where', 'Surface', 'Finish', 'Area (m²)', 'Tiles incl. 10 %'], fin) || P('No finishes chosen yet.'));

  // cost estimate
  const est = estimate(house);
  const mm = moneyFor(house);
  const fx = displayFx(house);
  const conv = fx.currency !== 'EUR' && fx.rate ? ` Converted from EUR at 1 EUR = ${fx.rate} ${fx.currency} (${fx.manual ? 'owner\'s rate' : `ECB, ${fx.date}`}).` : '';
  S(
    'Cost estimate (owner\'s planning figures)',
    P(`Estimated total ${mm(est.total)} (${mm(est.perLiving)} per m² of living area)${est.budget ? `; budget ${mm(est.budget)}, ${est.remaining >= 0 ? `${mm(est.remaining)} left` : `${mm(-est.remaining)} over`}` : ''}. Quantities from the plan × unit prices that are examples or the owner's own figures, not quotes.${conv}`),
    T(['Category', 'Total'], est.groups.filter((g) => g.total > 0).map((g) => [g.label, mm(g.total)])),
  );

  // open questions
  const open = comments.filter((c) => c.status === 'open');
  const layout = t.floors.flatMap((f) => [
    f.overlap > 0.001 ? `${f.name}: rooms overlap by ${a1(f.overlap)} m²` : null,
    f.gaps > 0.001 ? `${f.name}: ${a1(f.gaps)} m² of gaps between rooms` : null,
    f.stray ? `${f.name}: ${f.stray} door/window(s) not on a wall` : null,
  ]).filter(Boolean);
  S('Open points', L([...layout, ...allStairIssues(house).map((i) => `Stairs: ${i.text}`), ...open.map((c) => `Comment on ${c.target_name}: ${c.body.split('\n')[0]}`)]) || P('None.'));
  S(
    'To settle with the professionals',
    L([
      'Geological survey and foundation design (soil, groundwater, frost depth).',
      'Structural design: slabs, lintels over openings, roof structure, loads of the pool and terrace.',
      'Thermal envelope and energy class: insulation of walls, roof and floor slab; windows (U-values).',
      'Heating, hot water and ventilation (heat pump / gas, underfloor heating, heat recovery ventilation).',
      'Connections: electricity (requested supply), water, sewer or septic tank, gas, rainwater handling.',
      'Zoning rules for the plot: building lines, maximum height, roof shape and pitch, distances to neighbours.',
      'Fire safety, escape routes and chimney/flue if a stove or gas boiler is planned.',
    ]),
  );
  return { title: `${house.name || 'House'} – handover brief`, date, sections };
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DISCLAIMER =
  'Concept study made with OpenHomePlan. It is not a construction or permit document; all dimensions, structure and installations must be designed and verified by authorised professionals.';

export function briefMarkdown(brief) {
  const md = [`# ${brief.title}`, '', `_${brief.date.toISOString().slice(0, 10)} · ${DISCLAIMER}_`, ''];
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const s of brief.sections) {
    md.push(`## ${s.title}`, '');
    for (const b of s.blocks) {
      if (b.type === 'p') md.push(b.text, '');
      if (b.type === 'pre') md.push(b.text.replace(/^#/gm, '###'), '');
      if (b.type === 'list') md.push(...b.items.map((i) => `- ${i}`), '');
      if (b.type === 'table') md.push(`| ${b.head.map(cell).join(' | ')} |`, `|${b.head.map(() => '---').join('|')}|`, ...b.rows.map((r) => `| ${r.map(cell).join(' | ')} |`), '');
    }
  }
  return md.join('\n');
}

export function briefHtml(brief) {
  const out = [`<h1>${escHtml(brief.title)}</h1>`, `<p class="disclaimer">${escHtml(brief.date.toISOString().slice(0, 10))} · ${escHtml(DISCLAIMER)}</p>`];
  for (const s of brief.sections) {
    out.push(`<section><h2>${escHtml(s.title)}</h2>`);
    for (const b of s.blocks) {
      if (b.type === 'p') out.push(`<p>${escHtml(b.text)}</p>`);
      if (b.type === 'pre') out.push(`<pre>${escHtml(b.text)}</pre>`);
      if (b.type === 'list') out.push(`<ul>${b.items.map((i) => `<li>${escHtml(i)}</li>`).join('')}</ul>`);
      if (b.type === 'table')
        out.push(`<table><thead><tr>${b.head.map((h) => `<th>${escHtml(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    }
    out.push('</section>');
  }
  return out.join('\n');
}
