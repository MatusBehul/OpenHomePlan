// SVG symbols for furniture/appliances, utility points and finish fills. All sizes are in
// metres; `px` is metres per screen pixel (or per printed 0.35 mm) for line widths and text.
import { itemInfo, footprint } from './items.js';
import { POINT_KINDS, pointGroup } from './utilities.js';

const n = (v) => Math.round(v * 1000) / 1000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- furniture & appliances ----------

const ABBR = {
  oven: 'O', fridge: 'F', dishwasher: 'DW', washer: 'WM', dryer: 'D', 'boiler-gas': 'GB', 'heat-pump': 'HP',
  'water-heater': 'HW', 'ev-charger': 'EV', 'tv-unit': 'TV', 'towel-rail': 'TR', 'kitchen-tall': '',
  projector: 'P', 'hrv-unit': 'HRV', 'heat-pump-outdoor': 'HP', 'ufh-manifold': 'UFH', 'storage-unit': '',
};

export function itemSymbol(item, px) {
  const info = itemInfo(item);
  const { w, d } = item;
  const f = footprint(item);
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const lw = n(px);
  const fill = item.color || info.color;
  const stroke = '#4a4a4a';
  const r = (x, y, ww, hh, extra = '') => `<rect x="${n(x)}" y="${n(y)}" width="${n(ww)}" height="${n(hh)}" ${extra}/>`;
  const line = (x1, y1, x2, y2) => `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"/>`;
  const base = r(0, 0, w, d, `fill="${fill}"`);
  let detail = '';
  const t = item.type;
  if (t === 'kitchen-wall') {
    // overhead: dashed, see-through so the counter below stays visible
    return group(r(0, 0, w, d, `fill="#fff" fill-opacity="0.01" stroke-dasharray="${n(px * 4)} ${n(px * 3)}"`) + line(0, 0, w, d) + line(w, 0, 0, d));
  }
  if (t.startsWith('bed')) {
    const pw = t === 'bed-single' ? w - 0.2 : (w - 0.3) / 2;
    detail = r(0.1, 0.08, pw, 0.3, 'rx="0.05" fill="#fff"') + (t === 'bed-single' ? '' : r(0.2 + pw, 0.08, pw, 0.3, 'rx="0.05" fill="#fff"')) + line(0, d * 0.42, w, d * 0.42);
  } else if (t === 'sofa-3' || t === 'armchair') {
    detail = r(0, 0, w, 0.22) + r(0, 0, 0.18, d) + r(w - 0.18, 0, 0.18, d);
  } else if (t === 'sofa-corner') {
    return group(`<path d="M0 0 H${n(w)} V${n(0.95)} H${n(0.95)} V${n(d)} H0 Z" fill="${fill}"/><path d="M0 0 H${n(w)} V0.22 H0.22 V${n(d)} H0 Z" fill="none"/>`);
  } else if (t === 'sofa-u') {
    const s = Math.min(0.9, w / 3, d / 2);
    return group(`<path d="M0 0 H${n(w)} V${n(d)} H${n(w - s)} V${n(s)} H${n(s)} V${n(d)} H0 Z" fill="${fill}"/>
      <path d="M0 0 H${n(w)} V${n(d)} H${n(w - 0.22)} V0.22 H0.22 V${n(d)} H0 Z" fill="none"/>`);
  } else if (t === 'shelving' || t === 'closet-shelving' || t === 'bookshelf') {
    const k = Math.max(2, Math.round(w / 0.4));
    for (let i = 1; i < k; i++) detail += line((w / k) * i, 0, (w / k) * i, d);
  } else if (t === 'projector-screen') {
    detail = line(0, d / 2, w, d / 2);
  } else if (t === 'projector') {
    detail = `<circle cx="${n(w / 2)}" cy="${n(d)}" r="0.06" fill="#fff"/>`;
  } else if (t === 'heat-pump-outdoor') {
    detail = `<circle cx="${n(w * 0.38)}" cy="${n(d / 2)}" r="${n(Math.min(d, w) * 0.4)}" fill="none"/>`;
  } else if (t === 'wardrobe' || t === 'kitchen-tall') {
    detail = line(0, 0, w, d) + line(0, d - 0.04, w, d - 0.04);
  } else if (t === 'kitchen-base' || t === 'kitchen-island') {
    detail = line(0, d - 0.05, w, d - 0.05);
  } else if (t === 'sink-kitchen' || t === 'utility-sink') {
    detail = r(0.1, 0.12, w - 0.2, d - 0.22, 'rx="0.06" fill="#fff"') + `<circle cx="${n(w / 2)}" cy="${n(d / 2)}" r="0.025"/>`;
  } else if (t === 'hob') {
    detail = [[0.17, 0.17, 0.1], [0.43, 0.17, 0.08], [0.17, 0.43, 0.08], [0.43, 0.43, 0.1]].map(([x, y, rr]) => `<circle cx="${n((x * w) / 0.6)}" cy="${n((y * d) / 0.6)}" r="${rr}" fill="none" stroke="#bbb"/>`).join('');
  } else if (t.startsWith('dining')) {
    const tableD = 0.9;
    const ty = (d - tableD) / 2;
    const seats = Math.max(1, Math.round(w / 0.6));
    const chairs = [];
    for (let i = 0; i < seats; i++) {
      const x = (w / seats) * (i + 0.5) - 0.22;
      chairs.push(r(x, ty - 0.45, 0.44, 0.4, 'rx="0.05" fill="#d6c3ad"'), r(x, ty + tableD + 0.05, 0.44, 0.4, 'rx="0.05" fill="#d6c3ad"'));
    }
    return group(chairs.join('') + r(0, ty, w, tableD, `fill="${fill}"`));
  } else if (t === 'bathtub') {
    detail = r(0.08, 0.08, w - 0.16, d - 0.16, 'rx="0.2" fill="#fff"') + `<circle cx="${n(w - 0.25)}" cy="${n(d / 2)}" r="0.03"/>`;
  } else if (t === 'shower' || t === 'shower-walkin') {
    detail = line(0, 0, w, d) + line(w, 0, 0, d) + `<circle cx="${n(w / 2)}" cy="${n(d / 2)}" r="0.04" fill="#fff"/>`;
  } else if (t === 'wc') {
    return group(r(0, 0, w, 0.18, `fill="${fill}"`) + `<ellipse cx="${n(w / 2)}" cy="${n(0.18 + (d - 0.18) / 2)}" rx="${n(w / 2 - 0.02)}" ry="${n((d - 0.18) / 2)}" fill="${fill}"/>`);
  } else if (t === 'washbasin' || t === 'vanity-double') {
    const k = t === 'vanity-double' ? 2 : 1;
    for (let i = 0; i < k; i++) detail += `<ellipse cx="${n((w / k) * (i + 0.5))}" cy="${n(d * 0.55)}" rx="${n(w / k / 2 - 0.08)}" ry="${n(d / 2 - 0.1)}" fill="#fff"/>`;
  } else if (t === 'car') {
    return group(r(0, 0, w, d, `rx="0.35" fill="${fill}"`) + r(0.15, 1.2, w - 0.3, 0.6, 'rx="0.1" fill="#b8c4cf"') + r(0.15, d - 1.3, w - 0.3, 0.5, 'rx="0.1" fill="#b8c4cf"'));
  } else if (t === 'coffee-table' || t === 'bookshelf' || t === 'dresser' || t === 'nightstand' || t === 'desk') {
    detail = '';
  }
  const abbr = ABBR[t] ?? '';
  const label = abbr ? `<text x="${n(w / 2)}" y="${n(d / 2 + 0.06)}" font-size="${n(Math.min(0.18, d * 0.45))}" font-weight="700" text-anchor="middle" fill="#333" stroke="none">${abbr}</text>` : '';
  return group(base + detail + label);

  function group(inner) {
    // an invisible full-footprint rectangle makes every item easy to grab (e.g. inside a U-sofa)
    inner = `<rect x="0" y="0" width="${n(w)}" height="${n(d)}" fill="transparent" stroke="none"/>${inner}`;
    return `<g transform="translate(${n(cx)} ${n(cy)}) rotate(${item.rot || 0}) translate(${n(-w / 2)} ${n(-d / 2)})" stroke="${stroke}" stroke-width="${lw}">${inner}</g>`;
  }
}

// ---------- utility points ----------

const POINT_STYLE = {
  socket: ['#d97706', 'S'],
  'socket-counter': ['#d97706', 'K'],
  'socket-400': ['#b45309', '3~'],
  outlet: ['#d97706', 'A'],
  switch: ['#d97706', ''],
  light: ['#d97706', ''],
  'light-wall': ['#d97706', 'W'],
  board: ['#7c2d12', 'RB'],
  data: ['#6b21a8', 'D'],
  'water-cold': ['#2563eb', 'C'],
  'water-hot': ['#dc2626', 'H'],
  drain: ['#78350f', '▼'],
  'meter-water': ['#2563eb', 'WM'],
  gas: ['#ca8a04', 'G'],
  'meter-gas': ['#ca8a04', 'GM'],
};

export function pointSymbol(p, px, showCircuit = false) {
  const [color, letter] = POINT_STYLE[p.kind] || ['#555', '?'];
  const R = 7 * px;
  const x = n(p.x);
  const y = n(p.y);
  let shape;
  if (p.kind === 'light') {
    shape = `<circle cx="${x}" cy="${y}" r="${n(R)}" fill="#fff" stroke="${color}" stroke-width="${n(1.5 * px)}"/>
      <path d="M${n(p.x - R * 0.7)} ${n(p.y - R * 0.7)} L${n(p.x + R * 0.7)} ${n(p.y + R * 0.7)} M${n(p.x + R * 0.7)} ${n(p.y - R * 0.7)} L${n(p.x - R * 0.7)} ${n(p.y + R * 0.7)}" stroke="${color}" stroke-width="${n(1.5 * px)}"/>`;
  } else if (p.kind === 'switch') {
    shape = `<circle cx="${x}" cy="${y}" r="${n(R * 0.6)}" fill="${color}"/>
      <line x1="${x}" y1="${y}" x2="${n(p.x + R * 1.3)}" y2="${n(p.y - R * 1.3)}" stroke="${color}" stroke-width="${n(1.5 * px)}"/>`;
  } else if (p.kind === 'board' || p.kind.startsWith('meter')) {
    shape = `<rect x="${n(p.x - R * 1.3)}" y="${n(p.y - R * 0.8)}" width="${n(R * 2.6)}" height="${n(R * 1.6)}" fill="${color}"/>
      <text x="${x}" y="${n(p.y + R * 0.35)}" font-size="${n(R)}" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text>`;
  } else {
    shape = `<circle cx="${x}" cy="${y}" r="${n(R)}" fill="#fff" stroke="${color}" stroke-width="${n(1.5 * px)}"/>
      <text x="${x}" y="${n(p.y + R * 0.4)}" font-size="${n(letter.length > 1 ? R * 0.85 : R * 1.1)}" font-weight="700" text-anchor="middle" fill="${color}">${letter}</text>`;
  }
  const circuit = showCircuit && p.circuit ? `<text x="${n(p.x + R * 1.2)}" y="${n(p.y - R * 0.9)}" font-size="${n(9 * px)}" fill="${color}">${esc(p.circuit)}</text>` : '';
  return shape + circuit;
}

export function pointColor(kind) {
  return (POINT_STYLE[kind] || ['#555'])[0];
}

// ---------- finishes ----------

// finish: { kind: 'color', color } | { kind: 'tiles', color, texture, tileW, tileH, grout,
//           groutWidth, pattern: 'straight'|'brick'|'diagonal', start: 'NW'|'NE'|'SW'|'SE'|'center' }
export function finishFill(id, zone, finish, assetUrl) {
  if (!finish) return { fill: 'none' };
  if (finish.kind !== 'tiles') return { fill: finish.color || '#dddddd' };
  const tw = Math.max(0.02, finish.tileW || 0.6);
  const th = Math.max(0.02, finish.tileH || 0.6);
  const [ox, oy] = tileOrigin(zone, finish, tw, th);
  const gw = Math.max(finish.groutWidth ?? 0.003, 0.002);
  const grout = finish.grout || '#bdbdbd';
  const tile = (x, y) =>
    finish.texture
      ? `<image href="${esc(assetUrl(finish.texture))}" x="${n(x)}" y="${n(y)}" width="${n(tw)}" height="${n(th)}" preserveAspectRatio="none"/><rect x="${n(x)}" y="${n(y)}" width="${n(tw)}" height="${n(th)}" fill="none" stroke="${grout}" stroke-width="${n(gw)}"/>`
      : `<rect x="${n(x)}" y="${n(y)}" width="${n(tw)}" height="${n(th)}" fill="${finish.color || '#e0dcd4'}" stroke="${grout}" stroke-width="${n(gw)}"/>`;
  const brick = finish.pattern === 'brick';
  const rot = finish.pattern === 'diagonal' ? ` patternTransform="rotate(45 ${n(ox)} ${n(oy)})"` : '';
  const content = brick ? tile(0, 0) + tile(-tw / 2, th) + tile(tw / 2, th) : tile(0, 0);
  const def = `<pattern id="${esc(id)}" patternUnits="userSpaceOnUse" x="${n(ox)}" y="${n(oy)}" width="${n(tw)}" height="${n(brick ? th * 2 : th)}"${rot}>${content}</pattern>`;
  return { fill: `url(#${esc(id)})`, def };
}

// Where the first full tile starts, from the zone's start corner.
export function tileOrigin(zone, finish, tw, th) {
  const s = finish.start || 'NW';
  if (s === 'center') return [zone.x + zone.w / 2 - tw / 2, zone.y + zone.h / 2 - th / 2];
  return [s.includes('E') ? zone.x + zone.w : zone.x, s.includes('S') ? zone.y + zone.h : zone.y];
}

export { pointGroup, POINT_KINDS };
