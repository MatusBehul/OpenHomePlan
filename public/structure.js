// Rough structural sanity checks for the concept stage. They flag things the
// structural engineer will ask about; they are not a structural calculation.
import { floorWalls } from './walls.js';
import { curvedWalls, arcSegments } from './geometry.js';
import { sortedFloors } from './stairs.js';

export const DEFAULT_STRUCTURE_RULES = {
  maxSlabSpan: 6.0, // m between load-bearing walls for an ordinary floor slab
  minUnsupported: 0.3, // m of load-bearing wall without support below before we warn
};

export const structureRules = (house) => ({ ...DEFAULT_STRUCTURE_RULES, ...(house.rules?.structure || {}) });

function bearingSegments(house, floor) {
  const { inner, outer } = floorWalls(house, floor);
  // curved walls of round rooms carry like outside walls: as short horizontal/vertical pieces
  const curved = curvedWalls(floor).flatMap(({ shape }) =>
    arcSegments(shape, 0.2).map((g) => {
      const horizontal = Math.abs(g.p1[0] - g.p0[0]) >= Math.abs(g.p1[1] - g.p0[1]);
      const [a, b] = horizontal ? [g.p0[0], g.p1[0]] : [g.p0[1], g.p1[1]];
      return { horizontal, coord: horizontal ? g.mid[1] : g.mid[0], from: Math.min(a, b) - 0.02, to: Math.max(a, b) + 0.02 };
    }),
  );
  return [...outer, ...inner].filter((w) => w.props.loadBearing && w.props.type === 'wall').concat(curved);
}

// Distance between the nearest load-bearing walls on either side of a point, along one axis.
function span(segments, x, y, alongX) {
  let lo = -Infinity;
  let hi = Infinity;
  for (const s of segments) {
    // walls perpendicular to the ray: vertical walls stop a ray along x
    if (s.horizontal === alongX) continue;
    const across = alongX ? y : x;
    if (across < s.from - 1e-6 || across > s.to + 1e-6) continue;
    const at = s.coord;
    const p = alongX ? x : y;
    if (at <= p) lo = Math.max(lo, at);
    else hi = Math.min(hi, at);
  }
  return hi - lo;
}

function covered(segments, w) {
  // how much of `w` lies on top of load-bearing walls in `segments`
  const parts = segments
    .filter((s) => s.horizontal === w.horizontal && Math.abs(s.coord - w.coord) < 0.05)
    .map((s) => [Math.max(s.from, w.from), Math.min(s.to, w.to)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur = w.from;
  for (const [a, b] of parts) {
    if (b <= cur) continue;
    total += b - Math.max(a, cur);
    cur = b;
  }
  return total;
}

export function structureIssues(house) {
  const rules = structureRules(house);
  const floors = sortedFloors(house);
  const issues = [];
  floors.forEach((floor, i) => {
    const bearing = bearingSegments(house, floor);
    const above = floors[i + 1];
    // 1) the slab above each room (only where another floor sits on top)
    if (above) {
      for (const r of floor.rooms) {
        if (r.type === 'void' || r.type === 'stairs') continue;
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const sx = span(bearing, cx, cy, true);
        const sy = span(bearing, cx, cy, false);
        const best = Math.min(sx, sy);
        if (!Number.isFinite(best))
          issues.push({ floor, target: `${floor.id}/${r.id}`, text: `${r.name}: no load-bearing walls on opposite sides to carry the slab above.` });
        else if (best > rules.maxSlabSpan + 1e-6)
          issues.push({
            floor,
            target: `${floor.id}/${r.id}`,
            text: `${r.name}: the slab above spans ${best.toFixed(1)} m between load-bearing walls (max ${rules.maxSlabSpan} m). Make a wall load-bearing or plan a beam.`,
          });
      }
    }
    // 2) load-bearing walls need something load-bearing (or a beam) underneath
    const below = floors[i - 1];
    if (below) {
      const support = bearingSegments(house, below);
      const { inner } = floorWalls(house, floor);
      for (const w of inner.filter((x) => x.props.loadBearing)) {
        const missing = w.to - w.from - covered(support, w);
        if (missing > rules.minUnsupported)
          issues.push({
            floor,
            target: `${floor.id}/${w.key}`,
            text: `Load-bearing wall ${w.desc.between.map((id) => floor.rooms.find((r) => r.id === id)?.name).join(' | ')} has ${missing.toFixed(1)} m with no load-bearing wall below. It needs a beam or a wall underneath.`,
          });
      }
    }
  });
  return issues;
}
