// Stair design check and auto-fix. A room with type "stairs" holds a straight flight
// that climbs towards `room.up` (N/S/E/W) from its floor to the next floor up, or with
// `shape: 'U'` a half-turn stair: a flight up one half of the room, a turn at the far end
// (winders, or a half landing with `winders: false`) and a flight back down the other half.
// `turn` ('left'|'right', seen from the foot) says which way it turns.
import { interiorEdges, placeDoor, round } from './geometry.js';
import { wallProps } from './walls.js';

// Defaults for a family house; override in house.json under "rules.stairs".
// These are planning values only. The national standard and your architect decide.
export const DEFAULT_STAIR_RULES = {
  maxRiser: 0.19, // m
  minTread: 0.25, // m
  stepRule: 0.63, // 2 × riser + tread ≈ 0.63 m (comfortable pace)
  minWidth: 0.9, // m clear flight width
  sideEntryReach: 0.3, // a side entrance must start this close to the foot (plus any landing)
};

export const stairRules = (house) => ({ ...DEFAULT_STAIR_RULES, ...(house.rules?.stairs || {}) });

const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };

export function sortedFloors(house) {
  return [...house.floors].sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
}

function roomAt(floor, x, y) {
  return floor.rooms.find((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) || null;
}

// Geometry of the flight inside the room: axis, foot/top coordinates and the side span.
export function flight(room, up = room.up || (room.h >= room.w ? 'S' : 'E')) {
  const alongY = up === 'N' || up === 'S';
  const forward = up === 'S' || up === 'E'; // climbing towards increasing coordinate
  const start = alongY ? room.y : room.x;
  const size = alongY ? room.h : room.w;
  const foot = forward ? start : start + size;
  const top = forward ? start + size : start;
  const across = alongY ? [room.x, room.x + room.w] : [room.y, room.y + room.h];
  return { up, alongY, forward, foot, top, length: size, across, dir: forward ? 1 : -1 };
}

// Point helper in plan coordinates: `along` on the flight axis, `side` across it.
const pt = (f, along, side) => (f.alongY ? [side, along] : [along, side]);

export function analyzeStairs(house, floor, room, up) {
  const rules = stairRules(house);
  const floors = sortedFloors(house);
  const fi = floors.indexOf(floor);
  const above = floors[fi + 1] || null;
  const f = flight(room, up);
  const rise = above ? (above.elevation ?? 0) - (floor.elevation ?? 0) : (floor.height ?? 2.8);
  const risers = Math.ceil(rise / rules.maxRiser - 1e-9);
  const riser = rise / risers;
  const tread = Math.max(rules.minTread, rules.stepRule - 2 * riser);
  const mid = (f.across[0] + f.across[1]) / 2;
  const u = room.shape === 'U' ? halfTurn(room, f, risers, tread) : null;
  const run = u ? u.needed : (risers - 1) * tread; // the top "step" is the floor above
  const landing = f.length - run; // free floor at the foot of the flight (U: spare length)
  const width = u ? u.fw : f.across[1] - f.across[0] - 0.1;
  const issues = [];
  const ok = [];

  if (!above) issues.push({ code: 'no-floor-above', text: 'There is no floor above these stairs.' });
  if (landing < -0.005)
    issues.push({ code: 'too-short', text: `The ${u ? 'stair' : 'flight'} needs ${run.toFixed(2)} m but the room is only ${f.length.toFixed(2)} m long (${(-landing).toFixed(2)} m short).` });
  else if (u) ok.push(`U-shaped stair fits: ${risers} risers × ${(riser * 1000).toFixed(0)} mm, treads ${(tread * 1000).toFixed(0)} mm, ${u.winders ? `${u.k} winders` : 'a half landing'} at the turn, ${run.toFixed(2)} m long.`);
  else ok.push(`Flight fits: ${risers} risers × ${(riser * 1000).toFixed(0)} mm, treads ${(tread * 1000).toFixed(0)} mm, ${run.toFixed(2)} m long.`);
  if (width < rules.minWidth - 0.005) issues.push({ code: 'narrow', text: `${u ? 'Each flight' : 'Flight'} is ${width.toFixed(2)} m wide; at least ${rules.minWidth} m is needed.` });

  // --- entry at the foot: an interior door/passage on the foot-end wall, or on a side wall near the foot
  const inner = interiorEdges(floor);
  let entry = null;
  for (const d of floor.doors || []) {
    if (!d.between.includes(room.id)) continue;
    const p = placeDoor(floor, d, inner);
    if (!p) continue;
    const onAxisWall = p.horizontal === f.alongY; // wall perpendicular to the flight
    if (onAxisWall && Math.abs(p.coord - f.foot) < 0.01) entry = entry || { door: d, kind: 'inline' };
    else if (!onAxisWall) {
      const near = f.forward ? p.from - f.foot : f.foot - p.to;
      if (near <= Math.max(landing, 0) + rules.sideEntryReach + 1e-6) entry = entry || { door: d, kind: 'side' };
    }
  }
  if (entry) ok.push(`Entry at the foot from ${floor.rooms.find((r) => r.id === entry.door.between.find((id) => id !== room.id))?.name} (${entry.kind === 'inline' ? 'straight on' : 'from the side'}).`);
  else issues.push({ code: 'no-entry', text: 'No door or passage leads to the foot of the stairs.' });

  // --- top: an opening above the flight and a walkable room to step into
  let arrival = null;
  let voidRoom = null;
  if (above) {
    const [vx, vy] = u ? pt(f, f.foot + (f.dir * f.length) / 2, mid) : pt(f, f.top - f.dir * 0.5, mid);
    voidRoom = roomAt(above, vx, vy);
    if (voidRoom && voidRoom.type !== 'void')
      issues.push({ code: 'no-void', text: `${voidRoom.name} on ${above.name.toLowerCase()} covers the stairs; it needs to be a stair void.` });
    if (u) {
      // the second flight comes back towards the foot: step off straight on past the foot end,
      // or sideways off its outer side
      const cB = (u.sideB[0] + u.sideB[1]) / 2;
      const outer = u.sideB[0] > mid ? f.across[1] + 0.1 : f.across[0] - 0.1;
      const lastEdge = u.end2 + f.dir * Math.min(0.3, Math.max(landing, 0) + 0.3);
      const candidates = [pt(f, f.foot - f.dir * 0.1, cB), pt(f, (u.end2 + lastEdge) / 2, outer)].map(([cx, cy]) => roomAt(above, cx, cy));
      // prefer the side with an opening from the stairwell
      const linked = (r) => voidRoom && (above.doors || []).some((d) => d.between.includes(voidRoom.id) && d.between.includes(r.id));
      const walkable = candidates.filter((r) => r && r.type !== 'void');
      arrival = walkable.find(linked) || walkable[0] || candidates.find(Boolean) || null;
    } else {
      const [ax, ay] = pt(f, f.top + f.dir * 0.1, mid);
      arrival = roomAt(above, ax, ay);
    }
    if (!arrival || arrival.type === 'void')
      issues.push({ code: 'no-arrival', text: `The top of the stairs leads ${arrival ? 'into another void' : 'outside the building'} on ${above.name.toLowerCase()}.` });
    else if (voidRoom && voidRoom !== arrival) {
      const gap = (above.doors || []).find((d) => d.between.includes(voidRoom.id) && d.between.includes(arrival.id) && placeDoor(above, d));
      const open = wallProps(house, above, { exterior: false, between: [voidRoom.id, arrival.id].sort() }).type === 'none';
      if (gap || open) ok.push(`Arrives in ${arrival.name} through ${open ? 'an open edge' : 'an opening in the railing'}.`);
      else issues.push({ code: 'no-landing-gap', text: `The railing between ${voidRoom.name} and ${arrival.name} has no opening where the stairs arrive.` });
    } else ok.push(`Arrives in ${arrival.name}.`);
  }
  // optional storage under the flight, where there is at least 1.5 m of headroom
  let storage = null;
  if (room.storage && !u && landing > -0.005) {
    const k = Math.max(0, Math.ceil(1.5 / riser) - 1);
    const from = f.foot + f.dir * (landing + k * tread);
    const len = Math.max(0, (f.top - from) * f.dir);
    storage = { from, to: f.top, length: len, area: len * Math.max(width, 0) };
    if (len > 0.3) ok.push(`Storage under the stairs: about ${storage.area.toFixed(1)} m² with at least 1.5 m headroom.`);
  }
  return { rules, rise, risers, riser, tread, run, landing, width, flight: f, entry, arrival, voidRoom, above, issues, ok, storage, u };
}

// Half-turn (U) layout inside the room: the two flight strips across the room, how many
// treads each flight has, and the depth of the turn at the far end.
function halfTurn(room, f, risers, tread) {
  const lo = f.across[0] + 0.05;
  const hi = f.across[1] - 0.05;
  const gap = 0.06; // stairwell gap between the flights
  const fw = (hi - lo - gap) / 2;
  // which side the second flight is on: to the right of someone walking up the first flight
  const right = f.alongY ? -f.dir : f.dir; // across-axis sign of "right"
  const s2 = room.turn === 'left' ? -right : right;
  const sideA = s2 > 0 ? [lo, lo + fw] : [hi - fw, hi];
  const sideB = s2 > 0 ? [hi - fw, hi] : [lo, lo + fw];
  const winders = room.winders !== false;
  const k = winders ? 6 : 1; // treads in the turn (one landing counts as one)
  const straight = Math.max(0, risers - 1 - k);
  const n1 = Math.ceil(straight / 2);
  const n2 = straight - n1;
  const depth = fw + 0.05; // the turn takes a square-ish strip at the far end
  const needed = Math.max(n1, n2) * tread + depth;
  const turnStart = f.top - f.dir * depth; // where the first flight ends
  const end2 = turnStart - f.dir * n2 * tread; // where the second flight ends
  return { fw, sideA, sideB, winders, k, n1, n2, depth, needed, turnStart, end2, sA: -s2 };
}

// Every tread as a plan polygon with the height of its top, plus the walking line, for the
// plan, the 3D model and the DXF. Treads are squeezed to fit when the room is too short.
export function stairSteps(a) {
  const f = a.flight;
  const P = (along, side) => pt(f, along, side);
  const treads = [];
  const rect = (a0, a1, s0, s1, h) => treads.push({ pts: [P(a0, s0), P(a1, s0), P(a1, s1), P(a0, s1)], h });
  const lo = f.across[0] + 0.05;
  const hi = f.across[1] - 0.05;
  const mid = (f.across[0] + f.across[1]) / 2;
  if (!a.u) {
    const steps = a.risers - 1;
    const landing = Math.max(a.landing, 0);
    const tread = a.landing < 0 ? f.length / steps : a.tread;
    for (let k = 0; k < steps; k++) {
      const a0 = f.foot + f.dir * (landing + k * tread);
      rect(a0, a0 + f.dir * tread, lo, hi, a.riser * (k + 1));
    }
    return { treads, path: [P(f.foot + f.dir * (landing + 0.15), mid), P(f.top - f.dir * 0.25, mid)] };
  }
  const u = a.u;
  const squeeze = a.landing < 0 ? (f.length - u.depth) / Math.max(u.n1, u.n2, 1) : a.tread;
  const turnStart = f.top - f.dir * u.depth;
  // first flight from the foot up to the turn
  for (let k = 0; k < u.n1; k++) {
    const a0 = turnStart - f.dir * (u.n1 - k) * squeeze;
    rect(a0, a0 + f.dir * squeeze, u.sideA[0], u.sideA[1], a.riser * (k + 1));
  }
  // the turn: a landing, or winders fanning around the inner corner of the well
  const D = u.depth - 0.05;
  const Wh = (hi - lo) / 2;
  const L = (uu, vv) => P(turnStart + f.dir * uu, mid + vv);
  if (!u.winders) treads.push({ pts: [L(0, -Wh), L(D, -Wh), L(D, Wh), L(0, Wh)], h: a.riser * (u.n1 + 1) });
  else {
    const hit = (phi) => {
      const du = Math.sin(phi);
      const dv = u.sA * Math.cos(phi);
      let t = Infinity;
      if (du > 1e-9) t = Math.min(t, D / du);
      if (Math.abs(dv) > 1e-9) t = Math.min(t, Wh / Math.abs(dv));
      return [t * du, t * dv];
    };
    const cA = Math.atan2(D, Wh);
    const corners = [[cA, [D, u.sA * Wh]], [Math.PI - cA, [D, -u.sA * Wh]]];
    for (let i = 0; i < u.k; i++) {
      const p0 = (i * Math.PI) / u.k;
      const p1 = ((i + 1) * Math.PI) / u.k;
      const ring = [[0, 0], hit(p0)];
      for (const [c, q] of corners) if (c > p0 + 1e-9 && c < p1 - 1e-9) ring.push(q);
      ring.push(hit(p1));
      treads.push({ pts: ring.map(([uu, vv]) => L(uu, vv)), h: a.riser * (u.n1 + i + 1) });
    }
  }
  // second flight back towards the foot
  for (let j = 0; j < u.n2; j++) {
    const a0 = turnStart - f.dir * j * squeeze;
    rect(a0, a0 - f.dir * squeeze, u.sideB[0], u.sideB[1], a.riser * (u.n1 + u.k + j + 1));
  }
  const cA = (u.sideA[0] + u.sideA[1]) / 2;
  const cB = (u.sideB[0] + u.sideB[1]) / 2;
  const half = turnStart + (f.dir * D) / 2;
  return {
    treads,
    path: [P(turnStart - f.dir * u.n1 * squeeze + f.dir * 0.15, cA), P(half, cA), P(half, cB), P(turnStart - f.dir * u.n2 * squeeze + f.dir * 0.2, cB)],
  };
}

function sharedSpan(floor, a, b) {
  const p = placeDoor(floor, { between: [a.id, b.id], offset: 0, width: 0.3 });
  return p ? { from: p.wallFrom, to: p.wallTo, horizontal: p.horizontal, coord: p.coord } : null;
}

function uniqueId(floor, base) {
  const ids = new Set([...floor.rooms, ...(floor.doors || []), ...(floor.openings || []), ...(floor.items || []), ...(floor.points || [])].map((x) => x.id));
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  return id;
}

const WALKABLE = new Set(['hall', 'living', 'kitchen', 'other', 'office', 'utility', 'storage']);

// Try to make the stairs usable. Returns { actions: [...], remaining: [...] }.
export function fixStairs(house, floor, room) {
  const actions = [];
  // 1) climb in the direction that arrives somewhere walkable
  let a = analyzeStairs(house, floor, room);
  const flipped = analyzeStairs(house, floor, room, OPPOSITE[a.flight.up]);
  const bad = (x) => x.issues.filter((i) => ['no-arrival', 'no-void', 'too-short'].includes(i.code)).length;
  if (bad(flipped) < bad(a)) {
    room.up = flipped.flight.up;
    actions.push(`Reversed the stairs so they climb ${{ N: 'north', S: 'south', E: 'east', W: 'west' }[room.up]}.`);
    a = analyzeStairs(house, floor, room);
  } else room.up = a.flight.up;
  const f = a.flight;

  // 2) an entry at the foot
  if (!a.entry) {
    const inner = interiorEdges(floor);
    const idx = floor.rooms.indexOf(room);
    const others = new Set(inner.filter((e) => e.rooms.includes(idx)).map((e) => floor.rooms[e.rooms[0] === idx ? e.rooms[1] : e.rooms[0]]));
    const candidates = [];
    for (const other of others) {
      if (other.type === 'void' || other.type === 'stairs') continue;
      const s = sharedSpan(floor, room, other);
      if (!s) continue;
      const len = s.to - s.from;
      const width = round(Math.min(1.0, len - 0.1), 0.05);
      if (width < 0.7) continue;
      const inline = s.horizontal === f.alongY && Math.abs(s.coord - f.foot) < 0.01;
      // side entry: put it right at the foot end of the shared wall
      let offset;
      if (inline) offset = Math.max(0, (len - width) / 2);
      else {
        const footSide = f.forward ? f.foot : f.foot - width;
        offset = Math.min(Math.max(footSide - s.from, 0), len - width);
        const near = f.forward ? s.from + offset - f.foot : f.foot - (s.from + offset + width);
        if (near > Math.max(a.landing, 0) + a.rules.sideEntryReach) continue;
      }
      candidates.push({ other, width, offset: round(offset, 0.05), inline, score: (inline ? 0 : 1) + (WALKABLE.has(other.type) ? 0 : 2) });
    }
    candidates.sort((p, q) => p.score - q.score);
    const c = candidates[0];
    if (c) {
      (floor.doors ||= []).push({ id: uniqueId(floor, `d-${c.other.id}-${room.id}`), type: 'opening', between: [c.other.id, room.id], offset: c.offset, width: c.width, height: 2.1 });
      actions.push(`Added an open passage from ${c.other.name} to the foot of the stairs.`);
    }
  } else if (a.entry.kind === 'side') {
    // keep it, but slide it to the very foot so nobody steps onto a high tread from the side
    const d = a.entry.door;
    const p = placeDoor(floor, d);
    const want = f.forward ? f.foot - p.wallFrom : f.foot - (p.to - p.from) - p.wallFrom;
    const offset = round(Math.min(Math.max(want, 0), p.wallTo - p.wallFrom - (p.to - p.from)), 0.05);
    if (Math.abs(offset - (d.offset ?? 0)) > 0.01) {
      d.offset = offset;
      actions.push('Moved the side entrance to the very foot of the stairs.');
    }
  }

  // 3) an opening in the railing where the stairs arrive
  a = analyzeStairs(house, floor, room);
  if (a.above && a.voidRoom && a.arrival && a.voidRoom !== a.arrival && a.issues.some((i) => i.code === 'no-landing-gap')) {
    const s = sharedSpan(a.above, a.voidRoom, a.arrival);
    if (s) {
      const width = round(Math.min(s.to - s.from, Math.max(a.width + 0.1, a.rules.minWidth)), 0.05);
      const centre = (f.across[0] + f.across[1]) / 2;
      const offset = round(Math.min(Math.max(centre - width / 2 - s.from, 0), s.to - s.from - width), 0.05);
      (a.above.doors ||= []).push({ id: uniqueId(a.above, `d-${a.voidRoom.id}-${a.arrival.id}`), type: 'opening', between: [a.arrival.id, a.voidRoom.id], offset, width, height: 2.1 });
      actions.push(`Opened the railing on ${a.above.name.toLowerCase()} where the stairs arrive.`);
    }
  }

  a = analyzeStairs(house, floor, room);
  const remaining = a.issues.map((i) => i.text);
  if (a.issues.some((i) => i.code === 'too-short'))
    remaining.push(room.shape === 'U' ? 'Fix by making the stair room (and the void above) longer or wider, lowering the floor-to-floor height, or using winders at the turn.' : 'Fix by making the stair room (and the void above) longer, lowering the floor-to-floor height, or using a U-shaped stair.');
  return { actions, remaining };
}

export function allStairIssues(house) {
  const out = [];
  for (const floor of house.floors)
    for (const room of floor.rooms)
      if (room.type === 'stairs') for (const i of analyzeStairs(house, floor, room).issues) out.push({ floor, room, ...i });
  return out;
}
