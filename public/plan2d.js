import { roomColor, siteColor } from './catalog.js';
import {
  bbox, exteriorEdges, interiorEdges, placeOpening, placeDoor, wallRuns, runForEdge, roomsOnRun, wallLimits, applyWall,
  solidPieces, groundFloor, fmt, fmtArea, round, area, roundShape, roomOutline, curvedWalls, arcSegments, arcPoint, inRoom,
} from './geometry.js';
import { analyzeStairs, stairSteps } from './stairs.js';
import { isHinged } from './model.js';
import { isShaped, SHAPED, svgPath, measure, smooth, translate, syncBox } from './shapes.js';
import { roofZones, ROOF_TYPES, openEdges, isTerraceOnPosts, sitePosts, POST_SIZE, terraceRailEdges } from './roof.js';
import { facadeSettings, shutterWidths } from './facade.js';
import { floorWalls, wallAt } from './walls.js';
import { structureIssues } from './structure.js';
import { footprint } from './items.js';
import { pointGroup } from './utilities.js';
import { itemSymbol, pointSymbol, finishFill } from './symbols.js';

const NS = 'http://www.w3.org/2000/svg';
const SNAP = 0.25;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = (v) => Math.round(v * 1000) / 1000; // compact numbers in SVG markup

// opts (for printing): { static: true, floor, viewBox: {x,y,w,h}, px (metres per line unit),
// layers } draws one fixed plan without any interaction.
// "STREET" written outside the plot on the side the street is (plot.street: N/S/E/W, default N)
function streetLabel(s, px) {
  const side = s.street || 'N';
  const name = { N: 'north', S: 'south', E: 'east', W: 'west' }[side];
  const [x, y, rot] = {
    N: [s.x + s.w / 2, s.y - 6 * px, 0],
    S: [s.x + s.w / 2, s.y + s.h + 14 * px, 0],
    W: [s.x - 6 * px, s.y + s.h / 2, -90],
    E: [s.x + s.w + 6 * px, s.y + s.h / 2, 90],
  }[side];
  return `<text x="${n(x)}" y="${n(y)}" transform="rotate(${rot} ${n(x)} ${n(y)})" font-size="${n(11 * px)}" fill="#777" text-anchor="middle" class="label">STREET (${name})</text>`;
}

export function createPlan(container, store, opts = {}) {
  container.innerHTML = `
    <svg xmlns="${NS}" preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="planks" patternUnits="userSpaceOnUse" width="0.16" height="10">
          <rect width="0.16" height="10" fill="#e6cfa9"/><line x1="0" y1="0" x2="0" y2="10" stroke="#cdb185" stroke-width="0.02"/>
        </pattern>
        <pattern id="glass" patternUnits="userSpaceOnUse" width="0.6" height="0.6" patternTransform="rotate(45)">
          <rect width="0.6" height="0.6" fill="#e3f3e6"/><line x1="0" y1="0" x2="0" y2="0.6" stroke="#9ccaa6" stroke-width="0.03"/>
        </pattern>
        <pattern id="water" patternUnits="userSpaceOnUse" width="1" height="0.5">
          <rect width="1" height="0.5" fill="#8fd0ea"/><path d="M0 .25 q .25 -.12 .5 0 t .5 0" fill="none" stroke="#bfe6f5" stroke-width="0.04"/>
        </pattern>
        <pattern id="gravel" patternUnits="userSpaceOnUse" width="0.5" height="0.5">
          <rect width="0.5" height="0.5" fill="#d3cec6"/><circle cx=".12" cy=".15" r=".03" fill="#bdb7ad"/><circle cx=".37" cy=".38" r=".03" fill="#bdb7ad"/>
        </pattern>
      </defs>
      <g id="world"></g>
    </svg>
    ${opts.static ? '' : `<svg class="overlay" style="position:absolute;right:14px;top:12px;width:56px;height:70px;pointer-events:none">
      <g transform="translate(28,34)">
        <circle r="20" fill="rgba(255,255,255,.85)" stroke="#999" stroke-width="1"/>
        <path d="M0,-17 L7,8 L0,3 L-7,8 Z" fill="#23262b"/>
        <text y="-23" text-anchor="middle" font-size="11" font-weight="700" fill="#23262b">N</text>
      </g>
    </svg>
    <div class="legend">
      <span><i style="background:#23262b;height:5px"></i>Load-bearing</span>
      <span><i style="background:#8a8a8a;height:3px"></i>Partition</span>
      <span><i style="background:#555;height:1px"></i>Railing</span>
      <span><i style="background:#4a90d9;height:2px"></i>Glass</span>
      <span><i style="border-top:1px dotted #999;height:0"></i>Open</span>
      <span><i style="border-top:3px dashed #a0591c;height:0"></i>Beam</span>
    </div>
    <svg class="scalebar" style="position:absolute;right:14px;bottom:10px;height:26px;width:140px;pointer-events:none"></svg>`}`;
  const svg = container.querySelector('svg');
  const world = svg.querySelector('#world');
  const scalebar = container.querySelector('.scalebar');
  let vb = { x: 0, y: 0, w: 10, h: 10 };
  let drag = null;
  let lastVertex = null;
  let runs = [];
  const layers = opts.layers || store.layers;
  let lastFloor = null;

  // metres per screen pixel, accounting for preserveAspectRatio="meet"
  function mpp() {
    if (opts.px) return opts.px;
    const { width, height } = svg.getBoundingClientRect();
    if (!width || !height) return 0.05;
    return Math.max(vb.w / width, vb.h / height);
  }

  function setViewBox() {
    svg.setAttribute('viewBox', `${n(vb.x)} ${n(vb.y)} ${n(vb.w)} ${n(vb.h)}`);
  }

  function fit() {
    if (opts.viewBox) {
      vb = { ...opts.viewBox };
      return setViewBox();
    }
    const floor = store.floor();
    const isGround = floor === groundFloor(store.house);
    const plot = store.house.site.find((s) => s.type === 'plot');
    const items = isGround ? [...floor.rooms, ...store.house.site] : floor.rooms;
    const b = isGround && plot ? bbox([plot, ...items]) : bbox(items);
    const m = isGround ? 2.5 : 3.5;
    vb = { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
    setViewBox();
  }

  function toWorld(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  }

  // ---------- drawing ----------

  function dimLine(x1, y1, x2, y2, label, px, offsetDir) {
    // straight dimension line with ticks; offsetDir places the text (-1 above/left, +1 below/right)
    const t = 4 * px;
    const horiz = y1 === y2;
    const fs = 10 * px;
    const tick = (x, y) => `<line x1="${n(x - t)}" y1="${n(y + t)}" x2="${n(x + t)}" y2="${n(y - t)}"/>`;
    const tx = horiz ? (x1 + x2) / 2 : x1 + offsetDir * 4 * px;
    const ty = horiz ? y1 + offsetDir * 4 * px : (y1 + y2) / 2;
    const rot = horiz ? '' : ` transform="rotate(-90 ${n(tx)} ${n(ty)})"`;
    const baseline = offsetDir < 0 ? 'auto' : 'hanging';
    return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"/>${tick(x1, y1)}${tick(x2, y2)}
      <text x="${n(tx)}" y="${n(ty)}" font-size="${n(fs)}" text-anchor="middle" dominant-baseline="${horiz ? baseline : offsetDir < 0 ? 'auto' : 'hanging'}"${rot} stroke="none" fill="#555">${label}</text>`;
  }

  function dimensions(floor, px) {
    const b = bbox(floor.rooms);
    const xs = [...new Set(floor.rooms.flatMap((r) => [round(r.x), round(r.x + r.w)]))].sort((a, c) => a - c);
    const ys = [...new Set(floor.rooms.flatMap((r) => [round(r.y), round(r.y + r.h)]))].sort((a, c) => a - c);
    const out = [];
    // chain + overall on the north side
    const yChain = b.y - 0.9;
    const yAll = b.y - 1.7;
    for (let i = 0; i < xs.length - 1; i++) out.push(dimLine(xs[i], yChain, xs[i + 1], yChain, fmt(xs[i + 1] - xs[i]), px, -1));
    out.push(dimLine(b.x, yAll, b.x + b.w, yAll, fmt(b.w), px, -1));
    // chain + overall on the east side (west is taken by the garage)
    const xChain = b.x + b.w + 0.9;
    const xAll = b.x + b.w + 1.7;
    for (let i = 0; i < ys.length - 1; i++) out.push(dimLine(xChain, ys[i], xChain, ys[i + 1], fmt(ys[i + 1] - ys[i]), px, 1));
    out.push(dimLine(xAll, b.y, xAll, b.y + b.h, fmt(b.h), px, 1));
    // extension lines
    const ext = [
      ...xs.map((x) => `<line x1="${n(x)}" y1="${n(b.y - 0.35)}" x2="${n(x)}" y2="${n(yAll - 0.15)}"/>`),
      ...ys.map((y) => `<line x1="${n(b.x + b.w + 0.35)}" y1="${n(y)}" x2="${n(xAll + 0.15)}" y2="${n(y)}"/>`),
    ];
    return `<g stroke="#8a8a8a" stroke-width="${n(0.8 * px)}" fill="none">${ext.join('')}${out.join('')}</g>`;
  }

  function labelBlock(cx, cy, lines, px, maxW, maxH = Infinity) {
    // lines: [{text, size, weight, color}] in screen px. Long lines wrap by word, then
    // shrink; trailing lines are dropped when the item is too short to hold them.
    const availW = maxW / px - 8;
    const availH = maxH / px - 6;
    const width = (t, size) => t.length * size * 0.56;
    const rows = [];
    lines.forEach((l, i) => {
      let parts = [l.text];
      const words = l.text.split(' ');
      // only the name (first line) wraps; numbers shrink or get dropped instead
      if (i === 0 && width(l.text, l.size) > availW && words.length > 1) {
        parts = [];
        let cur = '';
        for (const w of words) {
          const t = cur ? `${cur} ${w}` : w;
          if (cur && width(t, l.size) > availW) {
            parts.push(cur);
            cur = w;
          } else cur = t;
        }
        parts.push(cur);
      }
      const widest = Math.max(...parts.map((t) => width(t, l.size)));
      const size = widest > availW ? Math.max(7, (l.size * availW) / widest) : l.size;
      parts.forEach((t) => rows.push({ ...l, text: t, size }));
    });
    while (rows.length > 1 && rows.reduce((sum, r) => sum + r.size * 1.2, 0) > availH) rows.pop();
    const total = rows.reduce((sum, r) => sum + r.size * 1.2 * px, 0);
    let y = cy - total / 2;
    return rows
      .map((r) => {
        const fs = r.size * px;
        y += fs * 1.2;
        return `<text class="label" x="${n(cx)}" y="${n(y - fs * 0.25)}" font-size="${n(fs)}" font-weight="${r.weight || 400}" text-anchor="middle" fill="${r.color || '#23262b'}">${esc(r.text)}</text>`;
      })
      .join('');
  }

  function commentMarker(item, target, px) {
    const count = store.openComments(target);
    if (!count) return '';
    const r = 8 * px;
    const cx = item.x + item.w - r - 3 * px;
    const cy = item.y + r + 3 * px;
    return `<g class="label"><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="#db2777"/>
      <text x="${n(cx)}" y="${n(cy + 3.5 * px)}" font-size="${n(10 * px)}" font-weight="700" fill="#fff" text-anchor="middle">${count}</text></g>`;
  }

  function siteElement(s, px) {
    const target = `site/${s.id}`;
    const fill = { terrace: 'url(#planks)', greenhouse: 'url(#glass)', pool: 'url(#water)', path: 'url(#gravel)' }[s.type] || siteColor(s.type);
    const lw = 1 * px;
    let shape;
    if (s.type === 'plot' && isShaped(s)) {
      const d = `M${s.points.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')} Z`;
      const m = measure(s);
      const low = s.points.reduce((a, p) => (p[1] > a[1] ? p : a));
      return `<g class="site-el plot" data-target="${target}">
        <path d="${d}" fill="${fill}" pointer-events="none"/>
        <path d="${d}" fill="none" stroke="#5b8a3c" stroke-width="${n(1.5 * px)}" stroke-dasharray="${n(10 * px)} ${n(4 * px)} ${n(2 * px)} ${n(4 * px)}"/>
        <path d="${d}" fill="none" stroke="transparent" stroke-width="${n(12 * px)}"/>
        <text x="${n(low[0])}" y="${n(low[1] + 14 * px)}" font-size="${n(11 * px)}" fill="#4d7533" class="label">${esc(s.name)} · ${Math.round(m.area)} m² · boundary ${fmt(m.perimeter, 1)} m</text>
        ${streetLabel(s, px)}
      </g>`;
    }
    if (isShaped(s)) {
      // curved driveway / path along its centre line
      const d = svgPath(s.points);
      const pts = smooth(s.points);
      const mid = pts[Math.floor(pts.length / 2)];
      const m = measure(s);
      return `<g class="site-el" data-target="${target}">
        <path d="${d}" fill="none" stroke="${fill}" stroke-width="${n(s.width ?? 3)}" stroke-linejoin="round"/>
        <path d="${d}" fill="none" stroke="transparent" stroke-width="${n(Math.max(s.width ?? 3, 12 * px))}"/>
        <text x="${n(mid[0])}" y="${n(mid[1])}" font-size="${n(10 * px)}" text-anchor="middle" fill="#555" class="label">${esc(s.name)} · ${fmt(m.length, 1)} m</text>
        ${commentMarker(s, target, px)}
      </g>`;
    }
    if (['tree', 'conifer', 'bush'].includes(s.type)) {
      const r = Math.min(s.w, s.h) / 2;
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const col = siteColor(s.type);
      let crown = `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${col}" fill-opacity=".8" stroke="#3f6b2f" stroke-width="${n(px)}"/>`;
      if (s.type === 'tree')
        crown += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.62)}" fill="none" stroke="#5a8a44" stroke-width="${n(px)}" stroke-dasharray="${n(3 * px)} ${n(3 * px)}"/>`;
      if (s.type === 'conifer')
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          crown += `<line x1="${n(cx)}" y1="${n(cy)}" x2="${n(cx + Math.cos(a) * r * 0.9)}" y2="${n(cy + Math.sin(a) * r * 0.9)}" stroke="#2c5a3a" stroke-width="${n(px)}"/>`;
        }
      if (s.type !== 'bush') crown += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(Math.max(0.08, r * 0.08))}" fill="#6b4f35"/>`;
      return `<g class="site-el" data-target="${target}">${crown}${s.w >= 3 ? `<text x="${n(cx)}" y="${n(cy + r + 11 * px)}" font-size="${n(10 * px)}" text-anchor="middle" fill="#3f6b2f" class="label">${esc(s.name)}</text>` : ''}${commentMarker(s, target, px)}</g>`;
    }
    if (s.type === 'hedge') {
      return `<g class="site-el" data-target="${target}"><rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" rx="${n(Math.min(s.w, s.h) / 2)}" fill="${siteColor(s.type)}" stroke="#3f6b2f" stroke-width="${n(px)}"/>${commentMarker(s, target, px)}</g>`;
    }
    if (s.type === 'carport' || s.type === 'pergola') {
      // a roof on posts: dashed roof outline, posts, and slats for a pergola
      const post = POST_SIZE(s);
      const terrace = isTerraceOnPosts(s);
      let inner = terrace
        ? `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="url(#planks)" fill-opacity=".55" stroke="#6b6259" stroke-width="${n(1.5 * px)}" stroke-dasharray="${n(8 * px)} ${n(4 * px)}"/>` +
          terraceRailEdges(s).map(([x1, y1, x2, y2]) => `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="#2f3133" stroke-width="${n(2 * px)}"/>`).join('')
        : `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="${siteColor(s.type)}" fill-opacity=".35" stroke="#6b6259" stroke-width="${n(1.5 * px)}" stroke-dasharray="${n(8 * px)} ${n(4 * px)}"/>`;
      if (terrace) {
        // a roof terrace over the space below: no slats or cross
      } else if (s.type === 'pergola' && (!s.roof || s.roof.type === 'flat'))
        for (let x = s.x + 0.4; x < s.x + s.w - 0.2; x += 0.4) inner += `<line x1="${n(x)}" y1="${n(s.y)}" x2="${n(x)}" y2="${n(s.y + s.h)}" stroke="#a08a6a" stroke-width="${n(px)}"/>`;
      else inner += `<line x1="${n(s.x)}" y1="${n(s.y)}" x2="${n(s.x + s.w)}" y2="${n(s.y + s.h)}" stroke="#8a8278" stroke-width="${n(px)}" stroke-dasharray="${n(4 * px)} ${n(3 * px)}"/><line x1="${n(s.x + s.w)}" y1="${n(s.y)}" x2="${n(s.x)}" y2="${n(s.y + s.h)}" stroke="#8a8278" stroke-width="${n(px)}" stroke-dasharray="${n(4 * px)} ${n(3 * px)}"/>`;
      for (const [x, y] of sitePosts(s)) inner += `<rect x="${n(x - post / 2)}" y="${n(y - post / 2)}" width="${post}" height="${post}" fill="#4a4a4a"/>`;
      const lines = [{ text: s.name, size: 11, weight: 600 }, { text: `${fmtArea(s.w * s.h)} m² · ${fmt(s.w)} × ${fmt(s.h)}${terrace ? ` · roof terrace at +${fmt((s.height ?? 2.4) + 0.3)} m` : ''}`, size: 10, color: '#555' }];
      return `<g class="site-el" data-target="${target}">${inner}${labelBlock(s.x + s.w / 2, s.y + s.h / 2, lines, px, s.w, s.h)}${commentMarker(s, target, px)}</g>`;
    }
    if (s.type === 'plot') {
      return `<g class="site-el plot" data-target="${target}">
        <rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="${fill}" pointer-events="none"/>
        <rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="none" stroke="#5b8a3c" stroke-width="${n(1.5 * px)}" stroke-dasharray="${n(10 * px)} ${n(4 * px)} ${n(2 * px)} ${n(4 * px)}"/>
        <rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="none" stroke="transparent" stroke-width="${n(12 * px)}"/>
        <text x="${n(s.x + 6 * px)}" y="${n(s.y + s.h - 6 * px)}" font-size="${n(11 * px)}" fill="#4d7533">${esc(s.name)} ${fmt(s.w)} × ${fmt(s.h)} m · ${Math.round(s.w * s.h)} m²</text>
        ${streetLabel(s, px)}
      </g>`;
    }
    if (s.type === 'garage') {
      const t = 0.25;
      const doorW = Math.min(s.w - 1, 5);
      const side = s.door || 'N';
      const horiz = side === 'N' || side === 'S';
      const len = horiz ? s.w : s.h;
      const d0 = (len - Math.min(doorW, len - 0.6)) / 2;
      const d1 = len - d0;
      const door = horiz
        ? { x1: s.x + d0, x2: s.x + d1, y1: side === 'N' ? s.y + t / 2 : s.y + s.h - t / 2 }
        : { y1: s.y + d0, y2: s.y + d1, x1: side === 'W' ? s.x + t / 2 : s.x + s.w - t / 2 };
      const doorLine = horiz
        ? `<line x1="${n(door.x1)}" y1="${n(door.y1)}" x2="${n(door.x2)}" y2="${n(door.y1)}" stroke="${siteColor(s.type)}" stroke-width="${t + 0.02}"/>
           <line x1="${n(door.x1)}" y1="${n(door.y1)}" x2="${n(door.x2)}" y2="${n(door.y1)}" stroke="#666" stroke-width="${n(lw)}" stroke-dasharray="${n(5 * px)} ${n(3 * px)}"/>`
        : `<line x1="${n(door.x1)}" y1="${n(door.y1)}" x2="${n(door.x1)}" y2="${n(door.y2)}" stroke="${siteColor(s.type)}" stroke-width="${t + 0.02}"/>
           <line x1="${n(door.x1)}" y1="${n(door.y1)}" x2="${n(door.x1)}" y2="${n(door.y2)}" stroke="#666" stroke-width="${n(lw)}" stroke-dasharray="${n(5 * px)} ${n(3 * px)}"/>`;
      shape = `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="${fill}"/>
        <rect x="${n(s.x + t / 2)}" y="${n(s.y + t / 2)}" width="${n(s.w - t)}" height="${n(s.h - t)}" fill="none" stroke="#3a3a3a" stroke-width="${t}"/>
        ${doorLine}`;
    } else if (s.type === 'pool') {
      shape = `<rect x="${n(s.x - 0.3)}" y="${n(s.y - 0.3)}" width="${n(s.w + 0.6)}" height="${n(s.h + 0.6)}" fill="#ece9e2"/>
        <rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="${fill}" stroke="#4a9cc0" stroke-width="${n(lw)}"/>`;
    } else if (s.type === 'greenhouse') {
      shape = `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="${fill}" stroke="#4f8a5b" stroke-width="${n(1.5 * px)}"/>
        <line x1="${n(s.x)}" y1="${n(s.y + s.h / 2)}" x2="${n(s.x + s.w)}" y2="${n(s.y + s.h / 2)}" stroke="#4f8a5b" stroke-width="${n(lw)}" stroke-dasharray="${n(4 * px)} ${n(3 * px)}"/>`;
    } else {
      const stroke = s.type === 'driveway' || s.type === 'path' ? 'none' : '#8f8a80';
      shape = `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="${fill}" stroke="${stroke}" stroke-width="${n(lw)}"/>`;
    }
    const big = s.w * s.h > 6;
    const lines = [{ text: s.name, size: 11, weight: 600 }];
    if (big && s.type !== 'driveway' && s.type !== 'path') lines.push({ text: `${fmtArea(s.w * s.h)} m² · ${fmt(s.w)} × ${fmt(s.h)}`, size: 10, color: '#555' });
    return `<g class="site-el" data-target="${target}">${shape}${labelBlock(s.x + s.w / 2, s.y + s.h / 2, lines, px, s.w, s.h)}${commentMarker(s, target, px)}</g>`;
  }

  // Quarter-circle swing of a hinged leaf: hinge point, unit vector of the open leaf (u)
  // and unit vector along the wall towards the other jamb (v).
  function swing(hx, hy, u, v, w, px) {
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const t = (Math.PI / 2) * (i / 12);
      pts.push(`${n(hx + w * (Math.cos(t) * u[0] + Math.sin(t) * v[0]))},${n(hy + w * (Math.cos(t) * u[1] + Math.sin(t) * v[1]))}`);
    }
    return `<line x1="${n(hx)}" y1="${n(hy)}" x2="${n(hx + u[0] * w)}" y2="${n(hy + u[1] * w)}" stroke="#222" stroke-width="${n(1.5 * px)}"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="#777" stroke-width="${n(px)}" stroke-dasharray="${n(3 * px)} ${n(2 * px)}"/>`;
  }

  // Thick transparent rectangle over a wall span, so thin doors/windows are easy to click.
  function hitRect(horizontal, coord, from, to, T, px) {
    const t = Math.max(T, 12 * px);
    return horizontal
      ? `<rect x="${n(from)}" y="${n(coord - t / 2)}" width="${n(to - from)}" height="${n(t)}" fill="transparent"/>`
      : `<rect x="${n(coord - t / 2)}" y="${n(from)}" width="${n(t)}" height="${n(to - from)}" fill="transparent"/>`;
  }

  function opening(floor, o, edges, px) {
    const p = placeOpening(floor, o, edges);
    if (!p) return '';
    if (p.curved) return curvedOpening(floor, o, p, px);
    const T = store.house.wall?.exterior ?? 0.4;
    const inward = { N: [0, 1], S: [0, -1], W: [1, 0], E: [-1, 0] }[o.facade];
    const lw = n(1 * px);
    const coord = p.horizontal ? p.y1 : p.x1;
    const parts = [];
    // erase the wall where the opening is
    if (p.horizontal) parts.push(`<rect x="${n(p.x1)}" y="${n(p.y1 - T / 2)}" width="${n(p.x2 - p.x1)}" height="${n(T)}" fill="#fff"/>`);
    else parts.push(`<rect x="${n(p.x1 - T / 2)}" y="${n(p.y1)}" width="${n(T)}" height="${n(p.y2 - p.y1)}" fill="#fff"/>`);
    // jambs
    const jamb = (x, y) =>
      p.horizontal
        ? `<line x1="${n(x)}" y1="${n(y - T / 2)}" x2="${n(x)}" y2="${n(y + T / 2)}" stroke="#222" stroke-width="${lw}"/>`
        : `<line x1="${n(x - T / 2)}" y1="${n(y)}" x2="${n(x + T / 2)}" y2="${n(y)}" stroke="#222" stroke-width="${lw}"/>`;
    parts.push(jamb(p.x1, p.y1), jamb(p.x2, p.y2));
    if (isHinged(o)) {
      // hinge at the chosen end, leaf opening inwards or outwards
      const w = p.to - p.from;
      const dir = o.swing === 'out' ? [-inward[0], -inward[1]] : inward;
      const atEnd = o.hinge === 'end';
      const [bx, by] = p.horizontal ? [atEnd ? p.to : p.from, p.y1] : [p.x1, atEnd ? p.to : p.from];
      const hx = bx + (dir[0] * T) / 2;
      const hy = by + (dir[1] * T) / 2;
      parts.push(swing(hx, hy, dir, p.horizontal ? [atEnd ? -1 : 1, 0] : [0, atEnd ? -1 : 1], w, px));
      if (o.type === 'terrace-door') {
        // glazed leaf: a blue line along the open leaf
        const off = 0.04;
        const side = p.horizontal ? [atEnd ? -off : off, 0] : [0, atEnd ? -off : off];
        parts.push(`<line x1="${n(hx + side[0])}" y1="${n(hy + side[1])}" x2="${n(hx + side[0] + dir[0] * w)}" y2="${n(hy + side[1] + dir[1] * w)}" stroke="#2f6fd6" stroke-width="${n(1.4 * px)}"/>`);
      }
    } else if (o.type === 'sliding-door') {
      // two overlapping glass panes in the wall and an arrow towards the side the leaf slides to
      const mid = (p.from + p.to) / 2;
      const pane = (a, b, off) =>
        p.horizontal
          ? `<line x1="${n(a)}" y1="${n(p.y1 + off)}" x2="${n(b)}" y2="${n(p.y1 + off)}" stroke="#2f6fd6" stroke-width="${n(1.6 * px)}"/>`
          : `<line x1="${n(p.x1 + off)}" y1="${n(a)}" x2="${n(p.x1 + off)}" y2="${n(b)}" stroke="#2f6fd6" stroke-width="${n(1.6 * px)}"/>`;
      parts.push(pane(p.from, mid + 0.05, -0.05), pane(mid - 0.05, p.to, 0.05));
      const towardsEnd = o.hinge !== 'start';
      const a0 = mid - (towardsEnd ? 1 : -1) * (p.to - p.from) * 0.25;
      const a1 = mid + (towardsEnd ? 1 : -1) * (p.to - p.from) * 0.25;
      const across = inward.map((v) => v * (T / 2 + 0.15));
      const pt = (along) => (p.horizontal ? [along + across[0], p.y1 + across[1]] : [p.x1 + across[0], along + across[1]]);
      const [x0, y0] = pt(a0);
      const [x1, y1] = pt(a1);
      const back = (towardsEnd ? -1 : 1) * 0.1;
      const [hx1, hy1] = p.horizontal ? [x1 + back, y1 - 0.06] : [x1 - 0.06, y1 + back];
      const [hx2, hy2] = p.horizontal ? [x1 + back, y1 + 0.06] : [x1 + 0.06, y1 + back];
      parts.push(`<path d="M${n(x0)} ${n(y0)} L${n(x1)} ${n(y1)} M${n(hx1)} ${n(hy1)} L${n(x1)} ${n(y1)} L${n(hx2)} ${n(hy2)}" fill="none" stroke="#666" stroke-width="${n(px)}"/>`);
    } else {
      // window: frame lines on both faces + glass line; full-height glazing drawn heavier
      const g = o.sill <= 0.05 ? 1.6 : 1;
      for (const off of [-T / 2, 0, T / 2]) {
        const sw = off === 0 ? g * px : 0.8 * px;
        parts.push(
          p.horizontal
            ? `<line x1="${n(p.x1)}" y1="${n(p.y1 + off)}" x2="${n(p.x2)}" y2="${n(p.y1 + off)}" stroke="${off === 0 ? '#2f6fd6' : '#222'}" stroke-width="${n(sw)}"/>`
            : `<line x1="${n(p.x1 + off)}" y1="${n(p.y1)}" x2="${n(p.x1 + off)}" y2="${n(p.y2)}" stroke="${off === 0 ? '#2f6fd6' : '#222'}" stroke-width="${n(sw)}"/>`,
        );
      }
    }
    // shutters folded against the wall beside the opening, Juliet railing in front of it
    const outward = [-inward[0], -inward[1]];
    const faceAt = (along, off) => (p.horizontal ? [along, coord + outward[1] * (T / 2 + off)] : [coord + outward[0] * (T / 2 + off), along]);
    if (o.shutters) {
      const [wl, wr] = shutterWidths(floor, o, edges, placeOpening);
      const col = facadeSettings(store.house).shutters;
      const g0 = o.surround ? 0.18 : 0.04;
      for (const [a0, a1] of [[p.from - g0 - wl, p.from - g0], [p.to + g0, p.to + g0 + wr]]) {
        if (a1 - a0 < 0.01) continue;
        const [x1, y1] = faceAt(a0, 0.03);
        const [x2, y2] = faceAt(a1, 0.03);
        parts.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${col}" stroke-width="0.06"/>`);
      }
    }
    if (o.juliet) {
      const [x1, y1] = faceAt(p.from - 0.1, 0.2);
      const [x2, y2] = faceAt(p.to + 0.1, 0.2);
      const [bx1, by1] = faceAt(p.from - 0.1, 0);
      const [bx2, by2] = faceAt(p.to + 0.1, 0);
      parts.push(`<path d="M${n(bx1)} ${n(by1)} L${n(x1)} ${n(y1)} L${n(x2)} ${n(y2)} L${n(bx2)} ${n(by2)}" fill="none" stroke="#26282a" stroke-width="${n(1.6 * px)}"/>`);
    }
    parts.push(hitRect(p.horizontal, coord, p.from, p.to, T, px));
    return `<g class="opening-el" data-target="${floor.id}/${o.id}">${parts.join('')}</g>`;
  }

  function interiorDoor(floor, d, p, px) {
    const T = store.house.wall?.interior ?? 0.15;
    const w = p.to - p.from;
    const at = (along, across) => (p.horizontal ? [along, p.coord + across] : [p.coord + across, along]);
    const parts = [];
    // jambs
    for (const a of [p.from, p.to]) {
      const [x1, y1] = at(a, -T / 2);
      const [x2, y2] = at(a, T / 2);
      parts.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="#222" stroke-width="${n(px)}"/>`);
    }
    // which side of the wall the door opens into
    const room = floor.rooms.find((r) => r.id === (d.swing || d.between[1])) || floor.rooms.find((r) => r.id === d.between[1]);
    const centre = room ? (p.horizontal ? room.y + room.h / 2 : room.x + room.w / 2) : p.coord + 1;
    const side = centre < p.coord ? -1 : 1;
    if (d.type === 'door') {
      const atEnd = d.hinge === 'end';
      const [hx, hy] = at(atEnd ? p.to : p.from, (side * T) / 2);
      const u = p.horizontal ? [0, side] : [side, 0];
      const v = p.horizontal ? [atEnd ? -1 : 1, 0] : [0, atEnd ? -1 : 1];
      parts.push(swing(hx, hy, u, v, w, px));
    } else if (d.type === 'sliding') {
      // closed panel in the opening (overlapping the wall a little) and an arrow showing
      // the way it slides; an open passage is just the gap with its jambs
      const t = 0.045;
      const [x1, y1] = at(p.from - 0.05, side * 0.03 - t / 2);
      const [x2, y2] = at(p.to + 0.05, side * 0.03 + t / 2);
      parts.push(`<rect x="${n(Math.min(x1, x2))}" y="${n(Math.min(y1, y2))}" width="${n(Math.abs(x2 - x1))}" height="${n(Math.abs(y2 - y1))}" fill="#fff" stroke="#222" stroke-width="${n(px)}"/>`);
      const back = d.hinge === 'end' ? -1 : 1;
      const mid = (p.from + p.to) / 2;
      const [ax1, ay1] = at(mid - back * w * 0.3, side * (T / 2 + 0.12));
      const [ax2, ay2] = at(mid + back * w * 0.3, side * (T / 2 + 0.12));
      const head = 0.08;
      const [hx1, hy1] = at(mid + back * (w * 0.3 - head), side * (T / 2 + 0.12) - head * 0.6);
      const [hx2, hy2] = at(mid + back * (w * 0.3 - head), side * (T / 2 + 0.12) + head * 0.6);
      parts.push(`<path d="M${n(ax1)} ${n(ay1)} L${n(ax2)} ${n(ay2)} M${n(hx1)} ${n(hy1)} L${n(ax2)} ${n(ay2)} L${n(hx2)} ${n(hy2)}" fill="none" stroke="#666" stroke-width="${n(px)}"/>`);
    }
    parts.push(hitRect(p.horizontal, p.coord, p.from, p.to, T, px));
    return `<g class="opening-el" data-target="${floor.id}/${d.id}">${parts.join('')}</g>`;
  }

  // A window or door in a curved wall: the wall erased along the arc, glass along the curve,
  // jambs across the wall at both ends.
  function curvedOpening(floor, o, p, px) {
    const sh = p.curved;
    const T = store.house.wall?.exterior ?? 0.4;
    const n8 = 8;
    const pts = Array.from({ length: n8 + 1 }, (_, i) => arcPoint(sh, p.t0 + ((p.t1 - p.t0) * i) / n8));
    const d = `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')}`;
    const jamb = (t) => {
      const [x, y] = arcPoint(sh, t);
      const nx = (x - sh.cx) / sh.ax ** 2;
      const ny = (y - sh.cy) / sh.by ** 2;
      const l = Math.hypot(nx, ny) || 1;
      return `<line x1="${n(x - (nx / l) * (T / 2))}" y1="${n(y - (ny / l) * (T / 2))}" x2="${n(x + (nx / l) * (T / 2))}" y2="${n(y + (ny / l) * (T / 2))}" stroke="#222" stroke-width="${n(px)}"/>`;
    };
    const glass = o.type === 'door' ? '#7a5a3a' : '#2f6fd6';
    return `<g class="opening-el" data-target="${floor.id}/${o.id}">
      <path d="${d}" fill="none" stroke="#fff" stroke-width="${n(T + 0.01)}"/>
      <path d="${d}" fill="none" stroke="${glass}" stroke-width="${n(1.6 * px)}"/>
      ${jamb(p.t0)}${jamb(p.t1)}
      <path d="${d}" fill="none" stroke="transparent" stroke-width="${n(Math.max(T, 12 * px))}"/></g>`;
  }

  function stairsSymbol(floor, r, px) {
    // treads exactly as calculated (see stairs.js): straight flights or a U-turn with winders
    const a = analyzeStairs(store.house, floor, r);
    const f = a.flight;
    const { treads, path } = stairSteps(a);
    const outlines = treads.map((t) => `<polygon points="${t.pts.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}"/>`);
    const colour = a.issues.length ? '#c2410c' : '#555';
    // walking line with a dot at the foot and an arrowhead at the top
    const [ex, ey] = path[path.length - 1];
    const [qx, qy] = path[path.length - 2];
    const len = Math.hypot(ex - qx, ey - qy) || 1;
    const [dx, dy] = [(ex - qx) / len, (ey - qy) / len];
    const [l1x, l1y] = [ex - dx * 0.25 - dy * 0.15, ey - dy * 0.25 + dx * 0.15];
    const [l2x, l2y] = [ex - dx * 0.25 + dy * 0.15, ey - dy * 0.25 - dx * 0.15];
    let store_ = '';
    if (a.storage && a.storage.length > 0.3) {
      const [s0, s1] = [Math.min(a.storage.from, a.storage.to), Math.max(a.storage.from, a.storage.to)];
      const [x, y, ww, hh] = f.alongY ? [f.across[0] + 0.08, s0, f.across[1] - f.across[0] - 0.16, s1 - s0 - 0.04] : [s0, f.across[0] + 0.08, s1 - s0 - 0.04, f.across[1] - f.across[0] - 0.16];
      store_ = `<g class="label"><rect x="${n(x)}" y="${n(y)}" width="${n(ww)}" height="${n(hh)}" fill="rgba(160,124,90,.12)" stroke="#a07c5a" stroke-width="${n(px)}" stroke-dasharray="${n(4 * px)} ${n(3 * px)}"/>
        <text x="${n(x + ww / 2)}" y="${n(y + hh - 6 * px)}" font-size="${n(9 * px)}" text-anchor="middle" fill="#7a5a3a">storage below</text></g>`;
    }
    return `${store_}<g class="label" stroke="#9b9384" stroke-width="${n(0.8 * px)}" fill="none">${outlines.join('')}</g>
      <g class="label" stroke="${colour}" stroke-width="${n(1.2 * px)}" fill="none">
        <circle cx="${n(path[0][0])}" cy="${n(path[0][1])}" r="0.06" fill="${colour}"/>
        <path d="M${path.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')} M${n(l1x)} ${n(l1y)} L${n(ex)} ${n(ey)} L${n(l2x)} ${n(l2y)}"/>
      </g>`;
  }

  // Floor finishes as fills: plain colours or a tile pattern (texture image or a coloured
  // grid) sized to the real tile, anchored at the zone's start corner.
  function finishLayer(floor, px) {
    const defs = [];
    const fills = [];
    for (const r of floor.rooms) {
      if (r.type === 'void') continue;
      const zones = [{ ...r, finish: r.finish?.floor, id: `${r.id}-room`, order: 0 }, ...(r.zones || []).map((z) => ({ ...z, finish: z.finish }))];
      for (const z of zones) {
        if (!z.finish) continue;
        const { fill, def } = finishFill(`fin-${floor.id}-${z.id}`, z, z.finish, store.assetUrl);
        if (def) defs.push(def);
        fills.push(`<rect x="${n(z.x)}" y="${n(z.y)}" width="${n(z.w)}" height="${n(z.h)}" fill="${fill}" opacity=".9"/>`);
      }
      for (const z of r.zones || []) {
        fills.push(`<rect x="${n(z.x)}" y="${n(z.y)}" width="${n(z.w)}" height="${n(z.h)}" fill="none" stroke="#7c3aed" stroke-width="${n(1.5 * px)}" stroke-dasharray="${n(5 * px)} ${n(3 * px)}"/>
          <text x="${n(z.x + 4 * px)}" y="${n(z.y + 13 * px)}" font-size="${n(11 * px)}" font-weight="700" fill="#7c3aed">${z.order ?? ''}${z.name ? ` ${esc(z.name)}` : ''}</text>`);
      }
    }
    return `<g class="label"><defs>${defs.join('')}</defs>${fills.join('')}</g>`;
  }

  function terraceLayer(floor, px) {
    const out = [];
    for (const { zone, geom: g } of roofZones(store.house)) {
      if (!zone || !(g.type === 'flat' && zone.walkable) || Math.abs(g.eave - (floor.elevation ?? 0)) > 0.25) continue;
      const o = g.outer;
      const rails = openEdges(store.house, g)
        .map(([x1, y1, x2, y2]) => `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="#26282a" stroke-width="${n(2.5 * px)}" stroke-dasharray="${n(1.5 * px)} ${n(2 * px)}"/>`)
        .join('');
      const lines = [{ text: zone.name || 'Roof terrace', size: 11, weight: 600 }, { text: `${fmtArea(zone.w * zone.h)} m² · ${fmt(zone.w)} × ${fmt(zone.h)}`, size: 10, color: '#555' }];
      out.push(`<g class="site-el" data-target="roofs/${esc(zone.id)}">
        <rect x="${n(o.x)}" y="${n(o.y)}" width="${n(o.w)}" height="${n(o.h)}" fill="url(#planks)" opacity=".75"/>
        <g class="label">${rails}${labelBlock(o.x + o.w / 2, o.y + o.h / 2, lines, px, o.w, o.h)}</g></g>`);
    }
    return out.join('');
  }

  function roofLayer(px) {
    const out = [];
    const ln = (x1, y1, x2, y2, extra = '') => `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="#8a5a2b" stroke-width="${n(1.2 * px)}" ${extra}/>`;
    for (const { zone, geom: g } of roofZones(store.house)) {
      if (!zone) continue;
      const o = g.outer;
      const r = { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h };
      const lines = [];
      const hip = (q) => {
        const w = q.x1 - q.x0;
        const d = q.y1 - q.y0;
        const h = Math.min(w, d) / 2;
        if (w >= d) {
          const ym = (q.y0 + q.y1) / 2;
          lines.push(ln(q.x0 + h, ym, q.x1 - h, ym), ln(q.x0, q.y0, q.x0 + h, ym), ln(q.x0, q.y1, q.x0 + h, ym), ln(q.x1, q.y0, q.x1 - h, ym), ln(q.x1, q.y1, q.x1 - h, ym));
        } else {
          const xm = (q.x0 + q.x1) / 2;
          lines.push(ln(xm, q.y0 + h, xm, q.y1 - h), ln(q.x0, q.y0, xm, q.y0 + h), ln(q.x1, q.y0, xm, q.y0 + h), ln(q.x0, q.y1, xm, q.y1 - h), ln(q.x1, q.y1, xm, q.y1 - h));
        }
      };
      if (g.type === 'gable') lines.push(zone.ridge === 'y' ? ln((r.x0 + r.x1) / 2, r.y0, (r.x0 + r.x1) / 2, r.y1) : ln(r.x0, (r.y0 + r.y1) / 2, r.x1, (r.y0 + r.y1) / 2));
      if (g.type === 'hip') hip(r);
      if (g.type === 'mansard') {
        const i = g.mansard.inner;
        const q = { x0: i.x, y0: i.y, x1: i.x + i.w, y1: i.y + i.h };
        lines.push(`<rect x="${n(q.x0)}" y="${n(q.y0)}" width="${n(i.w)}" height="${n(i.h)}" fill="none" stroke="#8a5a2b" stroke-width="${n(1.2 * px)}"/>`);
        for (const [a, b] of [[[r.x0, r.y0], [q.x0, q.y0]], [[r.x1, r.y0], [q.x1, q.y0]], [[r.x0, r.y1], [q.x0, q.y1]], [[r.x1, r.y1], [q.x1, q.y1]]]) lines.push(ln(a[0], a[1], b[0], b[1]));
        hip(q);
      }
      if (g.type === 'shed') {
        const lowSide = zone.low || 'S';
        const [cx, cy] = [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
        const d = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[lowSide];
        lines.push(ln(cx - d[0] * 0.8, cy - d[1] * 0.8, cx + d[0] * 0.8, cy + d[1] * 0.8, `marker-end="url(#roof-arrow)"`));
      }
      const fill = g.type === 'flat' && zone.walkable ? 'rgba(207,199,184,.55)' : 'rgba(138,90,43,.08)';
      const label = `${zone.name || 'Roof'} · ${ROOF_TYPES[g.type]?.split(' (')[0] || g.type}${zone.walkable ? ' terrace' : ''}`;
      out.push(`<g class="site-el" data-target="roofs/${esc(zone.id)}">
        <rect x="${n(r.x0)}" y="${n(r.y0)}" width="${n(o.w)}" height="${n(o.h)}" fill="${fill}" stroke="#8a5a2b" stroke-width="${n(1.8 * px)}" stroke-dasharray="${n(9 * px)} ${n(4 * px)}"/>
        <g class="label">${lines.join('')}
          ${(zone.chimneys || []).map((c) => `<rect x="${n(c.x)}" y="${n(c.y)}" width="${n(c.w ?? 0.7)}" height="${n(c.h ?? 0.9)}" fill="#b8705a" stroke="#6b3d2b" stroke-width="${n(px)}"/>`).join('')}
          <text x="${n(r.x0 + 5 * px)}" y="${n(r.y0 + 13 * px)}" font-size="${n(10.5 * px)}" font-weight="600" fill="#6b3d1b">${esc(label)}</text>
        </g></g>`);
    }
    return `<defs><marker id="roof-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#8a5a2b"/></marker></defs>${out.join('')}`;
  }

  function render() {
    const floor = store.floor();
    if (lastFloor !== floor.id) {
      lastFloor = floor.id;
      fit();
    }
    const px = mpp();
    const house = store.house;
    const isGround = floor === groundFloor(house);
    const ext = house.wall?.exterior ?? 0.4;
    const int = house.wall?.interior ?? 0.15;
    const edges = exteriorEdges(floor);
    const parts = [];

    // site (ground floor only)
    if (isGround) {
      const order = ['plot', 'slope', 'garden', 'driveway', 'path', 'terrace', 'pool', 'greenhouse', 'garage', 'shed', 'hedge', 'bush', 'conifer', 'tree', 'carport', 'pergola'];
      // raised elements (standing on top of another one) are drawn last
      const rank = (s) => (s.base ? 100 : 0) + (order.indexOf(s.type) + 1 || 99);
      const sorted = [...house.site].sort((a, b) => rank(a) - rank(b));
      parts.push(...sorted.map((s) => siteElement(s, px)));
    } else {
      // ghost of the floor below
      const below = [...house.floors]
        .sort((a, b) => (b.elevation ?? 0) - (a.elevation ?? 0))
        .find((f) => (f.elevation ?? 0) < (floor.elevation ?? 0));
      if (below) {
        parts.push(
          `<g stroke="#bbb" stroke-width="${n(1 * px)}" stroke-dasharray="${n(5 * px)} ${n(4 * px)}">` +
            exteriorEdges(below).map((e) => `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}"/>`).join('') +
            curvedWalls(below).map(({ shape }) => `<path fill="none" d="M${arcSegments(shape, 0.2).map((g) => `${n(g.p0[0])} ${n(g.p0[1])}`).join(' L')}"/>`).join('') +
            '</g>',
        );
      }
    }

    // roof terraces at this floor's level (on the roof of the floor below): paving and balustrade
    parts.push(terraceLayer(floor, px));

    // room fills
    for (const r of floor.rooms) {
      const target = `${floor.id}/${r.id}`;
      const fill = r.type === 'void' ? '#fbfaf7' : roomColor(r.type);
      const shapeSvg = roundShape(r)
        ? `<path class="room-fill" d="M${roomOutline(r).map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')} Z" fill="${fill}"/>`
        : `<rect class="room-fill" x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${fill}"/>`;
      parts.push(`<g class="room" data-target="${target}">${shapeSvg}
        ${r.type === 'void' ? `<path class="label" d="M${n(r.x)} ${n(r.y)} L${n(r.x + r.w)} ${n(r.y + r.h)} M${n(r.x + r.w)} ${n(r.y)} L${n(r.x)} ${n(r.y + r.h)}" stroke="#ccc" stroke-width="${n(px)}"/>` : ''}
        ${r.type === 'stairs' ? stairsSymbol(floor, r, px) : ''}</g>`);
    }

    // walls, drawn by type: load-bearing dark, partitions grey, railings thin, glass blue,
    // open edges dotted; door openings leave gaps
    const inner = interiorEdges(floor);
    const doors = (floor.doors || []).map((d) => ({ d, p: placeDoor(floor, d, inner) })).filter((x) => x.p);
    const walls = floorWalls(house, floor);
    const wallParts = [];
    const seg = (w, s0, s1) => (w.horizontal ? [s0, w.coord, s1, w.coord] : [w.coord, s0, w.coord, s1]);
    for (const w of walls.inner) {
      const spans = doors.filter(({ p }) => p.edge.x1 === w.x1 && p.edge.y1 === w.y1 && p.edge.x2 === w.x2 && p.edge.y2 === w.y2).map(({ p }) => [p.from, p.to]);
      const { type, loadBearing, thickness } = w.props;
      for (const [s0, s1] of solidPieces(w.from, w.to, spans)) {
        const [x1, y1, x2, y2] = seg(w, s0, s1);
        const line = (stroke, width, extra = '') => `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${n(width)}" ${extra}/>`;
        if (type === 'railing') wallParts.push(line('#555', 0.05));
        else if (type === 'glass') wallParts.push(line('#4a90d9', 0.06), line('#fff', 0.02));
        else if (type === 'none') wallParts.push(line('#999', px, `stroke-dasharray="${n(2 * px)} ${n(3 * px)}"`));
        else wallParts.push(line(loadBearing ? '#23262b' : '#8a8a8a', thickness, `stroke-linecap="${spans.length ? 'butt' : 'square'}"`));
      }
      if (w.props.beam) {
        const [x1, y1, x2, y2] = seg(w, w.from, w.to);
        wallParts.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="#a0591c" stroke-opacity=".75" stroke-width="${n(Math.max(0.12, 3 * px))}" stroke-dasharray="${n(10 * px)} ${n(3 * px)} ${n(2 * px)} ${n(3 * px)}"/>`);
      }
    }
    parts.push(`<g class="label">${wallParts.join('')}</g>`);
    // exterior walls (per room, so a facade can be marked non-load-bearing)
    parts.push(
      `<g class="label" stroke-width="${ext}" stroke-linecap="square">` +
        walls.outer.map((w) => `<line x1="${n(w.x1)}" y1="${n(w.y1)}" x2="${n(w.x2)}" y2="${n(w.y2)}" stroke="${w.props.loadBearing ? '#23262b' : '#6f6f6f'}"/>`).join('') +
        '</g>',
    );
    // curved walls of round rooms (exterior thickness where the outside is open)
    for (const { room: r, shape } of curvedWalls(floor)) {
      const segs = arcSegments(shape, 0.1);
      const mid = arcPoint(shape, (shape.t0 + shape.t1) / 2);
      const outside = [mid[0] + Math.sign(mid[0] - shape.cx) * 0.3, mid[1] + Math.sign(mid[1] - shape.cy) * 0.3];
      const exterior = !floor.rooms.some((o) => o !== r && inRoom(o, ...outside));
      const d = `M${segs.map((g) => `${n(g.p0[0])} ${n(g.p0[1])}`).join(' L')} L${n(segs.at(-1).p1[0])} ${n(segs.at(-1).p1[1])}${shape.kind === 'all' ? ' Z' : ''}`;
      parts.push(`<path class="label" d="${d}" fill="none" stroke="#23262b" stroke-width="${n(exterior ? ext : int)}" stroke-linejoin="round"/>`);
    }
    // structural warnings on this floor
    for (const issue of structureIssues(house).filter((i) => i.floor === floor)) {
      const t = store.resolve(issue.target);
      if (t?.kind === 'room') {
        const r = t.item;
        parts.push(`<rect class="label" x="${n(r.x + 0.15)}" y="${n(r.y + 0.15)}" width="${n(r.w - 0.3)}" height="${n(r.h - 0.3)}" fill="none" stroke="#dc2626" stroke-width="${n(1.5 * px)}" stroke-dasharray="${n(6 * px)} ${n(4 * px)}"/>`);
      } else if (t?.kind === 'wall') {
        const w = t.wall;
        parts.push(`<line class="label" x1="${n(w.x1)}" y1="${n(w.y1)}" x2="${n(w.x2)}" y2="${n(w.y2)}" stroke="#dc2626" stroke-width="${n(5 * px)}" stroke-opacity=".6"/>`);
      }
    }
    // grab zones for dragging whole walls
    runs = wallRuns(floor);
    parts.push(
      runs
        .map((r, i) => {
          const t = Math.max(int, 10 * px);
          const [x, y, w, h] = r.horizontal ? [r.from, r.coord - t / 2, r.to - r.from, t] : [r.coord - t / 2, r.from, t, r.to - r.from];
          return `<rect class="wall-hit" data-wall="${i}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="transparent" style="cursor:${r.horizontal ? 'ns' : 'ew'}-resize"/>`;
        })
        .join(''),
    );
    // windows, exterior doors, interior doors
    parts.push((floor.openings || []).map((o) => opening(floor, o, edges, px)).join(''));
    parts.push(doors.map(({ d, p }) => interiorDoor(floor, d, p, px)).join(''));

    // finishes layer: floor colours / tile patterns per room and zone
    if (layers.finishes) parts.push(finishLayer(floor, px));

    // furniture & appliances
    if (layers.furniture)
      for (const it of floor.items || []) parts.push(`<g class="item-el" data-target="${floor.id}/${esc(it.id)}">${itemSymbol(it, px)}</g>`);

    // room labels + comment markers
    for (const r of floor.rooms) {
      const target = `${floor.id}/${r.id}`;
      const lines = [{ text: r.name, size: 12, weight: 600 }];
      if (r.type !== 'void') lines.push({ text: `${fmtArea(area(r))} m²`, size: 11 });
      lines.push({ text: `${fmt(r.w)} × ${fmt(r.h)}`, size: 10, color: '#666' });
      parts.push(labelBlock(r.x + r.w / 2, r.y + r.h / 2, lines, px, r.w, r.h), commentMarker(r, target, px));
    }

    // comment markers on walls, doors and windows (rooms and site elements have their own)
    const marked = new Set(store.comments.filter((c) => c.status === 'open' && c.target.startsWith(`${floor.id}/`)).map((c) => c.target));
    for (const target of marked) {
      const t = store.resolve(target);
      let mid = null;
      if (t?.kind === 'wall') mid = [(t.wall.x1 + t.wall.x2) / 2, (t.wall.y1 + t.wall.y2) / 2];
      else if (t?.kind === 'door' || t?.kind === 'opening') {
        const p = t.kind === 'door' ? placeDoor(floor, t.item) : placeOpening(floor, t.item);
        if (p) mid = p.horizontal ? [(p.from + p.to) / 2, p.coord ?? p.y1] : [p.coord ?? p.x1, (p.from + p.to) / 2];
      }
      if (!mid) continue;
      const count = store.openComments(target);
      parts.push(`<g class="label"><circle cx="${n(mid[0])}" cy="${n(mid[1])}" r="${n(8 * px)}" fill="#db2777" stroke="#fff" stroke-width="${n(1.5 * px)}"/>
        <text x="${n(mid[0])}" y="${n(mid[1] + 3.5 * px)}" font-size="${n(10 * px)}" font-weight="700" fill="#fff" text-anchor="middle">${count}</text></g>`);
    }

    if (floor.rooms.length) parts.push(dimensions(floor, px));

    // whole-house comment marker next to the building
    const houseComments = store.openComments('house');
    if (houseComments) {
      const b = bbox(floor.rooms);
      parts.push(`<g class="label"><text x="${n(b.x)}" y="${n(b.y - 2.3)}" font-size="${n(11 * px)}" fill="#db2777" font-weight="700">● ${houseComments} open comment${houseComments > 1 ? 's' : ''} on the whole house</text></g>`);
    }

    // roofs layer: every roof area with its ridge / hip lines, roof terraces and chimneys
    if (layers.roofs) parts.push(roofLayer(px));

    // utility points (above labels so they stay clickable)
    for (const pt of floor.points || []) {
      const group = pointGroup(pt.kind);
      if (!(group === 'electrical' ? layers.electrical : layers.water)) continue;
      parts.push(`<g class="point-el" data-target="${floor.id}/${esc(pt.id)}">${pointSymbol(pt, px, layers.circuits)}</g>`);
    }

    // selection outline + resize handles
    const sel = store.resolve(store.selected);
    const hs = 9 * px;
    const handle = (attr, x, y, cursor, shape = 'rect') =>
      shape === 'circle'
        ? `<circle class="handle" ${attr} cx="${n(x)}" cy="${n(y)}" r="${n(hs * 0.65)}" stroke-width="${n(1.5 * px)}" style="cursor:${cursor}"/>`
        : `<rect class="handle" ${attr} x="${n(x - hs / 2)}" y="${n(y - hs / 2)}" width="${n(hs)}" height="${n(hs)}" stroke-width="${n(1.5 * px)}" style="cursor:${cursor}"/>`;
    if (sel.kind === 'item' && sel.floor === floor) {
      const f = footprint(sel.item);
      parts.push(`<rect class="label" x="${n(f.x - 0.03)}" y="${n(f.y - 0.03)}" width="${n(f.w + 0.06)}" height="${n(f.h + 0.06)}" fill="rgba(245,158,11,.12)" stroke="#f59e0b" stroke-width="${n(2.5 * px)}"/>`);
      // edge handles resize the item
      for (const [dir, fx, fy, cur] of [['n', 0.5, 0, 'ns'], ['s', 0.5, 1, 'ns'], ['w', 0, 0.5, 'ew'], ['e', 1, 0.5, 'ew']])
        parts.push(handle(`data-ihandle="${dir}"`, f.x + fx * f.w, f.y + fy * f.h, `${cur}-resize`));
    }
    if (sel.kind === 'point' && sel.floor === floor)
      parts.push(`<circle class="label" cx="${n(sel.item.x)}" cy="${n(sel.item.y)}" r="${n(12 * px)}" fill="none" stroke="#f59e0b" stroke-width="${n(2.5 * px)}"/>`);
    if ((sel.kind === 'door' || sel.kind === 'opening') && sel.floor === floor) {
      const p = sel.kind === 'door' ? placeDoor(floor, sel.item) : placeOpening(floor, sel.item);
      if (p) {
        const t = (sel.kind === 'door' ? int : ext) + 0.16;
        const c = p.horizontal ? p.coord ?? p.y1 : p.coord ?? p.x1;
        const [x, y, w, h] = p.horizontal ? [p.from, c - t / 2, p.to - p.from, t] : [c - t / 2, p.from, t, p.to - p.from];
        parts.push(`<rect class="label" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="rgba(245,158,11,.15)" stroke="#f59e0b" stroke-width="${n(2.5 * px)}"/>`);
        // end handles change the width
        const cur = p.horizontal ? 'ew-resize' : 'ns-resize';
        for (const [end, along] of [['from', p.from], ['to', p.to]]) parts.push(handle(`data-end="${end}"`, p.horizontal ? along : c, p.horizontal ? c : along, cur));
      }
    } else if (sel.kind === 'wall' && sel.floor === floor) {
      const w = sel.wall;
      const t = (w.props.thickness ?? 0.15) + 0.16;
      const [x, y, ww, hh] = w.horizontal ? [w.from, w.coord - t / 2, w.to - w.from, t] : [w.coord - t / 2, w.from, t, w.to - w.from];
      parts.push(`<rect class="label" x="${n(x)}" y="${n(y)}" width="${n(ww)}" height="${n(hh)}" fill="rgba(245,158,11,.2)" stroke="#f59e0b" stroke-width="${n(2.5 * px)}"/>`);
    } else if (sel.kind === 'site' && isGround && isShaped(sel.item)) {
      // corner / control points of an irregular plot or a curved road, plus "+" to add one
      const pts = sel.item.points;
      const closed = SHAPED[sel.item.type] === 'polygon';
      parts.push(`<path class="label" d="${closed ? `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')} Z` : `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')}`}" fill="none" stroke="#f59e0b" stroke-width="${n(1.5 * px)}" stroke-dasharray="${n(4 * px)} ${n(3 * px)}"/>`);
      const segs = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segs; i++) {
        const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
        const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        parts.push(`<g class="handle-add" data-insert="${i}" style="cursor:copy"><circle cx="${n(mx)}" cy="${n(my)}" r="${n(hs * 0.5)}" fill="#fff" stroke="#f59e0b" stroke-width="${n(px)}"/>
          <path d="M${n(mx - hs * 0.3)} ${n(my)} H${n(mx + hs * 0.3)} M${n(mx)} ${n(my - hs * 0.3)} V${n(my + hs * 0.3)}" stroke="#f59e0b" stroke-width="${n(px)}"/></g>`);
      }
      pts.forEach(([x, y], i) => parts.push(handle(`data-vertex="${i}"`, x, y, 'move', 'circle')));
    } else if (sel.kind === 'roofzone' || ((sel.kind === 'room' || sel.kind === 'site') && (sel.kind === 'site' ? isGround : sel.floor === floor))) {
      const it = sel.item;
      parts.push(`<rect class="label" x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(it.h)}" fill="rgba(245,158,11,.08)" stroke="#f59e0b" stroke-width="${n(2.5 * px)}"/>`);
      const handles = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
      const cursors = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' };
      for (const [dir, [fx, fy]] of Object.entries(handles)) parts.push(handle(`data-handle="${dir}"`, it.x + fx * it.w, it.y + fy * it.h, `${cursors[dir]}-resize`));
    }

    world.innerHTML = parts.join('');
    renderScalebar(px);
  }

  function renderScalebar(px) {
    if (!scalebar) return;
    const options = [0.5, 1, 2, 5, 10, 20];
    const len = options.find((m) => m / px >= 60) || 20;
    const w = len / px;
    scalebar.innerHTML = `<rect x="${n(130 - w)}" y="4" width="${n(w)}" height="5" fill="#fff" stroke="#333"/>
      <rect x="${n(130 - w)}" y="4" width="${n(w / 2)}" height="5" fill="#333"/>
      <text x="130" y="22" font-size="11" text-anchor="end" fill="#333">${len} m</text>`;
  }

  // ---------- interaction ----------

  function snapTargets(kind, self) {
    // edges of other items to snap to (rooms on every floor, or site elements + house outline)
    const xs = [];
    const ys = [];
    const add = (r) => {
      xs.push(r.x, r.x + r.w);
      ys.push(r.y, r.y + r.h);
    };
    if (kind === 'room') store.house.floors.forEach((f) => f.rooms.forEach((r) => r !== self && add(r)));
    else if (kind === 'item' || kind === 'point') {
      // inner faces of the walls, and the other furniture
      const floor = store.floor();
      const b = bbox(floor.rooms);
      const half = (coord, lo, hi) => (Math.abs(coord - lo) < 0.01 || Math.abs(coord - hi) < 0.01 ? (store.house.wall?.exterior ?? 0.4) : (store.house.wall?.interior ?? 0.15)) / 2;
      for (const r of floor.rooms) {
        xs.push(r.x + half(r.x, b.x, b.x + b.w), r.x + r.w - half(r.x + r.w, b.x, b.x + b.w));
        ys.push(r.y + half(r.y, b.y, b.y + b.h), r.y + r.h - half(r.y + r.h, b.y, b.y + b.h));
      }
      for (const it of floor.items || []) if (it !== self) add(footprint(it));
    } else {
      store.house.site.forEach((s) => s !== self && add(s));
      store.house.floors.forEach((f) => f.rooms.length && add(bbox(f.rooms)));
    }
    return { xs, ys };
  }

  function snapValue(v, targets, tol, grid = SNAP) {
    let best = round(Math.round(v / grid) * grid);
    let bestD = Infinity;
    for (const t of targets) {
      const d = Math.abs(t - v);
      if (d < tol && d < bestD) {
        bestD = d;
        best = round(t);
      }
    }
    return { v: best, d: bestD };
  }

  // Start dragging one or more wall lines. Every room with an edge on a line moves with it.
  function startWallDrag(list, p) {
    const floor = store.floor();
    const walls = list.map((run) => {
      const attached = roomsOnRun(floor, run);
      const mine = new Set(attached.map((a) => a.room));
      const targets = [];
      for (const f of store.house.floors)
        for (const r of f.rooms) {
          if (f === floor && mine.has(r)) continue;
          targets.push(...(run.horizontal ? [r.y, r.y + r.h] : [r.x, r.x + r.w]));
        }
      return { run, attached, limits: wallLimits(run, attached), targets };
    });
    drag = { mode: 'wall', walls, start: { ...p }, moved: false };
    store.beginBatch();
  }

  function onPointerDown(evt) {
    if (evt.button !== 0 && evt.pointerType === 'mouse') return;
    const p = toWorld(evt);
    const handle = evt.target.closest('[data-handle]')?.dataset.handle;
    const vertexEl = evt.target.closest('[data-vertex]');
    const insertEl = evt.target.closest('[data-insert]');
    const ihandle = evt.target.closest('[data-ihandle]')?.dataset.ihandle;
    const endEl = evt.target.closest('[data-end]');
    if (vertexEl || insertEl || ihandle || endEl) {
      svg.setPointerCapture(evt.pointerId);
      const sel = store.resolve(store.selected);
      if (!sel) return;
      store.beginBatch();
      if (insertEl) {
        // add a point in the middle of a segment and drag it straight away
        const i = Number(insertEl.dataset.insert);
        const pts = sel.item.points;
        const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
        pts.splice(i + 1, 0, [round((a[0] + b[0]) / 2), round((a[1] + b[1]) / 2)]);
        syncBox(sel.item);
        store.changed();
        drag = { mode: 'vertex', item: sel.item, index: i + 1, start: { ...p }, moved: false };
      } else if (vertexEl) {
        drag = { mode: 'vertex', item: sel.item, index: Number(vertexEl.dataset.vertex), start: { ...p }, moved: false };
        // with the pointer captured the dblclick lands on the svg, so remember the point here
        lastVertex = { item: sel.item, index: drag.index, at: Date.now() };
      }
      else if (ihandle) drag = { mode: 'resize-item', handle: ihandle, item: sel.item, orig: footprint(sel.item), start: { ...p }, moved: false };
      else {
        const pl = sel.kind === 'door' ? placeDoor(sel.floor, sel.item) : placeOpening(sel.floor, sel.item);
        if (!pl) return store.endBatch();
        drag = { mode: 'opening-end', end: endEl.dataset.end, sel, place: pl, start: { ...p }, moved: false };
      }
      return;
    }
    const wallEl = evt.target.closest('[data-wall]');
    const targetEl = evt.target.closest('[data-target]');
    svg.setPointerCapture(evt.pointerId);
    if (handle) {
      const sel = store.resolve(store.selected);
      if (!sel || sel.kind === 'house') return;
      if (sel.kind === 'room' && !evt.shiftKey) {
        // resizing a room moves its walls (and the neighbours on the other side)
        const found = [...handle].map((side) => runForEdge(sel.floor, sel.item, side, runs));
        if (found.every(Boolean)) return startWallDrag(found, p);
      }
      drag = { mode: 'resize', handle, kind: sel.kind, item: sel.item, start: { ...p }, orig: { ...sel.item }, snap: snapTargets(sel.kind, sel.item), moved: false };
      store.beginBatch();
    } else if (wallEl && !targetEl) {
      startWallDrag([runs[Number(wallEl.dataset.wall)]], p);
      drag.click = true;
    } else if (targetEl) {
      const target = targetEl.dataset.target;
      if (target !== store.selected) store.select(target);
      const sel = store.resolve(target);
      if (!sel || sel.kind === 'house') return;
      if (sel.kind === 'door' || sel.kind === 'opening') {
        const pl = sel.kind === 'door' ? placeDoor(sel.floor, sel.item) : placeOpening(sel.floor, sel.item);
        if (!pl) return;
        const along = pl.horizontal ? p.x : p.y;
        drag = { mode: 'slide', sel, place: pl, grab: along - pl.from, moved: false, start: { ...p } };
        store.beginBatch();
        return;
      }
      if (sel.kind === 'site' && isShaped(sel.item)) {
        drag = { mode: 'move-shape', item: sel.item, origPoints: sel.item.points.map((q) => [...q]), start: { ...p }, moved: false };
        store.beginBatch();
        return;
      }
      const box = sel.kind === 'item' ? footprint(sel.item) : sel.kind === 'point' ? { x: sel.item.x, y: sel.item.y, w: 0, h: 0 } : sel.item;
      drag = {
        mode: 'move',
        item: sel.item,
        start: { ...p },
        orig: { x: box.x, y: box.y, w: box.w, h: box.h },
        snap: snapTargets(sel.kind, sel.item),
        kind: sel.kind,
        posOnly: sel.kind === 'item' || sel.kind === 'point',
        grid: sel.kind === 'item' || sel.kind === 'point' ? 0.05 : SNAP,
        moved: false,
      };
      store.beginBatch();
    } else {
      drag = { mode: 'pan', start: { x: evt.clientX, y: evt.clientY }, vb0: { ...vb }, px: mpp(), moved: false };
      svg.classList.add('panning');
    }
  }

  function onPointerMove(evt) {
    if (!drag) return;
    if (drag.mode === 'pan') {
      const dx = (evt.clientX - drag.start.x) * drag.px;
      const dy = (evt.clientY - drag.start.y) * drag.px;
      if (Math.abs(dx) + Math.abs(dy) > 2 * drag.px) drag.moved = true;
      vb = { ...drag.vb0, x: drag.vb0.x - dx, y: drag.vb0.y - dy };
      setViewBox();
      return;
    }
    const p = toWorld(evt);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4 * mpp()) return;
    drag.moved = true;
    const tol = 8 * mpp();

    if (drag.mode === 'wall') {
      let changed = false;
      for (const w of drag.walls) {
        const raw = w.run.coord + (w.run.horizontal ? dy : dx);
        let v = snapValue(raw, w.targets, tol).v;
        v = round(Math.min(Math.max(v, w.limits[0]), w.limits[1]));
        const before = JSON.stringify(w.attached.map((a) => [a.room.x, a.room.y, a.room.w, a.room.h]));
        applyWall(w.run, w.attached, v);
        if (JSON.stringify(w.attached.map((a) => [a.room.x, a.room.y, a.room.w, a.room.h])) !== before) changed = true;
      }
      if (changed) store.changed();
      return;
    }

    if (drag.mode === 'vertex') {
      const pt = drag.item.points[drag.index];
      const nx = round(Math.round(p.x / 0.05) * 0.05);
      const ny = round(Math.round(p.y / 0.05) * 0.05);
      if (pt[0] !== nx || pt[1] !== ny) {
        drag.item.points[drag.index] = [nx, ny];
        syncBox(drag.item);
        store.changed();
      }
      return;
    }
    if (drag.mode === 'move-shape') {
      const sx = round(Math.round(dx / 0.05) * 0.05);
      const sy = round(Math.round(dy / 0.05) * 0.05);
      drag.item.points = drag.origPoints.map((q) => [...q]);
      translate(drag.item, sx, sy);
      store.changed();
      return;
    }
    if (drag.mode === 'resize-item') {
      // resize the footprint, then map it back to the item's own width and depth
      const o = drag.orig;
      const it = drag.item;
      const g = 0.05;
      const min = 0.1;
      let { x, y, w, h } = o;
      const snapG = (v) => round(Math.round(v / g) * g);
      if (drag.handle === 'e') w = Math.max(min, snapG(o.w + dx));
      if (drag.handle === 's') h = Math.max(min, snapG(o.h + dy));
      if (drag.handle === 'w') {
        w = Math.max(min, snapG(o.w - dx));
        x = round(o.x + o.w - w);
      }
      if (drag.handle === 'n') {
        h = Math.max(min, snapG(o.h - dy));
        y = round(o.y + o.h - h);
      }
      const turned = it.rot === 90 || it.rot === 270;
      const next = { x, y, w: turned ? h : w, d: turned ? w : h };
      if (next.x !== it.x || next.y !== it.y || next.w !== it.w || next.d !== it.d) {
        Object.assign(it, next);
        store.changed();
      }
      return;
    }
    if (drag.mode === 'opening-end') {
      // move one end of a window/door along its wall: changes its width (min 0.4 m)
      const { sel, place, end } = drag;
      const along = round(Math.round((place.horizontal ? p.x : p.y) / 0.05) * 0.05);
      const min = 0.4;
      let from = place.from;
      let to = place.to;
      if (sel.kind === 'door') {
        if (end === 'from') from = Math.min(Math.max(along, place.wallFrom), to - min);
        else to = Math.max(Math.min(along, place.wallTo), from + min);
        const offset = round(from - place.wallFrom);
        const width = round(to - from);
        if (offset !== sel.item.offset || width !== sel.item.width) {
          Object.assign(sel.item, { offset, width });
          store.changed();
        }
      } else {
        const e = place.edge;
        const [a, b] = e.horizontal ? [e.x1, e.x2] : [e.y1, e.y2];
        if (end === 'from') from = Math.min(Math.max(along, a), to - min);
        else to = Math.max(Math.min(along, b), from + min);
        const key = place.horizontal ? 'x' : 'y';
        delete sel.item.offset;
        if (round(from) !== sel.item[key] || round(to - from) !== sel.item.width) {
          sel.item[key] = round(from);
          sel.item.width = round(to - from);
          store.changed();
        }
      }
      return;
    }
    if (drag.mode === 'slide') {
      const { sel, place, grab } = drag;
      const along = place.horizontal ? p.x : p.y;
      const width = place.to - place.from;
      if (sel.kind === 'door') {
        const max = Math.max(place.wallTo - place.wallFrom - width, 0);
        const offset = round(Math.min(Math.max(Math.round((along - grab - place.wallFrom) / 0.05) * 0.05, 0), max));
        if (offset !== sel.item.offset) {
          sel.item.offset = offset;
          store.changed();
        }
      } else {
        const e = place.edge;
        const [a, b] = e.horizontal ? [e.x1, e.x2] : [e.y1, e.y2];
        const start = round(Math.min(Math.max(Math.round((along - grab) / 0.05) * 0.05, a), b - width));
        const key = place.horizontal ? 'x' : 'y';
        delete sel.item.offset;
        if (start !== sel.item[key]) {
          sel.item[key] = start;
          store.changed();
        }
      }
      return;
    }

    const o = drag.orig;
    const it = drag.item;
    let { x, y, w, h } = o;
    if (drag.mode === 'move') {
      // snap whichever edge (left/right, top/bottom) is closest to something
      const l = snapValue(o.x + dx, drag.snap.xs, tol, drag.grid);
      const r = snapValue(o.x + o.w + dx, drag.snap.xs, tol, drag.grid);
      x = r.d < l.d ? round(r.v - o.w) : l.v;
      const t = snapValue(o.y + dy, drag.snap.ys, tol, drag.grid);
      const b = snapValue(o.y + o.h + dy, drag.snap.ys, tol, drag.grid);
      y = b.d < t.d ? round(b.v - o.h) : t.v;
    } else {
      const hd = drag.handle;
      const min = 0.5;
      if (hd.includes('w')) {
        const nx = Math.min(snapValue(o.x + dx, drag.snap.xs, tol).v, o.x + o.w - min);
        w = round(o.x + o.w - nx);
        x = nx;
      }
      if (hd.includes('e')) w = Math.max(min, round(snapValue(o.x + o.w + dx, drag.snap.xs, tol).v - o.x));
      if (hd.includes('n')) {
        const ny = Math.min(snapValue(o.y + dy, drag.snap.ys, tol).v, o.y + o.h - min);
        h = round(o.y + o.h - ny);
        y = ny;
      }
      if (hd.includes('s')) h = Math.max(min, round(snapValue(o.y + o.h + dy, drag.snap.ys, tol).v - o.y));
    }
    if (drag.posOnly) {
      if (x !== it.x || y !== it.y) {
        Object.assign(it, { x, y });
        if (it.kind) delete it.auto; // a point moved by hand is kept when regenerating
        store.changed();
      }
    } else if (x !== it.x || y !== it.y || w !== it.w || h !== it.h) {
      Object.assign(it, { x, y, w, h });
      if (drag.kind === 'roofzone') it.fixed = true; // moved by hand: keep it there
      store.changed();
    }
  }

  function onPointerUp(evt) {
    if (!drag) return;
    if (drag.mode === 'pan' && !drag.moved) store.select('house');
    if (drag.mode === 'wall' && !drag.moved && drag.click) {
      const w = wallAt(store.house, store.floor(), drag.start.x, drag.start.y, 10 * mpp());
      if (w) store.select(`${store.floor().id}/${w.key}`);
    }
    svg.classList.remove('panning');
    if (drag.mode !== 'pan') store.endBatch();
    drag = null;
    if (svg.hasPointerCapture(evt.pointerId)) svg.releasePointerCapture(evt.pointerId);
  }

  function onWheel(evt) {
    evt.preventDefault();
    const p = toWorld(evt);
    const k = Math.exp(evt.deltaY * (evt.deltaMode === 1 ? 0.05 : 0.0015));
    const w = Math.min(Math.max(vb.w * k, 4), 300);
    const f = w / vb.w;
    vb = { x: p.x - (p.x - vb.x) * f, y: p.y - (p.y - vb.y) * f, w, h: vb.h * f };
    setViewBox();
    render();
  }

  if (opts.static) {
    render();
    return { svg, render };
  }
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('dblclick', (evt) => {
    // double-click a point of an irregular plot / curved road to remove it
    if (lastVertex && Date.now() - lastVertex.at < 600) {
      const { item, index } = lastVertex;
      lastVertex = null;
      const min = SHAPED[item.type] === 'polygon' ? 3 : 2;
      if (item.points?.length > min) {
        item.points.splice(index, 1);
        syncBox(item);
        store.changed();
      }
      return;
    }
    if (evt.target.closest('[data-target], .handle, .handle-add')) return;
    fit();
    render();
  });
  new ResizeObserver(() => render()).observe(container);

  store.on((reason) => {
    if (['house', 'selection', 'comments', 'floor', 'saved', 'layers'].includes(reason)) render();
  });
  render();
  return { render, fit };
}
