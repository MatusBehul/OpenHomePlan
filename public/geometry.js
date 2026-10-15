// Pure geometry helpers shared by the 2D plan and the 3D model.
// Rooms are axis-aligned rectangles in metres (wall axis to wall axis).

export const STEP = 0.05; // analysis grid; all dimensions are rounded to this

export const LIVING_RANGE = [150, 200];
export const livingRange = (house) => house.targets?.livingArea || LIVING_RANGE;

// rounds to a step and strips binary noise (2.4000000000000004 → 2.4)
export const round = (v, step = 0.01) => Math.round(Math.round(v / step) * step * 1e6) / 1e6;
export const fmt = (v, d = 2) => (Math.round(v * 100) / 100).toFixed(d).replace(/\.?0+$/, '') || '0';
export const fmtArea = (v) => (Math.round(v * 10) / 10).toFixed(1);

export function bbox(items) {
  if (!items.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.min(...items.map((r) => r.x));
  const y1 = Math.min(...items.map((r) => r.y));
  const x2 = Math.max(...items.map((r) => r.x + r.w));
  const y2 = Math.max(...items.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ---------- round rooms ----------
// room.round: 'N' | 'S' | 'E' | 'W' rounds that side of the room's rectangle into a half
// ellipse as wide as the room (a bay or apse; a deeper room becomes a D-shaped tower), 'all'
// makes the room an ellipse (a circle when w = h) inscribed in its rectangle.
// shape: centre cx/cy, semi-axes ax (x) / by (y) and the angle range t0..t1 of the curve,
// with points (cx + ax·cos t, cy + by·sin t).
export function roundShape(r) {
  const s = r?.round;
  if (!s) return null;
  if (s === 'all') return { kind: 'all', side: null, cx: r.x + r.w / 2, cy: r.y + r.h / 2, ax: r.w / 2, by: r.h / 2, t0: 0, t1: 2 * Math.PI };
  if (s === 'N' || s === 'S') {
    const c = Math.min(r.h, r.w / 2);
    return { kind: 'side', side: s, cx: r.x + r.w / 2, cy: s === 'S' ? r.y + r.h - c : r.y + c, ax: r.w / 2, by: c, t0: s === 'S' ? 0 : Math.PI, t1: s === 'S' ? Math.PI : 2 * Math.PI };
  }
  if (s === 'E' || s === 'W') {
    const c = Math.min(r.w, r.h / 2);
    return { kind: 'side', side: s, cx: s === 'E' ? r.x + r.w - c : r.x + c, cy: r.y + r.h / 2, ax: c, by: r.h / 2, t0: s === 'E' ? -Math.PI / 2 : Math.PI / 2, t1: s === 'E' ? Math.PI / 2 : 1.5 * Math.PI };
  }
  return null;
}
export const arcPoint = (sh, t) => [sh.cx + sh.ax * Math.cos(t), sh.cy + sh.by * Math.sin(t)];
// is (x, y) in the rounded part of the room (beyond its straight part)?
const inCap = (sh, x, y) => sh.kind === 'all' || (sh.side === 'S' ? y > sh.cy : sh.side === 'N' ? y < sh.cy : sh.side === 'E' ? x > sh.cx : x < sh.cx);
// is (x, y) inside the room, honouring a rounded shape?
export function inRoom(r, x, y) {
  if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return false;
  const sh = roundShape(r);
  if (!sh || !inCap(sh, x, y)) return true;
  return ((x - sh.cx) / sh.ax) ** 2 + ((y - sh.cy) / sh.by) ** 2 <= 1 + 1e-9;
}
// Is (x, y) on (within a couple of grid cells of) the curved part of the shape?
function nearCurve(sh, x, y) {
  if (!inCap(sh, x, y) && sh.kind !== 'all') return false;
  const v = Math.hypot((x - sh.cx) / sh.ax, (y - sh.cy) / sh.by);
  return Math.abs(v - 1) * Math.min(sh.ax, sh.by) < 2 * STEP;
}

// Is (x, y) in the rounded part of a round room?
export const inRoundPart = (r, x, y) => {
  const sh = roundShape(r);
  return !!sh && inCap(sh, x, y) && inRoom(r, x, y);
};

// Length of the curved wall (Ramanujan's approximation for the ellipse perimeter).
export function arcLength(sh) {
  const { ax: a, by: b } = sh;
  const full = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  return sh.kind === 'all' ? full : full / 2;
}
// The curve as short chords (for walls, plans and DXF): [{ t0, t1, p0, p1, mid, len, angle }].
export function arcSegments(sh, step = 0.2) {
  const n = Math.max(8, Math.ceil(arcLength(sh) / step));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = sh.t0 + ((sh.t1 - sh.t0) * i) / n;
    const t1 = sh.t0 + ((sh.t1 - sh.t0) * (i + 1)) / n;
    const p0 = arcPoint(sh, t0);
    const p1 = arcPoint(sh, t1);
    out.push({ t0, t1, p0, p1, mid: [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2], len: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), angle: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) });
  }
  return out;
}
// Outline of a room as a polygon (its rectangle, with the rounded side as an arc).
export function roomOutline(r, step = 0.15) {
  const sh = roundShape(r);
  const { x, y, w, h } = r;
  if (!sh) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const n = Math.max(12, Math.ceil(arcLength(sh) / step));
  const arc = Array.from({ length: n + 1 }, (_, i) => arcPoint(sh, sh.t0 + ((sh.t1 - sh.t0) * i) / n));
  if (sh.kind === 'all') return arc.slice(0, -1);
  const start = { S: [[x, y], [x + w, y]], N: [[x + w, y + h], [x, y + h]], E: [[x, y + h], [x, y]], W: [[x + w, y], [x + w, y + h]] }[sh.side];
  return [...start, ...arc];
}

// Curved walls of a floor: one per round room.
// `exterior`: nothing else lies just outside the middle of the curve.
export function curvedWalls(floor) {
  return floor.rooms
    .map((r, idx) => ({ room: r, idx, shape: roundShape(r) }))
    .filter((c) => c.shape)
    .map((c) => {
      const sh = c.shape;
      const [mx, my] = arcPoint(sh, (sh.t0 + sh.t1) / 2);
      const out = [mx + Math.sign(mx - sh.cx) * 0.3, my + Math.sign(my - sh.cy) * 0.3];
      return { ...c, length: arcLength(sh), exterior: !floor.rooms.some((o) => o !== c.room && inRoom(o, out[0], out[1])) };
    });
}

export const area = (r) => {
  const sh = roundShape(r);
  if (!sh) return r.w * r.h;
  if (sh.kind === 'all') return Math.PI * sh.ax * sh.by;
  const straight = sh.side === 'N' || sh.side === 'S' ? r.w * (r.h - sh.by) : r.h * (r.w - sh.ax);
  return straight + (Math.PI * sh.ax * sh.by) / 2;
};

// Rooms that count towards living area (the stair void is open space, not floor).
export const countsAsArea = (r) => r.type !== 'void';

export function floorArea(floor) {
  return floor.rooms.filter(countsAsArea).reduce((s, r) => s + area(r), 0);
}

// Rasterise a floor onto a grid with a 1-cell margin. Each cell stores how many
// rooms cover it and the index of the (last) room covering it.
export function rasterize(floor) {
  const rooms = floor.rooms;
  const b = bbox(rooms);
  const ox = Math.round(b.x / STEP) - 1;
  const oy = Math.round(b.y / STEP) - 1;
  const nx = Math.round(b.w / STEP) + 2;
  const ny = Math.round(b.h / STEP) + 2;
  const count = new Uint8Array(nx * ny);
  const owner = new Int32Array(nx * ny).fill(-1);
  const capOwner = new Int32Array(nx * ny).fill(-1); // cells in the rounded part of a round room
  rooms.forEach((r, idx) => {
    const i1 = Math.round(r.x / STEP) - ox;
    const j1 = Math.round(r.y / STEP) - oy;
    const i2 = Math.round((r.x + r.w) / STEP) - ox;
    const j2 = Math.round((r.y + r.h) / STEP) - oy;
    const sh = roundShape(r);
    for (let j = j1; j < j2; j++)
      for (let i = i1; i < i2; i++) {
        if (sh) {
          const x = (i + ox + 0.5) * STEP;
          const y = (j + oy + 0.5) * STEP;
          if (!inRoom(r, x, y)) continue;
          if (inCap(sh, x, y)) capOwner[j * nx + i] = idx;
        }
        const k = j * nx + i;
        if (count[k] < 255) count[k]++;
        owner[k] = idx;
      }
  });
  return { ox, oy, nx, ny, count, owner, capOwner };
}

// Overlapping area and enclosed gaps (holes inside the building outline), in m².
export function checkFloor(floor) {
  if (!floor.rooms.length) return { overlap: 0, gaps: 0, covered: 0 };
  const { nx, ny, count } = rasterize(floor);
  let overlap = 0;
  let covered = 0;
  for (const c of count) {
    if (c > 1) overlap++;
    if (c > 0) covered++;
  }
  // Flood fill empty cells from the outer margin; empty cells not reached are holes.
  const seen = new Uint8Array(nx * ny);
  const stack = [0];
  seen[0] = 1;
  while (stack.length) {
    const k = stack.pop();
    const i = k % nx;
    const j = (k - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const n = b * nx + a;
      if (!seen[n] && count[n] === 0) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  let gaps = 0;
  for (let k = 0; k < count.length; k++) if (count[k] === 0 && !seen[k]) gaps++;
  const cell = STEP * STEP;
  return { overlap: overlap * cell, gaps: gaps * cell, covered: covered * cell };
}

// Merge unit edges into maximal straight segments.
function mergeEdges(units) {
  const groups = new Map();
  for (const e of units) {
    const key = `${e.side}|${e.line}|${e.a ?? ''}|${e.b ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((p, q) => p.from - q.from);
    let cur = null;
    for (const e of list) {
      if (cur && e.from === cur.to) cur.to = e.to;
      else {
        if (cur) out.push(cur);
        cur = { ...e };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function toSegment(e, ox, oy) {
  // side N/S: horizontal edge at grid row `line`, from..to along x; E/W vertical.
  const horiz = e.side === 'N' || e.side === 'S';
  const seg = horiz
    ? { x1: (e.from + ox) * STEP, y1: (e.line + oy) * STEP, x2: (e.to + ox) * STEP, y2: (e.line + oy) * STEP }
    : { x1: (e.line + ox) * STEP, y1: (e.from + oy) * STEP, x2: (e.line + ox) * STEP, y2: (e.to + oy) * STEP };
  for (const k of ['x1', 'y1', 'x2', 'y2']) seg[k] = round(seg[k]);
  return { ...seg, side: e.side, horizontal: horiz, length: round(horiz ? seg.x2 - seg.x1 : seg.y2 - seg.y1) };
}

// Exterior wall axes. `side` is the facade the wall faces (N = outside is to the north).
export function exteriorEdges(floor) {
  if (!floor.rooms.length) return [];
  const { ox, oy, nx, ny, count, capOwner } = rasterize(floor);
  const shapes = floor.rooms.map(roundShape);
  const filled = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && count[j * nx + i] > 0;
  const units = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (!filled(i, j)) continue;
      // edges along a curve are left out: the curved wall is drawn as an arc (curvedWalls)
      const c = capOwner[j * nx + i];
      const sh = c >= 0 ? shapes[c] : null;
      const straight = (x, y) => !sh || !nearCurve(sh, (x + ox) * STEP, (y + oy) * STEP);
      if (!filled(i, j - 1) && straight(i + 0.5, j)) units.push({ side: 'N', line: j, from: i, to: i + 1 });
      if (!filled(i, j + 1) && straight(i + 0.5, j + 1)) units.push({ side: 'S', line: j + 1, from: i, to: i + 1 });
      if (!filled(i - 1, j) && straight(i, j + 0.5)) units.push({ side: 'W', line: i, from: j, to: j + 1 });
      if (!filled(i + 1, j) && straight(i + 1, j + 0.5)) units.push({ side: 'E', line: i + 1, from: j, to: j + 1 });
    }
  return mergeEdges(units).map((e) => toSegment(e, ox, oy));
}

// Interior wall axes between two different rooms. `rooms` gives the two room indices.
export function interiorEdges(floor) {
  if (!floor.rooms.length) return [];
  const { ox, oy, nx, ny, owner, capOwner } = rasterize(floor);
  const at = (i, j) => (i >= 0 && j >= 0 && i < nx && j < ny ? owner[j * nx + i] : -1);
  const shapes = floor.rooms.map(roundShape);
  // an edge next to the rounded part of a room, lying on its curve, is drawn as an arc instead
  const curved = (ci, cj, x, y) => {
    for (const [a, b] of [[ci[0], ci[1]], [cj[0], cj[1]]]) {
      const c = a >= 0 && b >= 0 && a < nx && b < ny ? capOwner[b * nx + a] : -1;
      if (c >= 0 && nearCurve(shapes[c], (x + ox) * STEP, (y + oy) * STEP)) return true;
    }
    return false;
  };
  const units = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const o = at(i, j);
      if (o < 0) continue;
      const s = at(i, j + 1);
      if (s >= 0 && s !== o && !curved([i, j], [i, j + 1], i + 0.5, j + 1)) units.push({ side: 'S', line: j + 1, from: i, to: i + 1, a: Math.min(o, s), b: Math.max(o, s) });
      const e = at(i + 1, j);
      if (e >= 0 && e !== o && !curved([i, j], [i + 1, j], i + 1, j + 0.5)) units.push({ side: 'E', line: i + 1, from: j, to: j + 1, a: Math.min(o, e), b: Math.max(o, e) });
    }
  return mergeEdges(units).map((e) => ({ ...toSegment(e, ox, oy), rooms: [e.a, e.b] }));
}

// Start of an exterior opening along its facade: absolute `x` (N/S facades) or `y`
// (E/W facades). Older data used `offset` from the floor's west/north end.
export function openingStart(floor, o) {
  const horiz = o.facade === 'N' || o.facade === 'S';
  const abs = horiz ? o.x : o.y;
  if (typeof abs === 'number') return abs;
  const b = bbox(floor.rooms);
  return (horiz ? b.x : b.y) + (o.offset ?? 0);
}

// Find where an opening sits: the outermost exterior wall on its facade that
// contains the opening's span.
export function placeOpening(floor, opening, edges = exteriorEdges(floor)) {
  const horiz = opening.facade === 'N' || opening.facade === 'S';
  const start = openingStart(floor, opening);
  const end = start + opening.width;
  const candidates = edges.filter((e) => {
    if (e.side !== opening.facade) return false;
    const [a, c] = horiz ? [e.x1, e.x2] : [e.y1, e.y2];
    return start >= a - 1e-6 && end <= c + 1e-6;
  });
  if (!candidates.length) return placeOnCurve(floor, opening, start, end);
  const outer = { N: (e) => e.y1, S: (e) => -e.y1, W: (e) => e.x1, E: (e) => -e.x1 }[opening.facade];
  candidates.sort((p, q) => outer(p) - outer(q));
  const e = candidates[0];
  return horiz
    ? { edge: e, x1: start, y1: e.y1, x2: end, y2: e.y1, horizontal: true, from: start, to: end }
    : { edge: e, x1: e.x1, y1: start, x2: e.x1, y2: end, horizontal: false, from: start, to: end };
}

// An opening on the curved wall of a round room, on the half facing its facade: the span
// [start, end] is measured along the facade as for straight walls; the result carries
// `curved` (the shape) and the angles t0..t1 of the span on the curve.
function placeOnCurve(floor, opening, start, end) {
  const horiz = opening.facade === 'N' || opening.facade === 'S';
  const sign = { S: 1, N: -1, E: 1, W: -1 }[opening.facade];
  for (const { room, shape: sh } of curvedWalls(floor)) {
    // the point of the curve's facade-facing half at along-coordinate v, and its angle
    const [c, half] = horiz ? [sh.cx, sh.ax] : [sh.cy, sh.by];
    if (start < c - half + 0.05 || end > c + half - 0.05) continue;
    const at = (v) => {
      const k = (v - c) / half;
      const across = sign * Math.sqrt(Math.max(0, 1 - k * k));
      return horiz ? Math.atan2(across, k) : Math.atan2(k, across);
    };
    const inArc = (t) => {
      const span = sh.t1 - sh.t0;
      const d = (((t - sh.t0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return d <= span + 1e-9;
    };
    const ts = [at(start), at((start + end) / 2), at(end)];
    if (!ts.every(inArc)) continue;
    // angles continuous within the arc
    const norm = (t) => sh.t0 + ((((t - sh.t0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
    const [t0, t1] = [norm(ts[0]), norm(ts[2])].sort((p, q) => p - q);
    const mid = arcPoint(sh, (t0 + t1) / 2);
    const edge = { curved: true, room: room.id, side: opening.facade, horizontal: horiz };
    return horiz
      ? { edge, curved: sh, t0, t1, x1: start, y1: mid[1], x2: end, y2: mid[1], horizontal: true, from: start, to: end }
      : { edge, curved: sh, t0, t1, x1: mid[0], y1: start, x2: mid[0], y2: end, horizontal: false, from: start, to: end };
  }
  return null;
}

export function totals(house) {
  const floors = house.floors.map((f) => {
    const check = checkFloor(f);
    return { id: f.id, name: f.name, net: floorArea(f), gross: check.covered, stray: strayOpenings(f).length, ...check };
  });
  const net = floors.reduce((s, f) => s + f.net, 0);
  const gross = floors.reduce((s, f) => s + f.gross, 0);
  const [lo, hi] = livingRange(house);
  return { floors, net, gross, inRange: net >= lo && net <= hi };
}

// ---------- walls ----------

const EPS = 1e-6;

// Every wall line (exterior and interior) merged into contiguous straight runs.
export function wallRuns(floor) {
  const segs = [...exteriorEdges(floor), ...interiorEdges(floor)].map((e) =>
    e.horizontal ? { horizontal: true, coord: e.y1, from: e.x1, to: e.x2 } : { horizontal: false, coord: e.x1, from: e.y1, to: e.y2 },
  );
  const groups = new Map();
  for (const sg of segs) {
    const key = `${sg.horizontal}|${sg.coord}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sg);
  }
  const runs = [];
  for (const list of groups.values()) {
    list.sort((p, q) => p.from - q.from);
    let cur = null;
    for (const sg of list) {
      if (cur && sg.from <= cur.to + EPS) cur.to = Math.max(cur.to, sg.to);
      else {
        if (cur) runs.push(cur);
        cur = { ...sg };
      }
    }
    if (cur) runs.push(cur);
  }
  return runs;
}

// The run a room edge belongs to. side: 'n' | 's' | 'e' | 'w'.
export function runForEdge(floor, room, side, runs = wallRuns(floor)) {
  const horizontal = side === 'n' || side === 's';
  const coord = round({ n: room.y, s: room.y + room.h, w: room.x, e: room.x + room.w }[side]);
  const [a, b] = horizontal ? [room.x, room.x + room.w] : [room.y, room.y + room.h];
  return runs.find((r) => r.horizontal === horizontal && Math.abs(r.coord - coord) < 0.01 && r.from < b - EPS && r.to > a + EPS) || null;
}

// Rooms with an edge on the run. `end: true` = the room ends at the line (it lies
// north/west of it), `end: false` = the room starts at the line.
export function roomsOnRun(floor, run) {
  const out = [];
  for (const room of floor.rooms) {
    const [a, b] = run.horizontal ? [room.x, room.x + room.w] : [room.y, room.y + room.h];
    if (!(a < run.to - EPS && b > run.from + EPS)) continue;
    const start = run.horizontal ? room.y : room.x;
    const size = run.horizontal ? room.h : room.w;
    if (Math.abs(start - run.coord) < 0.01) out.push({ room, end: false, orig: { ...room } });
    else if (Math.abs(start + size - run.coord) < 0.01) out.push({ room, end: true, orig: { ...room } });
  }
  return out;
}

// How far a wall can move before one of its rooms gets narrower than `min`.
export function wallLimits(run, attached, min = 0.5) {
  let lo = -Infinity;
  let hi = Infinity;
  for (const { end, orig } of attached) {
    const start = run.horizontal ? orig.y : orig.x;
    const size = run.horizontal ? orig.h : orig.w;
    if (end) lo = Math.max(lo, start + min);
    else hi = Math.min(hi, start + size - min);
  }
  return [lo, hi];
}

export function applyWall(run, attached, coord) {
  for (const { room, end, orig } of attached) {
    if (run.horizontal) {
      if (end) room.h = round(coord - orig.y);
      else Object.assign(room, { y: round(coord), h: round(orig.y + orig.h - coord) });
    } else if (end) room.w = round(coord - orig.x);
    else Object.assign(room, { x: round(coord), w: round(orig.x + orig.w - coord) });
  }
}

// ---------- interior doors ----------

export const DOOR_TYPES = { door: 'Hinged door', sliding: 'Sliding door', opening: 'Open passage (no door)' };

// Where an interior door sits: on the wall shared by its two rooms, `offset` metres
// from the west/north end of that shared wall. Returns null if the rooms no longer touch.
export function placeDoor(floor, door, inner = interiorEdges(floor)) {
  const ia = floor.rooms.findIndex((r) => r.id === door.between?.[0]);
  const ib = floor.rooms.findIndex((r) => r.id === door.between?.[1]);
  if (ia < 0 || ib < 0) return null;
  const segs = inner.filter((e) => e.rooms.includes(ia) && e.rooms.includes(ib)).sort((p, q) => q.length - p.length);
  if (!segs.length) return null;
  const e = segs[0];
  const [a, b] = e.horizontal ? [e.x1, e.x2] : [e.y1, e.y2];
  const len = b - a;
  const width = Math.min(door.width ?? 0.9, Math.max(len - 0.1, 0.3));
  const from = a + Math.min(Math.max(door.offset ?? 0, 0), Math.max(len - width, 0));
  return { edge: e, horizontal: e.horizontal, coord: e.horizontal ? e.y1 : e.x1, from, to: from + width, wallFrom: a, wallTo: b };
}

// Pairs of rooms that share a wall, as [roomIndexA, roomIndexB].
export function neighbours(floor, roomIndex, inner = interiorEdges(floor)) {
  const set = new Set();
  for (const e of inner) if (e.rooms.includes(roomIndex)) set.add(e.rooms[0] === roomIndex ? e.rooms[1] : e.rooms[0]);
  return [...set];
}

// Split [a, b] around the given spans (sorted or not), returning the solid pieces.
export function solidPieces(a, b, spans) {
  const out = [];
  let cur = a;
  for (const [s, e] of [...spans].sort((p, q) => p[0] - q[0])) {
    if (s > cur + EPS) out.push([cur, Math.min(s, b)]);
    cur = Math.max(cur, e);
  }
  if (b > cur + EPS) out.push([cur, b]);
  return out;
}

// Doors/windows that no longer sit on a wall (after rooms were moved).
export function strayOpenings(floor) {
  const edges = exteriorEdges(floor);
  const inner = interiorEdges(floor);
  return [
    ...(floor.openings || []).filter((o) => !placeOpening(floor, o, edges)),
    ...(floor.doors || []).filter((d) => !placeDoor(floor, d, inner)),
  ];
}

// The floor the site plan is drawn on: the lowest floor at or above terrain.
export function groundFloor(house) {
  const sorted = [...house.floors].sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  return sorted.find((f) => (f.elevation ?? 0) >= -0.5) || sorted[0];
}
