// Utility points (electrical, water, drainage, gas) and electrical circuits.
// floor.points[] = { id, kind, x, y, h (mounting height, m), circuit?, for? (item id), auto? }
// house.electrical = { supply: '3x25A', circuits: [{ id, name, kind, voltage, breaker, phase, rcd, auto? }] }
// Everything generated here is a proposal for the electrician / plumber, not a design.
import { ITEMS, itemInfo, itemPoint, footprint, roomAt } from './items.js';
import { interiorEdges, placeDoor, placeOpening, exteriorEdges, round } from './geometry.js';
import { sortedFloors } from './stairs.js';

export const POINT_KINDS = {
  socket: { label: 'Socket 230 V', group: 'electrical', h: 0.3 },
  'socket-counter': { label: 'Socket above counter', group: 'electrical', h: 1.1 },
  'socket-400': { label: 'Socket / outlet 400 V', group: 'electrical', h: 0.6 },
  outlet: { label: 'Appliance connection 230 V', group: 'electrical', h: 0.3 },
  switch: { label: 'Light switch', group: 'electrical', h: 1.1 },
  light: { label: 'Ceiling light', group: 'electrical', h: null },
  'light-wall': { label: 'Wall light', group: 'electrical', h: 1.8 },
  board: { label: 'Distribution board', group: 'electrical', h: 1.5 },
  data: { label: 'Data / TV socket', group: 'electrical', h: 0.3 },
  'water-cold': { label: 'Cold water', group: 'water', h: 0.5 },
  'water-hot': { label: 'Hot water', group: 'water', h: 0.5 },
  drain: { label: 'Drain', group: 'water', h: 0.1 },
  'meter-water': { label: 'Water meter / main valve', group: 'water', h: 0.5 },
  gas: { label: 'Gas connection', group: 'gas', h: 0.8 },
  'meter-gas': { label: 'Gas meter', group: 'gas', h: 1.2 },
};

export const GROUPS = { electrical: 'Electrical', water: 'Water & drainage', gas: 'Gas' };

// Sockets per room type (general purpose; appliances get their own on top).
const SOCKETS = { living: 8, kitchen: 4, bedroom: 4, office: 6, hall: 2, bathroom: 1, wc: 0, closet: 1, storage: 1, technical: 2, utility: 2, other: 2, stairs: 0, void: 0 };
const LIGHT_W = 20; // LED fitting
const GENERAL_SOCKET_CIRCUIT_W = 2000; // assumed load of a general socket circuit
const MAX_SOCKETS_PER_CIRCUIT = 10;

function wallInset(house, floor, x, y, room) {
  // move a point from the wall axis into the room by half the wall thickness + 5 cm
  const ext = new Set(exteriorEdges(floor).map((e) => `${e.horizontal ? 'h' : 'v'}${round(e.horizontal ? e.y1 : e.x1)}`));
  const half = (axis, coord) => (ext.has(`${axis}${round(coord)}`) ? (house.wall?.exterior ?? 0.4) : (house.wall?.interior ?? 0.15)) / 2 + 0.05;
  let px = Math.min(Math.max(x, room.x + half('v', room.x)), room.x + room.w - half('v', room.x + room.w));
  let py = Math.min(Math.max(y, room.y + half('h', room.y)), room.y + room.h - half('h', room.y + room.h));
  return [round(px), round(py)];
}

// Points evenly spread around a room's walls, avoiding doors and full-height glazing.
function perimeterPoints(house, floor, room, count) {
  if (count <= 0) return [];
  const blocked = [];
  const inner = interiorEdges(floor);
  for (const d of floor.doors || []) {
    if (!d.between.includes(room.id)) continue;
    const p = placeDoor(floor, d, inner);
    if (p) blocked.push(p);
  }
  const edges = exteriorEdges(floor);
  for (const o of floor.openings || []) {
    if (o.type !== 'door' && (o.sill ?? 1) > 0.3) continue;
    const p = placeOpening(floor, o, edges);
    if (p) blocked.push({ horizontal: p.horizontal, coord: p.horizontal ? p.y1 : p.x1, from: p.from, to: p.to });
  }
  const per = 2 * (room.w + room.h);
  const at = (t) => {
    // walk clockwise from the north-west corner
    t = ((t % per) + per) % per;
    if (t < room.w) return { x: room.x + t, y: room.y, horizontal: true, coord: room.y, along: room.x + t };
    t -= room.w;
    if (t < room.h) return { x: room.x + room.w, y: room.y + t, horizontal: false, coord: room.x + room.w, along: room.y + t };
    t -= room.h;
    if (t < room.w) return { x: room.x + room.w - t, y: room.y + room.h, horizontal: true, coord: room.y + room.h, along: room.x + room.w - t };
    t -= room.w;
    return { x: room.x, y: room.y + room.h - t, horizontal: false, coord: room.x, along: room.y + room.h - t };
  };
  const free = (p) =>
    !blocked.some((b) => b.horizontal === p.horizontal && Math.abs(b.coord - p.coord) < 0.01 && p.along > b.from - 0.25 && p.along < b.to + 0.25) &&
    Math.min(p.along - (p.horizontal ? room.x : room.y), (p.horizontal ? room.x + room.w : room.y + room.h) - p.along) > 0.25;
  const out = [];
  for (let i = 0; i < count; i++) {
    let t = ((i + 0.5) * per) / count;
    let p = at(t);
    for (let k = 0; k < 40 && !free(p); k++) p = at((t += 0.2));
    out.push(wallInset(house, floor, p.x, p.y, room));
  }
  return out;
}

function uniqueIds(floor) {
  const ids = new Set([...floor.rooms, ...(floor.doors || []), ...(floor.openings || []), ...(floor.items || []), ...(floor.points || [])].map((x) => x.id));
  return (base) => {
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
}

// Replace all generated points and circuits with a fresh proposal. Points the user placed
// or edited by hand (no `auto` flag) are kept.
export function generateUtilities(house) {
  const floors = sortedFloors(house);
  const ground = floors.find((f) => (f.elevation ?? 0) >= -0.5) || floors[0];
  for (const floor of floors) {
    floor.points = (floor.points || []).filter((p) => !p.auto);
    const id = uniqueIds(floor);
    const add = (kind, x, y, extra = {}) => floor.points.push({ id: id(`${kind}`), kind, x: round(x), y: round(y), h: POINT_KINDS[kind].h, auto: true, ...extra });

    for (const room of floor.rooms) {
      if (room.type === 'void') continue;
      const area = room.w * room.h;
      // lights: one per ~15 m², in a row along the longer side
      const n = Math.max(1, Math.round(area / 15));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const [x, y] = room.w >= room.h ? [room.x + room.w * t, room.y + room.h / 2] : [room.x + room.w / 2, room.y + room.h * t];
        add('light', x, y, { room: room.id });
      }
      // a switch beside every door into the room (on the side away from the hinge)
      const inner = interiorEdges(floor);
      for (const d of floor.doors || []) {
        if (!d.between.includes(room.id)) continue;
        const p = placeDoor(floor, d, inner);
        if (!p) continue;
        const along = d.hinge === 'end' ? p.from - 0.2 : p.to + 0.2;
        const [x, y] = p.horizontal ? [along, p.coord] : [p.coord, along];
        const [ix, iy] = wallInset(house, floor, x, y, room);
        add('switch', ix, iy, { room: room.id });
      }
      // general sockets
      for (const [x, y] of perimeterPoints(house, floor, room, SOCKETS[room.type] ?? 2)) add(room.type === 'bathroom' ? 'socket' : 'socket', x, y, { room: room.id });
    }

    // appliances and fittings
    for (const item of floor.items || []) {
      const needs = ITEMS[item.type]?.needs;
      if (!needs && item.type !== 'kitchen-base') continue;
      const [bx, by] = itemPoint(item, item.w / 2, 0); // middle of the back edge
      const room = roomAt(floor, bx, by);
      if (item.type === 'kitchen-base') {
        // one double socket per ~1.2 m of counter, above the worktop
        const k = Math.max(1, Math.round(item.w / 1.2));
        for (let i = 0; i < k; i++) {
          const [x, y] = itemPoint(item, ((i + 0.5) * item.w) / k, 0);
          add('socket-counter', x, y, { for: item.id, room: room?.id });
        }
        continue;
      }
      if (needs.power) add(needs.voltage === 400 ? 'socket-400' : needs.dedicated ? 'outlet' : 'socket', bx, by, { for: item.id, room: room?.id });
      if (needs.data) {
        const [x, y] = itemPoint(item, item.w / 2 + 0.25, 0);
        add('data', x, y, { for: item.id, room: room?.id });
      }
      (needs.water || []).forEach((w, i) => {
        const [x, y] = itemPoint(item, item.w / 2 + (i === 0 ? -0.1 : 0.1), 0);
        add(w === 'hot' ? 'water-hot' : 'water-cold', x, y, { for: item.id, room: room?.id });
      });
      if (needs.drain) {
        const [x, y] = itemPoint(item, item.w / 2, Math.min(0.15, item.d / 2));
        add('drain', x, y, { for: item.id, room: room?.id, size: needs.drain });
      }
      if (needs.gas) {
        const [x, y] = itemPoint(item, item.w / 2 + 0.2, 0);
        add('gas', x, y, { for: item.id, room: room?.id });
      }
    }

    // distribution board and meters on the ground floor
    if (floor === ground) {
      const order = ['technical', 'utility', 'hall', 'storage'];
      const host = order.map((t) => floor.rooms.find((r) => r.type === t)).find(Boolean) || floor.rooms[0];
      if (host && !floor.points.some((p) => p.kind === 'board')) {
        const [x, y] = wallInset(house, floor, host.x + 0.6, host.y, host);
        add('board', x, y, { room: host.id });
      }
      const anyWater = floors.some((f) => (f.points || []).some((p) => p.kind.startsWith('water')));
      const anyGas = floors.some((f) => (f.points || []).some((p) => p.kind === 'gas'));
      if (host && anyWater && !floor.points.some((p) => p.kind === 'meter-water')) {
        const [x, y] = wallInset(house, floor, host.x, host.y + host.h - 0.6, host);
        add('meter-water', x, y, { room: host.id });
      }
      if (host && anyGas && !floor.points.some((p) => p.kind === 'meter-gas')) {
        const [x, y] = wallInset(house, floor, host.x, host.y + 0.6, host);
        add('meter-gas', x, y, { room: host.id });
      }
    }
  }
  generateCircuits(house);
}

// Group points and appliances into circuits and balance single-phase circuits over L1–L3.
export function generateCircuits(house) {
  const el = (house.electrical ||= { supply: '3x25A', circuits: [] });
  el.circuits = el.circuits.filter((c) => !c.auto);
  const manual = new Set(el.circuits.map((c) => c.id));
  const circuits = [];
  // short conventional ids: L1 lights, S1 sockets, K1 kitchen counter, B1 bathroom, A1 appliances
  const mk = (prefix, name, kind, voltage, breaker, extra = {}) => {
    let cid;
    for (let n = 1; !cid || manual.has(cid) || circuits.some((c) => c.id === cid); n++) cid = `${prefix}${n}`;
    const c = { id: cid, name, kind, voltage, breaker, rcd: kind !== 'lighting' || extra.rcd, auto: true, ...extra };
    circuits.push(c);
    return c;
  };
  for (const floor of sortedFloors(house)) {
    const pts = (floor.points || []).filter((p) => !p.circuit || !manual.has(p.circuit));
    // lighting: one circuit per floor
    const lights = pts.filter((p) => ['light', 'light-wall'].includes(p.kind));
    if (lights.length) {
      const c = mk('L', `Lights – ${floor.name}`, 'lighting', 230, 'B10', { load: lights.length * LIGHT_W });
      lights.forEach((p) => (p.circuit = c.id));
    }
    // dedicated appliance circuits
    for (const item of floor.items || []) {
      const needs = ITEMS[item.type]?.needs;
      if (!needs?.power || !needs.dedicated) continue;
      const three = needs.voltage === 400;
      const c = mk('A', `${item.name || ITEMS[item.type].label} (${floor.name.toLowerCase()})`, 'appliance', three ? 400 : 230, three ? '3×B16' : 'B16', {
        load: needs.power,
        items: [`${floor.id}/${item.id}`],
      });
      pts.filter((p) => p.for === item.id && (p.kind === 'outlet' || p.kind === 'socket-400')).forEach((p) => (p.circuit = c.id));
      item.circuit = c.id;
    }
    // counter sockets: own circuit per floor
    const counter = pts.filter((p) => p.kind === 'socket-counter');
    if (counter.length) {
      const c = mk('K', `Kitchen counter sockets – ${floor.name}`, 'sockets', 230, 'B16', { load: GENERAL_SOCKET_CIRCUIT_W });
      counter.forEach((p) => (p.circuit = c.id));
    }
    // bathrooms get their own socket circuit
    const bathRooms = new Set(floor.rooms.filter((r) => r.type === 'bathroom' || r.type === 'wc').map((r) => r.id));
    const dedicated = new Set(circuits.filter((c) => c.kind === 'appliance').map((c) => c.id));
    const bath = pts.filter((p) => ['socket', 'outlet'].includes(p.kind) && !dedicated.has(p.circuit) && bathRooms.has(p.room) && !(floor.items || []).some((i) => i.id === p.for && ITEMS[i.type]?.needs?.dedicated));
    if (bath.length) {
      const c = mk('B', `Bathroom sockets – ${floor.name}`, 'sockets', 230, 'B16', { load: 1500 });
      bath.forEach((p) => (p.circuit = c.id));
    }
    // general sockets, grouped room by room, at most N per circuit
    const general = pts.filter((p) => ['socket', 'data'].includes(p.kind) && !bath.includes(p));
    let current = null;
    let count = 0;
    let lastRoom = null;
    general
      .sort((a, b) => String(a.room).localeCompare(String(b.room)))
      .forEach((p) => {
        if (p.kind === 'data') return void delete p.circuit;
        if (!current || count >= MAX_SOCKETS_PER_CIRCUIT || (count >= MAX_SOCKETS_PER_CIRCUIT - 3 && p.room !== lastRoom)) {
          current = mk('S', `Sockets – ${floor.name}`, 'sockets', 230, 'B16', { load: GENERAL_SOCKET_CIRCUIT_W, rooms: [] });
          count = 0;
        }
        p.circuit = current.id;
        if (p.room && !current.rooms.includes(p.room)) current.rooms.push(p.room);
        lastRoom = p.room;
        count++;
      });
    for (const c of circuits) {
      if (c.rooms) {
        const names = c.rooms.map((id) => floor.rooms.find((r) => r.id === id)?.name).filter(Boolean);
        if (names.length) c.name = `Sockets – ${names.join(', ')}`;
        delete c.rooms;
      }
    }
  }
  // balance single-phase circuits over the three phases (largest first)
  const phase = { L1: 0, L2: 0, L3: 0 };
  for (const c of el.circuits) if (c.phase in phase) phase[c.phase] += c.load || 0;
  for (const c of [...circuits].sort((a, b) => (b.load || 0) - (a.load || 0))) {
    if (c.voltage === 400) c.phase = 'L1+L2+L3';
    else {
      const p = Object.keys(phase).sort((a, b) => phase[a] - phase[b])[0];
      c.phase = p;
      phase[p] += c.load || 0;
    }
  }
  el.circuits.push(...circuits);
}

// Installed load per phase and a rough suggestion for the main breaker.
export function loadSummary(house) {
  const circuits = house.electrical?.circuits || [];
  const phase = { L1: 0, L2: 0, L3: 0 };
  let installed = 0;
  for (const c of circuits) {
    const load = c.load || 0;
    installed += load;
    if (c.voltage === 400) for (const p of Object.keys(phase)) phase[p] += load / 3;
    else if (phase[c.phase] !== undefined) phase[c.phase] += load;
  }
  // Not everything runs at once; 0.5 is a deliberately cautious planning factor.
  const demand = Math.max(...Object.values(phase)) * 0.5;
  const amps = demand / 230;
  const breaker = [16, 20, 25, 32, 40, 50, 63].find((a) => a >= amps * 1.1) || 63;
  const counts = {};
  for (const f of house.floors) for (const p of f.points || []) counts[p.kind] = (counts[p.kind] || 0) + 1;
  return { installed, phase, demand, amps, breaker, counts, circuits: circuits.length };
}

export function pointGroup(kind) {
  return POINT_KINDS[kind]?.group || 'electrical';
}

export { footprint, itemInfo };
