// Per-wall properties. Walls are derived from room edges, so settings are stored in
// floor.walls keyed by what the wall separates:
//   interior: { between: [roomA, roomB], ... }   (ids sorted)
//   exterior: { room, side: 'N'|'S'|'E'|'W', ... }
// Properties: type ('wall' | 'railing' | 'glass' | 'none'), loadBearing, thickness, material.
import { exteriorEdges, interiorEdges, round } from './geometry.js';

export const WALL_TYPES = {
  wall: 'Wall',
  railing: 'Railing (1 m)',
  glass: 'Glass partition',
  none: 'No wall (open)',
};

export const MATERIALS = [
  'Ceramic block 30 cm',
  'Ceramic block 25 cm',
  'Ceramic block 17.5 cm',
  'Ceramic block 11.5 cm',
  'Aerated concrete',
  'Reinforced concrete',
  'Brick',
  'Timber frame',
  'Drywall (plasterboard)',
];

const SIDES = ['N', 'S', 'E', 'W'];
const CIRCULATION = new Set(['hall']);

export function wallKey(floor, edge) {
  if (edge.room) return `wall:${edge.room}:${edge.side}`;
  const [a, b] = edge.rooms.map((i) => floor.rooms[i].id).sort();
  return `wall:${a}:${b}`;
}

// Parse "wall:a:b" / "wall:room:S" into a lookup description.
export function parseWallKey(floor, key) {
  const [, a, b] = key.split(':');
  if (SIDES.includes(b) && floor.rooms.some((r) => r.id === a)) return { exterior: true, room: a, side: b };
  return { exterior: false, between: [a, b].sort() };
}

function findEntry(floor, desc) {
  return (floor.walls || []).find((w) =>
    desc.exterior ? w.room === desc.room && w.side === desc.side : w.between && w.between[0] === desc.between[0] && w.between[1] === desc.between[1],
  );
}

export function defaultWall(house, floor, desc) {
  const thick = house.wall || {};
  if (desc.exterior) return { type: 'wall', loadBearing: true, thickness: thick.exterior ?? 0.4, material: thick.exteriorMaterial || 'Ceramic block 30 cm' };
  const rooms = desc.between.map((id) => floor.rooms.find((r) => r.id === id));
  const voidRoom = rooms.find((r) => r?.type === 'void');
  const other = rooms.find((r) => r && r !== voidRoom);
  // around a stair void: a railing towards circulation, a real wall towards rooms
  const type = voidRoom && other && CIRCULATION.has(other.type) ? 'railing' : 'wall';
  return { type, loadBearing: false, thickness: thick.interior ?? 0.15, material: 'Ceramic block 11.5 cm' };
}

// Effective properties (defaults overlaid with any stored settings).
export function wallProps(house, floor, desc) {
  const base = defaultWall(house, floor, desc);
  const entry = findEntry(floor, desc) || {};
  const props = { ...base, ...entry };
  if (!desc.exterior && entry.loadBearing && entry.thickness === undefined) props.thickness = house.wall?.loadBearing ?? 0.25;
  if (desc.exterior) props.type = 'wall';
  if (props.loadBearing && props.type !== 'wall') props.type = 'wall';
  return props;
}

export function setWallProps(house, floor, desc, changes) {
  floor.walls ||= [];
  let entry = findEntry(floor, desc);
  if (!entry) {
    entry = desc.exterior ? { room: desc.room, side: desc.side } : { between: [...desc.between] };
    floor.walls.push(entry);
  }
  Object.assign(entry, changes);
  // drop settings that equal the defaults so house.json stays small
  const base = defaultWall(house, floor, desc);
  for (const k of Object.keys(changes)) if (entry[k] === base[k]) delete entry[k];
  if (Object.keys(entry).filter((k) => !['room', 'side', 'between'].includes(k)).length === 0) floor.walls.splice(floor.walls.indexOf(entry), 1);
}

export function resetWall(floor, desc) {
  const entry = findEntry(floor, desc);
  if (entry) floor.walls.splice(floor.walls.indexOf(entry), 1);
}

// Remove settings for walls whose rooms no longer exist.
export function pruneWalls(floor) {
  if (!floor.walls) return;
  const ids = new Set(floor.rooms.map((r) => r.id));
  floor.walls = floor.walls.filter((w) => (w.between ? w.between.every((id) => ids.has(id)) : ids.has(w.room)));
}

// Exterior wall pieces split per room, so each room's facade can carry its own settings.
export function exteriorPieces(floor, edges = exteriorEdges(floor)) {
  const out = [];
  for (const room of floor.rooms) {
    const sides = {
      N: { horizontal: true, coord: room.y, a: room.x, b: room.x + room.w },
      S: { horizontal: true, coord: room.y + room.h, a: room.x, b: room.x + room.w },
      W: { horizontal: false, coord: room.x, a: room.y, b: room.y + room.h },
      E: { horizontal: false, coord: room.x + room.w, a: room.y, b: room.y + room.h },
    };
    for (const [side, s] of Object.entries(sides)) {
      for (const e of edges) {
        if (e.side !== side) continue;
        const coord = s.horizontal ? e.y1 : e.x1;
        if (Math.abs(coord - s.coord) > 0.01) continue;
        const [ea, eb] = s.horizontal ? [e.x1, e.x2] : [e.y1, e.y2];
        const from = Math.max(ea, s.a);
        const to = Math.min(eb, s.b);
        if (to - from < 0.01) continue;
        out.push({
          room: room.id,
          side,
          horizontal: s.horizontal,
          coord,
          from: round(from),
          to: round(to),
          x1: s.horizontal ? from : coord,
          y1: s.horizontal ? coord : from,
          x2: s.horizontal ? to : coord,
          y2: s.horizontal ? coord : to,
          edge: e,
        });
      }
    }
  }
  return out;
}

// Every wall on a floor with its effective properties, as straight segments.
export function floorWalls(house, floor) {
  const inner = interiorEdges(floor).map((e) => {
    const desc = { exterior: false, between: e.rooms.map((i) => floor.rooms[i].id).sort() };
    return { ...e, desc, key: wallKey(floor, e), props: wallProps(house, floor, desc), from: e.horizontal ? e.x1 : e.y1, to: e.horizontal ? e.x2 : e.y2, coord: e.horizontal ? e.y1 : e.x1 };
  });
  const outer = exteriorPieces(floor).map((p) => {
    const desc = { exterior: true, room: p.room, side: p.side };
    return { ...p, desc, key: wallKey(floor, p), props: wallProps(house, floor, desc) };
  });
  return { inner, outer };
}

// Locate the wall segment under a plan point (for click-to-select).
export function wallAt(house, floor, x, y, tolerance) {
  const { inner, outer } = floorWalls(house, floor);
  let best = null;
  for (const w of [...outer, ...inner]) {
    const along = w.horizontal ? x : y;
    const across = w.horizontal ? y : x;
    if (along < w.from - 0.01 || along > w.to + 0.01) continue;
    const d = Math.abs(across - w.coord);
    const reach = Math.max(tolerance, (w.props.thickness ?? 0.15) / 2);
    if (d <= reach && (!best || d < best.d)) best = { wall: w, d };
  }
  return best?.wall || null;
}

// All interior wall segments lying on the same straight line as `wall` and touching it.
export function sameLine(house, floor, wall) {
  const { inner, outer } = floorWalls(house, floor);
  const all = wall.desc.exterior ? outer : inner;
  const line = all.filter((w) => w.horizontal === wall.horizontal && Math.abs(w.coord - wall.coord) < 0.01).sort((a, b) => a.from - b.from);
  // contiguous run containing the wall
  let lo = wall.from;
  let hi = wall.to;
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of line)
      if (w.to >= lo - 0.01 && w.from <= hi + 0.01 && (w.from < lo || w.to > hi)) {
        lo = Math.min(lo, w.from);
        hi = Math.max(hi, w.to);
        grew = true;
      }
  }
  return line.filter((w) => w.from >= lo - 0.01 && w.to <= hi + 0.01);
}
