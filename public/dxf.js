// DXF (R12, ASCII, metres) export of all floors side by side, on CAD layers the
// architect can switch on and off. Plan y points south, DXF y points north, so y is negated.
import { bbox, exteriorEdges, interiorEdges, placeDoor, placeOpening, solidPieces, area, fmt, curvedWalls, arcSegments } from './geometry.js';
import { floorWalls } from './walls.js';
import { analyzeStairs, sortedFloors, stairSteps } from './stairs.js';
import { itemInfo, itemPoint } from './items.js';
import { POINT_KINDS } from './utilities.js';
import { isHinged } from './model.js';
import { isShaped, SHAPED, smooth, ribbon } from './shapes.js';
import { roofZones } from './roof.js';

const LAYERS = {
  'A-WALL-EXT': 7, // white/black
  'A-WALL-LOAD': 1, // red
  'A-WALL': 8, // grey
  'A-RAIL': 9,
  'A-GLAZ': 5, // blue
  'A-DOOR': 3, // green
  'A-STAIR': 30,
  'A-AREA': 7,
  'A-FURN': 252,
  'A-DIMS': 2, // yellow
  'E-POWER': 30,
  'E-LIGHT': 40,
  'E-SWITCH': 40,
  'E-BOARD': 6,
  'P-WATER-COLD': 5,
  'P-WATER-HOT': 1,
  'P-DRAIN': 34,
  'G-GAS': 50,
  'S-SITE': 82,
  'A-TITLE': 7,
  'A-ROOF': 34,
};

const POINT_LAYER = {
  socket: 'E-POWER', 'socket-counter': 'E-POWER', 'socket-400': 'E-POWER', outlet: 'E-POWER', data: 'E-POWER',
  light: 'E-LIGHT', 'light-wall': 'E-LIGHT', switch: 'E-SWITCH', board: 'E-BOARD',
  'water-cold': 'P-WATER-COLD', 'meter-water': 'P-WATER-COLD', 'water-hot': 'P-WATER-HOT', drain: 'P-DRAIN', gas: 'G-GAS', 'meter-gas': 'G-GAS',
};
const POINT_TEXT = { socket: 'S', 'socket-counter': 'K', 'socket-400': '3~', outlet: 'A', data: 'D', 'light-wall': 'W', board: 'RB', 'water-cold': 'C', 'water-hot': 'H', drain: 'DR', gas: 'G', 'meter-water': 'WM', 'meter-gas': 'GM', switch: '' };

const num = (v) => (Math.round(v * 10000) / 10000).toString();

export function houseToDxf(house) {
  const out = [];
  const g = (code, value) => out.push(String(code), String(value));
  let dx = 0;
  const X = (x) => num(x + dx);
  const Y = (y) => num(-y);
  const line = (layer, x1, y1, x2, y2) => {
    g(0, 'LINE'); g(8, layer); g(10, X(x1)); g(20, Y(y1)); g(30, 0); g(11, X(x2)); g(21, Y(y2)); g(31, 0);
  };
  const rect = (layer, x, y, w, h) => {
    line(layer, x, y, x + w, y); line(layer, x + w, y, x + w, y + h); line(layer, x + w, y + h, x, y + h); line(layer, x, y + h, x, y);
  };
  const circle = (layer, x, y, r) => {
    g(0, 'CIRCLE'); g(8, layer); g(10, X(x)); g(20, Y(y)); g(30, 0); g(40, num(r));
  };
  const text = (layer, x, y, h, s, align = 'center') => {
    // R12 files are ANSI; anything else is written as a \U+XXXX escape that CAD programs understand
    const str = String(s)
      .replace(/[\r\n]+/g, ' ')
      .replace(/[^\x20-\x7e]/g, (c) => `\\U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    g(0, 'TEXT'); g(8, layer); g(10, X(x)); g(20, Y(y)); g(30, 0); g(40, num(h)); g(1, str);
    if (align === 'center') {
      g(72, 1); g(73, 2); g(11, X(x)); g(21, Y(y)); g(31, 0);
    }
  };
  // quarter-circle door swing: hinge, unit vectors u (open leaf) and v (towards other jamb), radius
  const swing = (layer, hx, hy, u, v, w) => {
    line(layer, hx, hy, hx + u[0] * w, hy + u[1] * w);
    const angle = (vx, vy) => ((Math.atan2(-vy, vx) * 180) / Math.PI + 360) % 360; // DXF coords (y flipped)
    const a1 = angle(u[0], u[1]);
    const a2 = angle(v[0], v[1]);
    const [s, e] = (a2 - a1 + 360) % 360 === 90 ? [a1, a2] : [a2, a1];
    g(0, 'ARC'); g(8, layer); g(10, X(hx)); g(20, Y(hy)); g(30, 0); g(40, num(w)); g(50, num(s)); g(51, num(e));
  };
  // a wall segment (axis from..to at coord) drawn as an outline of the given thickness
  const wallRect = (layer, horizontal, coord, from, to, t) =>
    horizontal ? rect(layer, from, coord - t / 2, to - from, t) : rect(layer, coord - t / 2, from, t, to - from);

  const floors = sortedFloors(house);
  const ext = house.wall?.exterior ?? 0.4;
  const ground = floors.find((f) => (f.elevation ?? 0) >= -0.5) || floors[0];

  let cursor = 0;
  for (const floor of floors) {
    if (!floor.rooms.length) continue;
    const b = bbox(floor.rooms);
    // floors side by side, 8 m apart (the ground floor includes the site)
    const extent = floor === ground ? bbox([...floor.rooms, ...house.site]) : { x: b.x - 2, w: b.w + 4 };
    dx = cursor - extent.x;
    const edges = exteriorEdges(floor);
    const inner = interiorEdges(floor);
    const { inner: innerWalls } = floorWalls(house, floor);
    const openings = (floor.openings || []).map((o) => ({ o, p: placeOpening(floor, o, edges) })).filter((x) => x.p);
    const doors = (floor.doors || []).map((d) => ({ d, p: placeDoor(floor, d, inner) })).filter((x) => x.p);

    text('A-TITLE', b.x + b.w / 2, b.y - 3.2, 0.5, `${house.name || 'House'} - ${floor.name}`);

    // site plan on the ground floor
    if (floor === ground)
      for (const s of house.site) {
        if (isShaped(s) && SHAPED[s.type] === 'polygon') s.points.forEach((a, i) => line('S-SITE', ...a, ...s.points[(i + 1) % s.points.length]));
        else if (isShaped(s)) {
          // curved road: both edges as polylines
          const { left, right } = ribbon(smooth(s.points), s.width ?? 3);
          for (const side of [left, right]) for (let i = 0; i < side.length - 1; i++) line('S-SITE', ...side[i], ...side[i + 1]);
        } else if (['tree', 'conifer', 'bush'].includes(s.type)) circle('S-SITE', s.x + s.w / 2, s.y + s.h / 2, Math.min(s.w, s.h) / 2);
        else rect('S-SITE', s.x, s.y, s.w, s.h);
        if (!['tree', 'conifer', 'bush', 'hedge'].includes(s.type)) text('S-SITE', s.x + s.w / 2, s.y + s.h / 2, s.type === 'plot' ? 0.4 : 0.25, s.name);
      }

    // exterior walls, split around openings
    for (const seg of edges) {
      const along = seg.horizontal ? [seg.x1, seg.x2] : [seg.y1, seg.y2];
      const coord = seg.horizontal ? seg.y1 : seg.x1;
      const spans = openings.filter(({ p }) => p.edge === seg).map(({ p }) => [p.from, p.to]);
      for (const [a, c] of solidPieces(along[0] - ext / 2, along[1] + ext / 2, spans)) wallRect('A-WALL-EXT', seg.horizontal, coord, a, c, ext);
    }
    // curved walls of round rooms: both faces as polylines along the arc
    for (const cw of curvedWalls(floor)) {
      const T = cw.exterior ? ext : house.wall?.interior ?? 0.15;
      const sh = cw.shape;
      for (const side of [-1, 1]) {
        const off = { ...sh, ax: sh.ax + (side * T) / 2, by: sh.by + (side * T) / 2 };
        for (const g of arcSegments(off, 0.2)) line(cw.exterior ? 'A-WALL-EXT' : 'A-WALL', g.p0[0], g.p0[1], g.p1[0], g.p1[1]);
      }
    }
    for (const { o, p } of openings) {
      if (p.curved) continue;
      const coord = p.horizontal ? p.y1 : p.x1;
      const inward = { N: [0, 1], S: [0, -1], W: [1, 0], E: [-1, 0] }[o.facade];
      if (isHinged(o)) {
        const dir = o.swing === 'out' ? [-inward[0], -inward[1]] : inward;
        const atEnd = o.hinge === 'end';
        const [bx, by] = p.horizontal ? [atEnd ? p.to : p.from, p.y1] : [p.x1, atEnd ? p.to : p.from];
        swing('A-DOOR', bx + (dir[0] * ext) / 2, by + (dir[1] * ext) / 2, dir, p.horizontal ? [atEnd ? -1 : 1, 0] : [0, atEnd ? -1 : 1], p.to - p.from);
      } else if (o.type === 'sliding-door') {
        const mid = (p.from + p.to) / 2;
        if (p.horizontal) {
          line('A-GLAZ', p.from, coord - 0.05, mid + 0.05, coord - 0.05);
          line('A-GLAZ', mid - 0.05, coord + 0.05, p.to, coord + 0.05);
        } else {
          line('A-GLAZ', coord - 0.05, p.from, coord - 0.05, mid + 0.05);
          line('A-GLAZ', coord + 0.05, mid - 0.05, coord + 0.05, p.to);
        }
      } else
        for (const off of [-0.03, 0.03]) {
          if (p.horizontal) line('A-GLAZ', p.from, coord + off, p.to, coord + off);
          else line('A-GLAZ', coord + off, p.from, coord + off, p.to);
        }
      // jambs
      for (const at of [p.from, p.to]) {
        if (p.horizontal) line('A-WALL-EXT', at, coord - ext / 2, at, coord + ext / 2);
        else line('A-WALL-EXT', coord - ext / 2, at, coord + ext / 2, at);
      }
    }

    // interior walls by type
    for (const w of innerWalls) {
      const { type, loadBearing, thickness } = w.props;
      if (type === 'none') continue;
      const spans = doors.filter(({ p }) => p.edge.x1 === w.x1 && p.edge.y1 === w.y1 && p.edge.x2 === w.x2 && p.edge.y2 === w.y2).map(({ p }) => [p.from, p.to]);
      for (const [a, c] of solidPieces(w.from, w.to, spans)) {
        if (type === 'railing') {
          if (w.horizontal) line('A-RAIL', a, w.coord, c, w.coord);
          else line('A-RAIL', w.coord, a, w.coord, c);
        } else wallRect(type === 'glass' ? 'A-GLAZ' : loadBearing ? 'A-WALL-LOAD' : 'A-WALL', w.horizontal, w.coord, a, c, type === 'glass' ? 0.04 : thickness);
      }
    }
    for (const { d, p } of doors) {
      if (d.type === 'opening') continue;
      const room = floor.rooms.find((r) => r.id === (d.swing || d.between[1]));
      const centre = room ? (p.horizontal ? room.y + room.h / 2 : room.x + room.w / 2) : p.coord + 1;
      const side = centre < p.coord ? -1 : 1;
      const t = house.wall?.interior ?? 0.15;
      const at = (along, across) => (p.horizontal ? [along, p.coord + across] : [p.coord + across, along]);
      if (d.type === 'sliding') {
        const [x1, y1] = at(p.from - 0.05, side * 0.01);
        const [x2, y2] = at(p.to + 0.05, side * 0.05);
        rect('A-DOOR', Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      } else {
        const atEnd = d.hinge === 'end';
        const [hx, hy] = at(atEnd ? p.to : p.from, (side * t) / 2);
        swing('A-DOOR', hx, hy, p.horizontal ? [0, side] : [side, 0], p.horizontal ? [atEnd ? -1 : 1, 0] : [0, atEnd ? -1 : 1], p.to - p.from);
      }
    }

    // stairs
    for (const r of floor.rooms.filter((x) => x.type === 'stairs')) {
      const s = analyzeStairs(house, floor, r);
      const { treads, path } = stairSteps(s);
      for (const t of treads) t.pts.forEach((p, i) => line('A-STAIR', ...p, ...t.pts[(i + 1) % t.pts.length]));
      path.slice(1).forEach((p, i) => line('A-STAIR', ...path[i], ...p));
      text('A-STAIR', r.x + r.w / 2, r.y + r.h / 2 + 0.35, 0.15, `${s.risers} x ${Math.round(s.riser * 1000)} / ${Math.round(s.tread * 1000)} UP`);
    }

    // room names and areas
    for (const r of floor.rooms) {
      text('A-AREA', r.x + r.w / 2, r.y + r.h / 2 - 0.12, 0.22, r.name);
      if (r.type !== 'void') text('A-AREA', r.x + r.w / 2, r.y + r.h / 2 + 0.2, 0.16, `${fmt(area(r))} m2`);
    }

    // furniture
    for (const it of floor.items || []) {
      const c = [itemPoint(it, 0, 0), itemPoint(it, it.w, 0), itemPoint(it, it.w, it.d), itemPoint(it, 0, it.d)];
      for (let i = 0; i < 4; i++) line('A-FURN', ...c[i], ...c[(i + 1) % 4]);
      const [cx, cy] = itemPoint(it, it.w / 2, it.d / 2);
      text('A-FURN', cx, cy, 0.1, it.name || itemInfo(it).label);
    }

    // utility points
    for (const p of floor.points || []) {
      const layer = POINT_LAYER[p.kind] || 'E-POWER';
      if (p.kind === 'light') {
        circle(layer, p.x, p.y, 0.12);
        line(layer, p.x - 0.085, p.y - 0.085, p.x + 0.085, p.y + 0.085);
        line(layer, p.x - 0.085, p.y + 0.085, p.x + 0.085, p.y - 0.085);
      } else if (p.kind === 'switch') {
        circle(layer, p.x, p.y, 0.05);
        line(layer, p.x, p.y, p.x + 0.15, p.y - 0.15);
      } else {
        circle(layer, p.x, p.y, 0.1);
        text(layer, p.x, p.y, 0.08, POINT_TEXT[p.kind] ?? '');
      }
      if (p.circuit) text(layer, p.x + 0.14, p.y - 0.14, 0.07, p.circuit, 'left');
    }

    // roof areas that sit on this floor (outline, mansard break, chimneys)
    for (const { zone, floor: on, geom: g } of roofZones(house)) {
      if (!zone || on !== floor) continue;
      rect('A-ROOF', g.outer.x, g.outer.y, g.outer.w, g.outer.h);
      if (g.mansard) rect('A-ROOF', g.mansard.inner.x, g.mansard.inner.y, g.mansard.inner.w, g.mansard.inner.h);
      for (const c of zone.chimneys || []) rect('A-ROOF', c.x, c.y, c.w ?? 0.7, c.h ?? 0.9);
      text('A-ROOF', g.outer.x + g.outer.w / 2, g.outer.y + 0.5, 0.18, `${zone.name || 'Roof'} (${g.type})`);
    }

    // overall dimensions
    line('A-DIMS', b.x, b.y - 1.5, b.x + b.w, b.y - 1.5);
    text('A-DIMS', b.x + b.w / 2, b.y - 1.7, 0.2, fmt(b.w));
    line('A-DIMS', b.x + b.w + 1.5, b.y, b.x + b.w + 1.5, b.y + b.h);
    text('A-DIMS', b.x + b.w + 1.9, b.y + b.h / 2, 0.2, fmt(b.h));

    cursor += extent.w + 8;
  }

  const entities = out.splice(0);
  // header + tables
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(9, '$INSBASE'); g(10, 0); g(20, 0); g(30, 0); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1); g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0); g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, Object.keys(LAYERS).length);
  for (const [name, color] of Object.entries(LAYERS)) {
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  out.push(...entities);
  g(0, 'ENDSEC'); g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

export { POINT_KINDS };
