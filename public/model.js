// Resolving selection/comment targets to objects, and human-readable names. No DOM.
import { floorWalls } from './walls.js';
import { itemInfo } from './items.js';
import { POINT_KINDS } from './utilities.js';

export const FACADES = { N: 'north', S: 'south', E: 'east', W: 'west' };

// Exterior openings (floor.openings[].type). Hinged doors also have `hinge` ('start' = west/north
// end, 'end' = east/south end) and `swing` ('in' | 'out'); a sliding door's `hinge` is the end the
// moving leaf slides towards.
export const OPENING_TYPES = {
  window: 'Window',
  door: 'Exterior door',
  'terrace-door': 'Terrace door (glazed)',
  'sliding-door': 'Sliding terrace door',
};
export const OPENING_DEFAULTS = {
  window: { sill: 0.9, height: 1.4, width: 1.2 },
  door: { sill: 0, height: 2.2, width: 1.0 },
  'terrace-door': { sill: 0, height: 2.2, width: 0.9 },
  'sliding-door': { sill: 0, height: 2.2, width: 2.4 },
};
export const isHinged = (o) => o.type === 'door' || o.type === 'terrace-door';
export const isExteriorDoor = (o) => o.type in OPENING_TYPES && o.type !== 'window';

export function roomName(floor, id) {
  return floor.rooms.find((r) => r.id === id)?.name || id;
}

export function doorName(floor, d) {
  const kind = d.type === 'opening' ? 'Passage' : d.type === 'sliding' ? 'Sliding door' : 'Door';
  return `${kind}: ${roomName(floor, d.between[0])} ↔ ${roomName(floor, d.between[1])}`;
}

export function openingName(floor, o) {
  return `${OPENING_TYPES[o.type] || 'Window'} (${FACADES[o.facade]}, ${floor.name.toLowerCase()})`;
}

export function wallName(floor, w) {
  if (w.desc.exterior) return `Exterior wall: ${roomName(floor, w.desc.room)} (${FACADES[w.desc.side]})`;
  return `Wall: ${w.desc.between.map((id) => roomName(floor, id)).join(' | ')}`;
}

export function itemName(item) {
  return item.name || itemInfo(item).label;
}

export function pointName(floor, p) {
  const where = p.room ? ` (${roomName(floor, p.room)})` : '';
  return `${POINT_KINDS[p.kind]?.label || p.kind}${where}`;
}

// target: "house" | "roof" | "site/<id>" | "<floorId>/<roomId|doorId|openingId|itemId|pointId|wall:…>"
export function resolveTarget(house, target) {
  if (!target || target === 'house') return { kind: 'house', name: 'Whole house' };
  if (target === 'roof') return { kind: 'roof', item: house.roof, name: 'Roof' };
  if (target.startsWith('roofs/')) {
    const z = (house.roofs || []).find((r) => r.id === target.slice(6));
    return z && { kind: 'roofzone', item: z, name: z.name || 'Roof area' };
  }
  const [a, b] = target.split('/');
  if (a === 'site') {
    const item = house.site.find((s) => s.id === b);
    return item && { kind: 'site', item, name: item.name };
  }
  const floor = house.floors.find((f) => f.id === a);
  if (!floor || !b) return undefined;
  const room = floor.rooms.find((r) => r.id === b);
  if (room) return { kind: 'room', floor, item: room, name: room.name };
  if (b.startsWith('wall:')) {
    const { inner, outer } = floorWalls(house, floor);
    const wall = [...inner, ...outer].find((w) => w.key === b);
    return wall && { kind: 'wall', floor, wall, item: wall.props, name: wallName(floor, wall) };
  }
  const door = (floor.doors || []).find((d) => d.id === b);
  if (door) return { kind: 'door', floor, item: door, name: doorName(floor, door) };
  const opening = (floor.openings || []).find((o) => o.id === b);
  if (opening) return { kind: 'opening', floor, item: opening, name: openingName(floor, opening) };
  const item = (floor.items || []).find((i) => i.id === b);
  if (item) return { kind: 'item', floor, item, name: itemName(item) };
  const point = (floor.points || []).find((p) => p.id === b);
  if (point) return { kind: 'point', floor, item: point, name: pointName(floor, point) };
  return undefined;
}

// Ids must be unique per floor across rooms, doors, openings, furniture and utility points (the
// server refuses to save otherwise). Renames any clash (rooms keep theirs) and returns how many.
export function fixDuplicateIds(house) {
  let fixed = 0;
  for (const f of house.floors || []) {
    const taken = new Set((f.rooms || []).map((r) => r.id));
    const all = new Set([...taken, ...['doors', 'openings', 'items', 'points'].flatMap((k) => (f[k] || []).map((x) => x.id))]);
    for (const kind of ['doors', 'openings', 'items', 'points'])
      for (const x of f[kind] || []) {
        if (x.id && !taken.has(x.id)) {
          taken.add(x.id);
          continue;
        }
        const base = x.id || kind.slice(0, -1);
        let n = 2;
        while (all.has(`${base}-${n}`)) n++;
        const id = `${base}-${n}`;
        // utility points refer to their appliance by id
        if (kind === 'items') for (const p of f.points || []) if (p.for === x.id) p.for = id;
        x.id = id;
        all.add(id);
        taken.add(id);
        fixed++;
      }
  }
  return fixed;
}
