// Free-form site shapes. A site element can carry `points` ([[x, y], …]):
//   plot           → closed polygon (irregular plot boundary)
//   driveway, path → centre line of a curved road/path, with `width`
// x/y/w/h are kept as the bounding box so everything that works with rectangles still does.
import { round } from './geometry.js';

export const SHAPED = { plot: 'polygon', driveway: 'line', path: 'line' };
export const isShaped = (el) => Array.isArray(el.points) && el.points.length >= 2 && el.type in SHAPED;

// Catmull-Rom spline through the points, sampled (open line or closed loop).
export function smooth(points, closed = false, steps = 10) {
  const n = points.length;
  if (n < 3 && !closed) return points.map((p) => [...p]);
  const at = (i) => (closed ? points[(i + n) % n] : points[Math.min(Math.max(i, 0), n - 1)]);
  const out = [];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  if (!closed) out.push([...points[n - 1]]);
  return out;
}

export const polylineLength = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export const polygonPerimeter = (pts) => polylineLength([...pts, pts[0]]);

// Area and length figures of a site element, whatever its shape.
export function measure(el) {
  if (!isShaped(el)) return { area: el.w * el.h, perimeter: 2 * (el.w + el.h), length: Math.max(el.w, el.h) };
  if (SHAPED[el.type] === 'polygon') return { area: polygonArea(el.points), perimeter: polygonPerimeter(el.points) };
  const length = polylineLength(smooth(el.points));
  return { length, area: length * (el.width ?? 3) };
}

// Keep x/y/w/h equal to the bounding box of the shape.
export function syncBox(el) {
  if (!isShaped(el)) return el;
  const pad = SHAPED[el.type] === 'line' ? (el.width ?? 3) / 2 : 0;
  const pts = SHAPED[el.type] === 'line' ? smooth(el.points) : el.points;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  el.x = round(Math.min(...xs) - pad);
  el.y = round(Math.min(...ys) - pad);
  el.w = round(Math.max(...xs) + pad - el.x);
  el.h = round(Math.max(...ys) + pad - el.y);
  return el;
}

// Turn a rectangle into an editable shape (and back).
export function toShape(el) {
  if (SHAPED[el.type] === 'polygon') {
    el.points = [[el.x, el.y], [el.x + el.w, el.y], [el.x + el.w, el.y + el.h], [el.x, el.y + el.h]];
  } else {
    const along = el.h >= el.w; // centre line along the longer side
    el.width = round(along ? el.w : el.h);
    el.points = along
      ? [[el.x + el.w / 2, el.y], [el.x + el.w / 2, el.y + el.h / 2], [el.x + el.w / 2, el.y + el.h]]
      : [[el.x, el.y + el.h / 2], [el.x + el.w / 2, el.y + el.h / 2], [el.x + el.w, el.y + el.h / 2]];
  }
  el.points = el.points.map(([x, y]) => [round(x), round(y)]);
  return syncBox(el);
}

export function toRect(el) {
  syncBox(el);
  delete el.points;
  delete el.width;
  return el;
}

export function translate(el, dx, dy) {
  el.points = el.points.map(([x, y]) => [round(x + dx), round(y + dy)]);
  return syncBox(el);
}

// Left/right edges of a road of the given width along a sampled centre line (for 3D).
export function ribbon(pts, width) {
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[Math.min(i + 1, pts.length - 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    left.push([pts[i][0] + (nx * width) / 2, pts[i][1] + (ny * width) / 2]);
    right.push([pts[i][0] - (nx * width) / 2, pts[i][1] - (ny * width) / 2]);
  }
  return { left, right };
}

// SVG path of a smooth line/loop.
export function svgPath(points, closed = false) {
  const pts = smooth(points, closed);
  return `M${pts.map(([x, y]) => `${Math.round(x * 1000) / 1000} ${Math.round(y * 1000) / 1000}`).join(' L')}${closed ? ' Z' : ''}`;
}
