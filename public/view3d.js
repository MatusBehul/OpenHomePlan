import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { roomColor, siteColor } from './catalog.js';
import { bbox, exteriorEdges, interiorEdges, placeOpening, placeDoor, solidPieces, roundShape, roomOutline, curvedWalls, arcSegments, arcPoint, inRoom } from './geometry.js';
import { analyzeStairs, sortedFloors, stairSteps } from './stairs.js';
import { roofZones, siteRoof, openEdges, roofHeightAt, ROOF_COVERINGS, covering, isGableEnd, roundRoofs, atticRoof as atticRoofOf, atticZoneAt, atticRoofForOpening, kneeWall, isTerraceOnPosts, sitePosts, POST_SIZE, terraceRailEdges } from './roof.js';
import { floorWalls } from './walls.js';
import { ITEMS, itemInfo, footprint, itemPoint } from './items.js';
import { tileOrigin } from './symbols.js';
import { isShaped, smooth, ribbon } from './shapes.js';
import { roomAt } from './items.js';
import { facadeSettings, shutterWidths } from './facade.js';

// Plan coordinates (x east, y south) map to three.js as x → x, y → z, height → y.

const mat = (() => {
  const cache = new Map();
  return (color, opts = {}) => {
    const key = color + JSON.stringify(opts);
    if (!cache.has(key)) cache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts }));
    return cache.get(key);
  };
})();

const M = {
  wall: () => mat('#f3f1ec'),
  wallInner: () => mat('#e9e5de'),
  slab: () => mat('#cfcac2'),
  roof: () => mat('#4a4d52', { roughness: 0.7, side: THREE.DoubleSide }),
  glass: () => mat('#9cc8e8', { transparent: true, opacity: 0.35, roughness: 0.1, metalness: 0.1, depthWrite: false }),
  frame: () => mat('#3b3d40'),
  door: () => mat('#7a5a3a'),
  ground: () => mat('#c9d3b8'),
  rail: () => mat('#555555'),
};

// Planes that keep things below a roof's slopes (less `inset` for the roof build-up): every
// slope is h = h0 + t·d, d measured inwards from its eave line. The volume under a hip,
// gable or mansard roof is convex, so keeping the side below every plane is enough.
function roofClipPlanes(g, inset) {
  const tan = (a) => Math.tan((a * Math.PI) / 180);
  const planes = [];
  // a slope whose eave runs along a rectangle side, rising inwards at t from height h0
  const slope = (r, side, h0, t) => {
    const n = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] }[side];
    const edge = { N: r.y0, S: r.y1, W: r.x0, E: r.x1 }[side];
    const ne = side === 'N' || side === 'S' ? n[1] * edge : n[0] * edge;
    // keep where h0 - inset + t·(n·E − n·p) − y ≥ 0
    const normal = new THREE.Vector3(-t * n[0], -1, -t * n[1]);
    const len = normal.length();
    planes.push(new THREE.Plane(normal.divideScalar(len), (h0 - inset + t * ne) / len));
  };
  const ov = g.overhang ?? 0;
  const o = { x0: g.outer.x - ov, x1: g.outer.x + g.outer.w + ov, y0: g.outer.y - ov, y1: g.outer.y + g.outer.h + ov };
  if (g.type === 'mansard') {
    const m = g.mansard;
    const t = m.brk / (m.inset + ov);
    for (const side of ['N', 'S', 'W', 'E']) slope(o, side, g.eave, t);
    const i = { x0: m.inner.x, x1: m.inner.x + m.inner.w, y0: m.inner.y, y1: m.inner.y + m.inner.h };
    for (const side of ['N', 'S', 'W', 'E']) slope(i, side, g.eave + m.brk, tan(g.cfg.pitch ?? 20));
  } else if (g.type === 'hip' || g.type === 'gable') {
    const t = tan(g.cfg.pitch ?? 35);
    const low = g.eave - ov * t;
    const sides = g.type === 'hip' ? ['N', 'S', 'W', 'E'] : g.cfg.ridge === 'y' ? ['W', 'E'] : ['N', 'S'];
    for (const side of sides) slope(o, side, low, t);
  }
  return planes;
}

// A darker shade of a #rrggbb colour (k < 1).
const darken = (hex, k) => {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0xf3f1ec;
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

// Roof covering material: colour per covering, a little metallic sheen for zinc and steel.
const coverMat = (key) => {
  const c = ROOF_COVERINGS[key] || ROOF_COVERINGS.slate;
  return mat(c.color, { roughness: c.metal ? 0.45 : 0.75, metalness: c.metal ? 0.35 : 0, side: THREE.DoubleSide });
};

function box(w, h, d, material, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, 0.001), Math.max(h, 0.001), Math.max(d, 0.001)), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// A wall along a plan segment from (x1,y1) to (x2,y2), axis-centred, between heights y0..y1.
function wallPiece(seg, from, to, y0, y1, thick, material, extendEnds = 0) {
  const a = from - extendEnds;
  const b = to + extendEnds;
  if (b - a <= 0.001 || y1 - y0 <= 0.001) return null;
  const mid = (a + b) / 2;
  return seg.horizontal
    ? box(b - a, y1 - y0, thick, material, mid, (y0 + y1) / 2, seg.y1)
    : box(thick, y1 - y0, b - a, material, seg.x1, (y0 + y1) / 2, mid);
}

// A room's floor slab (or finish layer) from y0 up by `thick`; round rooms follow their outline.
function roomSlab(r, y0, thick, material) {
  if (!roundShape(r)) return box(r.w, thick, r.h, material, r.x + r.w / 2, y0 + thick / 2, r.y + r.h / 2);
  const shape = new THREE.Shape(roomOutline(r).map(([x, y]) => new THREE.Vector2(x, -y)));
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false }), material);
  m.rotation.x = -Math.PI / 2;
  m.position.y = y0;
  m.receiveShadow = true;
  return m;
}

// A wall under a roof: from y0 up to y1, but never above the roof surface (less its build-up),
// so attic walls follow the slopes instead of poking through them.
function roofWall(seg, from, to, y0, y1, thick, material, geom) {
  if (to - from <= 0.001) return null;
  const n = Math.max(1, Math.ceil((to - from) / 0.1));
  const tops = [];
  for (let i = 0; i <= n; i++) {
    const s = from + ((to - from) * i) / n;
    const [x, z] = seg.horizontal ? [s, seg.y1] : [seg.x1, s];
    const roofY = roofHeightAt(geom, x, z);
    tops.push([s, Math.max(y0, Math.min(y1, roofY === null ? y1 : roofY - 0.3))]);
  }
  if (tops.every(([, t]) => t - y0 < 0.05)) return null;
  const shape = new THREE.Shape([new THREE.Vector2(from, y0), new THREE.Vector2(to, y0), ...tops.reverse().map(([s, t]) => new THREE.Vector2(s, t))]);
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false }), material);
  if (seg.horizontal) m.position.z = seg.y1 - thick / 2;
  else {
    m.rotation.y = -Math.PI / 2;
    m.position.x = seg.x1 + thick / 2;
  }
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function create3D(container, store) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.localClippingEnabled = true; // furniture in a cut-away is cut at the section height
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.domElement.style.position = 'absolute';
  labels.domElement.style.inset = '0';
  labels.domElement.style.pointerEvents = 'none';
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dfe8ef');
  scene.fog = new THREE.Fog('#dfe8ef', 90, 200);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.03;

  scene.add(new THREE.HemisphereLight('#ffffff', '#b9b2a2', 1.4));
  const sun = new THREE.DirectionalLight('#fff6e8', 2.2);
  // sun from the south-west (garden side), high in the sky
  sun.position.set(-20, 30, 35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 120 });
  scene.add(sun, sun.target);

  let mode = 'whole';
  let model = null;
  let selectionHelper = null;
  let initialised = false;

  function build() {
    if (model) {
      scene.remove(model);
      model.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.element) o.element.remove();
      });
    }
    model = new THREE.Group();
    const house = store.house;
    const ext = house.wall?.exterior ?? 0.4;
    const int = house.wall?.interior ?? 0.15;
    const all = house.floors.flatMap((f) => f.rooms);
    const hb = bbox(all);

    // ---------- site ----------
    const plot = house.site.find((s) => s.type === 'plot');
    const area = plot ? bbox([plot, hb]) : { x: hb.x - 15, y: hb.y - 15, w: hb.w + 30, h: hb.h + 30 };
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), M.ground());
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(area.x + area.w / 2, -0.02, area.y + area.h / 2);
    ground.receiveShadow = true;
    model.add(ground);

    for (const s of house.site) model.add(siteObject(s));

    // ---------- floors ----------
    // "whole" shows everything with the roof; a floor id cuts the house above that floor
    // and shows the floor above as a see-through slab, so you can see where stairs lead.
    const floors = sortedFloors(house);
    const cut = floors.find((f) => f.id === mode);
    const visibleFloors = cut ? floors.filter((f) => (f.elevation ?? 0) <= (cut.elevation ?? 0)) : floors;
    const ghost = cut ? floors[floors.indexOf(cut) + 1] : null;
    if (ghost) {
      const glass = mat('#8aa6c1', { transparent: true, opacity: 0.1, depthWrite: false });
      const outline = new THREE.LineBasicMaterial({ color: '#5b7590', transparent: true, opacity: 0.7 });
      for (const r of ghost.rooms) {
        if (r.type === 'void') continue;
        const slab = box(r.w, 0.25, r.h, glass, r.x + r.w / 2, (ghost.elevation ?? 0) - 0.125, r.y + r.h / 2);
        slab.castShadow = false;
        slab.receiveShadow = false;
        model.add(slab);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), outline);
        edges.position.copy(slab.position);
        model.add(edges);
      }
    }
    floors.forEach((floor, fi) => {
      if (!visibleFloors.includes(floor)) return;
      const g = new THREE.Group();
      const e0 = floor.elevation ?? fi * 3;
      const H = floor.height ?? 2.8;
      // the inspected floor of a cut-away is cut like a floor plan, at 1.6 m
      const W = floor === cut ? Math.min(H, 1.6) : H;
      const slabT = 0.25;
      const edges = exteriorEdges(floor);

      // floor slabs per room (the stair void stays open)
      for (const r of floor.rooms) {
        if (r.type === 'void') continue;
        const slab = roomSlab(r, e0 - slabT, slabT, M.slab());
        g.add(slab);
        const top = roomSlab(r, e0, 0.02, finishMaterial(r.finish?.floor, r, mat(roomColor(r.type))));
        top.userData.target = `${floor.id}/${r.id}`;
        top.receiveShadow = true;
        g.add(top);
        // generous invisible pick volume so rooms are easy to click
        const pick = box(r.w, H * 0.9, r.h, new THREE.MeshBasicMaterial({ visible: false }), r.x + r.w / 2, e0 + H * 0.45, r.y + r.h / 2);
        pick.userData.target = `${floor.id}/${r.id}`;
        pick.userData.pickOnly = true;
        g.add(pick);
        if (r.type === 'stairs') g.add(stairs(floor, r, e0));
      }

      // exterior walls with openings (an attic under the roof has dormers instead)
      const openings = (floor.openings || []).map((o) => ({ o, p: placeOpening(floor, o, edges) })).filter((x) => x.p);
      const atticRoof = floor.underRoof ? roofOver(house, floor) : null;
      // a cut-away of an attic: the roof slopes cut at 1.6 m like walls, open where the dormers are
      const section = atticRoof?.geom && floor === cut ? atticSection(g, atticRoof.geom, e0, W, openings) : null;
      if (floor.underRoof) for (const { o, p } of openings) g.add(dormer(floor, o, p, e0, ext, { ...atticRoof, geom: atticRoofForOpening(house, floor, p) || atticRoof.geom }, section));
      // an attic with a knee wall has short outer walls up to the eaves (its windows are dormers
      // or sit in the gable ends, drawn above); a full floor has walls with its openings
      const knee = kneeWall(floor);
      const wallTop = floor.underRoof ? Math.min(knee, W) : W;
      for (const seg of floor.underRoof && !knee ? [] : edges) {
        const along = seg.horizontal ? [seg.x1, seg.x2] : [seg.y1, seg.y2];
        const mine = openings
          .filter(({ p }) => p.edge === seg)
          .sort((a, b) => a.p.from - b.p.from);
        let cursor = along[0];
        const pieces = [];
        for (const { o, p } of mine) {
          pieces.push([cursor, p.from, 0, wallTop]);
          const sill = Math.min(o.sill ?? 0, wallTop);
          const head = Math.min(wallTop, sill + (o.height ?? 1.4));
          if (sill > 0) pieces.push([p.from, p.to, 0, sill]);
          if (!floor.underRoof) {
            if (head < W) pieces.push([p.from, p.to, head, W]);
            if (head - sill > 0.05) g.add(openingObject(seg, o, p, e0, sill, head, ext));
          }
          cursor = p.to;
        }
        pieces.push([cursor, along[1], 0, wallTop]);
        pieces.forEach(([a, b, y0, y1], i) => {
          const first = i === 0;
          const last = i === pieces.length - 1;
          // extend the outer ends by half the wall so corners close
          const w = wallPiece(seg, a - (first ? ext / 2 : 0), b + (last ? ext / 2 : 0), e0 + y0, e0 + y1, ext, mat(facadeSettings(house).render));
          if (w) g.add(w);
        });
      }

      if (!floor.underRoof) for (const cw of curvedWalls(floor)) curvedWall(g, house, floor, cw, e0, W, ext, int, openings, floors);

      // interior walls by type (wall / railing / glass / open) with door gaps
      const inner = interiorEdges(floor);
      const doors = (floor.doors || []).map((d) => ({ d, p: placeDoor(floor, d, inner) })).filter((x) => x.p);
      const props = new Map(floorWalls(house, floor).inner.map((w) => [w.key, w.props]));
      // the roof over a piece of wall (an attic can sit under several roof areas)
      const geomAt = (e, a, b) => {
        const [x, y] = e.horizontal ? [(a + b) / 2, e.y1] : [e.x1, (a + b) / 2];
        return atticZoneAt(house, floor, x, y) || atticRoof.geom;
      };
      for (const e of inner) {
        const key = `wall:${e.rooms.map((i) => floor.rooms[i].id).sort().join(':')}`;
        const { type = 'wall', thickness = int, loadBearing, beam } = props.get(key) || {};
        if (beam && !atticRoof) {
          const len = e.horizontal ? e.x2 - e.x1 : e.y2 - e.y1;
          const depth = 0.3; // visible below the ceiling
          const b = e.horizontal
            ? box(len, depth, 0.25, mat('#e2d9cb'), (e.x1 + e.x2) / 2, e0 + H - depth / 2, e.y1)
            : box(0.25, depth, len, mat('#e2d9cb'), e.x1, e0 + H - depth / 2, (e.y1 + e.y2) / 2);
          b.userData.target = `${floor.id}/${key}`;
          if (W >= H - 0.01) g.add(b); // not in a cut-away below the cut height
        }
        if (type === 'none') continue;
        const mine = doors.filter(({ p }) => p.edge === e);
        const from = e.horizontal ? e.x1 : e.y1;
        const to = e.horizontal ? e.x2 : e.y2;
        const material = type === 'railing' ? M.rail() : type === 'glass' ? M.glass() : loadBearing ? mat('#e2d9cb') : M.wallInner();
        let top = type === 'railing' ? Math.min(1.0, W) : W - 0.01;
        let lo = from;
        let hi = to;
        const thick = type === 'railing' ? 0.05 : type === 'glass' ? 0.04 : thickness;
        if (atticRoof?.geom) {
          // under a roof: walls follow the slopes (and stop at the cut height in a cut-away)
          for (const [a, b] of solidPieces(lo, hi, mine.map(({ p }) => [p.from, p.to]))) {
            const w = roofWall(e, a, b, e0, e0 + top, thick, material, geomAt(e, a, b));
            if (w) {
              w.userData.target = `${floor.id}/${key}`;
              g.add(w);
            }
          }
          if (type !== 'wall' && type !== 'glass') continue;
          for (const { d, p } of mine) {
            const head = Math.min(d.height ?? 2.1, W);
            const header = roofWall(e, p.from, p.to, e0 + head, e0 + W - 0.01, thick, material, geomAt(e, p.from, p.to));
            if (header) g.add(header);
            const leaf = doorLeaf(floor, d, p, e0, head, thick);
            if (leaf) g.add(leaf);
          }
          continue;
        }
        if (atticRoof) {
          // under the roof: keep interior walls inside the roof's steep part and below its break
          const c = section || atticRoof.clip;
          const across = e.horizontal ? e.y1 : e.x1;
          const [a0, a1, c0, c1] = e.horizontal ? [c.x0, c.x1, c.y0, c.y1] : [c.y0, c.y1, c.x0, c.x1];
          if (across < c0 || across > c1) continue;
          lo = Math.max(from, a0);
          hi = Math.min(to, a1);
          if (hi - lo < 0.05) continue;
          top = Math.min(top, c.top);
        }
        for (const [a, b] of solidPieces(lo, hi, mine.map(({ p }) => [p.from, p.to]))) {
          const w = wallPiece(e, a, b, e0, e0 + top, thick, material);
          if (w) {
            w.userData.target = `${floor.id}/${key}`;
            if (type === 'glass') w.castShadow = false;
            g.add(w);
          }
        }
        if (type !== 'wall' && type !== 'glass') continue;
        for (const { d, p } of mine) {
          const head = Math.min(d.height ?? 2.1, W);
          const header = wallPiece(e, p.from, p.to, e0 + head, e0 + W - 0.01, thick, material);
          if (header) g.add(header);
          const leaf = doorLeaf(floor, d, p, e0, head, thick);
          if (leaf) g.add(leaf);
        }
      }

      // facade details: base, bands, cornice, corner stones, surrounds, shutters, Juliet balconies
      if (!floor.underRoof) addFacade(g, house, floor, floors, e0, H, W, edges, openings, ext);

      // tile zones on top of the room floor
      for (const r of floor.rooms)
        for (const z of r.zones || []) {
          if (!z.finish) continue;
          const zm = box(z.w, 0.004, z.h, finishMaterial(z.finish, z, M.slab()), z.x + z.w / 2, e0 + 0.023 + (z.order || 0) * 0.0005, z.y + z.h / 2);
          zm.castShadow = false;
          zm.userData.target = `${floor.id}/${r.id}`;
          g.add(zm);
        }
      // wall finishes (tiles/paint up to a height on the room side of its walls)
      for (const r of floor.rooms) if (r.finish?.walls) addWallFinish(g, house, floor, r, e0, W);
      // furniture & appliances
      // furniture is cut at the section height in a cut-away, and kept under the roof in an attic
      const cutPlanes = floor === cut ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), e0 + W)] : [];
      for (const it of floor.items || []) {
        const obj = itemObject(floor, it, e0);
        const turned = it.rot === 90 || it.rot === 270;
        const over = atticRoof?.geom ? atticZoneAt(house, floor, it.x + (turned ? it.d : it.w) / 2, it.y + (turned ? it.w : it.d) / 2) || atticRoof.geom : null;
        const planes = [...cutPlanes, ...(over ? roofClipPlanes(over, 0.25) : [])];
        if (planes.length)
          obj.traverse((m) => {
            if (!m.material) return;
            m.material = m.material.clone();
            m.material.clippingPlanes = planes;
            m.material.clipShadows = true;
          });
        g.add(obj);
      }

      // room labels for the cut-away views
      const showLabels = mode === floor.id;
      if (showLabels) {
        for (const r of floor.rooms) {
          const count = store.openComments(`${floor.id}/${r.id}`);
          const el = document.createElement('div');
          el.className = 'label3d';
          el.innerHTML = `${escapeHtml(r.name)}${count ? `<span class="c">● ${count}</span>` : ''}`;
          const label = new CSS2DObject(el);
          label.position.set(r.x + r.w / 2, e0 + 0.2, r.y + r.h / 2);
          g.add(label);
        }
      }
      model.add(g);
    });

    // ---------- roof ----------
    // every roof area; a cut-away shows only the roofs below the cut (e.g. a roof terrace)
    const zones = roofZones(house);
    const cutElev = cut ? cut.elevation ?? 0 : Infinity;
    for (const z of zones) {
      const g = z.geom;
      // in a cut-away: roofs up to the cut level stay, except those over the floor being cut
      // (roof outlines include the outer walls, so a strip as thin as a wall doesn't count)
      const overCut = cut && cut.rooms.some((r) => Math.min(r.x + r.w, g.outer.x + g.outer.w) - Math.max(r.x, g.outer.x) > ext && Math.min(r.y + r.h, g.outer.y + g.outer.h) - Math.max(r.y, g.outer.y) > ext);
      const visible = mode === 'whole' || (z.floor && g.eave <= cutElev + 0.01 && !overCut);
      if (!visible) continue;
      const target = z.zone ? `roofs/${z.zone.id}` : 'roof';
      model.add(roof(g, { target, walkable: g.type === 'flat' && g.cfg.walkable, house }));
      for (const c of z.zone?.chimneys || []) model.add(chimney(c, g, target));
    }
    // cone roofs over round rooms (towers, bays)
    for (const c of roundRoofs(house)) {
      const overCut = cut && cut.rooms.some((r) => inRoom(r, c.shape.cx, c.shape.cy));
      if (mode !== 'whole' && (c.eave > cutElev + 0.01 || overCut)) continue;
      model.add(coneRoof(c));
    }
    if (mode === 'whole' && house.floors.length) {
      const eave = zones.length ? Math.max(...zones.map((z) => z.geom.eave + z.geom.rise)) : 6;
      // whole-house comment marker above the ridge
      const count = store.openComments('house');
      if (count) {
        const el = document.createElement('div');
        el.className = 'label3d';
        el.innerHTML = `Whole house<span class="c">● ${count}</span>`;
        const label = new CSS2DObject(el);
        label.position.set(hb.x + hb.w / 2, eave + 4.5, hb.y + hb.h / 2);
        model.add(label);
      }
    }

    scene.add(model);
    updateSelection();

    if (!initialised) {
      initialised = true;
      const c = new THREE.Vector3(hb.x + hb.w / 2, 2.5, hb.y + hb.h / 2);
      controls.target.copy(c);
      // view from the south-east (garden side)
      camera.position.set(c.x + 26, 24, c.z + 36);
      sun.target.position.copy(c);
      controls.update();
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // Solid steps exactly as calculated in stairs.js; a landing (if any) stays at the foot.
  // ---------- finishes ----------

  const textures = new Map();
  let pendingImages = 0; // tile photos still loading (snapshots wait for them)
  // A canvas texture showing one tile (two rows for brick bond) with grout; the uploaded
  // photo is drawn in when it has loaded.
  function tileTexture(f) {
    const key = JSON.stringify([f.texture, f.color, f.grout, f.groutWidth, f.tileW, f.tileH, f.pattern]);
    if (textures.has(key)) return textures.get(key);
    const tw = f.tileW || 0.6;
    const th = f.tileH || 0.6;
    const brick = f.pattern === 'brick';
    const S = 512;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = brick ? S : Math.max(16, Math.round((S * th) / tw));
    const ctx = canvas.getContext('2d');
    const rows = brick ? 2 : 1;
    const cw = canvas.width;
    const ch = canvas.height / rows;
    const gw = Math.max(1, ((f.groutWidth ?? 0.003) / tw) * cw);
    const draw = (img) => {
      ctx.fillStyle = f.grout || '#bdbdbd';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const tile = (x, y) => {
        if (img) ctx.drawImage(img, x + gw / 2, y + gw / 2, cw - gw, ch - gw);
        else {
          ctx.fillStyle = f.color || '#e0dcd4';
          ctx.fillRect(x + gw / 2, y + gw / 2, cw - gw, ch - gw);
        }
      };
      tile(0, 0);
      if (brick) {
        tile(-cw / 2, ch);
        tile(cw / 2, ch);
      }
      tex.needsUpdate = true;
    };
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    draw(null);
    if (f.texture) {
      const img = new Image();
      pendingImages++;
      img.onload = () => {
        draw(img);
        pendingImages--;
      };
      img.onerror = () => pendingImages--;
      img.src = store.assetUrl(f.texture);
    }
    const out = { tex, tw, th: th * rows };
    textures.set(key, out);
    return out;
  }

  // Material for a floor finish over a rectangle (room or zone) of the plan.
  function finishMaterial(f, rect, fallback) {
    if (!f || f.kind === 'none') return fallback;
    if (f.kind === 'color') return mat(f.color || '#d9cbb3');
    const { tex, tw, th } = tileTexture(f);
    const t = tex.clone();
    t.needsUpdate = true;
    // BoxGeometry top face: u runs east, v runs north
    t.repeat.set(rect.w / tw, rect.h / th);
    const [ox, oy] = tileOrigin(rect, f, f.tileW || 0.6, f.tileH || 0.6);
    t.offset.set((((rect.x - ox) / tw) % 1 + 1) % 1, ((-(rect.y + rect.h - oy) / th) % 1 + 1) % 1);
    if (f.pattern === 'diagonal') {
      t.center.set(0.5, 0.5);
      t.rotation = Math.PI / 4;
    }
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 });
  }

  function wallFinishMaterial(f, length, height) {
    if (f.kind === 'color') return mat(f.color || '#e8e2d6');
    const { tex, tw, th } = tileTexture(f);
    const t = tex.clone();
    t.needsUpdate = true;
    t.repeat.set(length / tw, height / th);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.5 });
  }

  // Thin skins on the room side of every wall around the room, cut around doors and windows.
  function addWallFinish(g, house, floor, room, e0, H) {
    const f = room.finish.walls;
    const top = Math.min(f.height ?? H, H);
    const { inner, outer } = floorWalls(house, floor);
    const segs = [
      ...inner.filter((w) => w.desc.between.includes(room.id) && w.props.type === 'wall'),
      ...outer.filter((w) => w.desc.room === room.id),
    ];
    const innerEdges = interiorEdges(floor);
    const doorSpans = (floor.doors || [])
      .filter((d) => d.between.includes(room.id))
      .map((d) => placeDoor(floor, d, innerEdges))
      .filter(Boolean);
    const edges = exteriorEdges(floor);
    const windows = (floor.openings || []).map((o) => ({ o, p: placeOpening(floor, o, edges) })).filter((x) => x.p);
    for (const w of segs) {
      const centre = w.horizontal ? room.y + room.h / 2 : room.x + room.w / 2;
      const side = centre < w.coord ? -1 : 1;
      const off = w.coord + side * ((w.props.thickness ?? 0.15) / 2 + 0.004);
      const onLine = (p) => p.horizontal === w.horizontal && Math.abs((p.coord ?? (p.horizontal ? p.y1 : p.x1)) - w.coord) < 0.01;
      // pieces: [from, to, y0, y1]
      const holes = [
        ...doorSpans.filter(onLine).map((p) => [p.from, p.to, 0, Math.min(2.1, top)]),
        ...windows.filter(({ p }) => onLine(p)).map(({ o, p }) => [p.from, p.to, o.sill ?? 0, Math.min((o.sill ?? 0) + (o.height ?? 1.4), top)]),
      ];
      const xs = [...new Set([w.from, w.to, ...holes.flatMap(([a, b]) => [a, b])])].filter((v) => v >= w.from - 1e-6 && v <= w.to + 1e-6).sort((a, b) => a - b);
      for (let i = 0; i < xs.length - 1; i++) {
        const [a, b] = [xs[i], xs[i + 1]];
        if (b - a < 0.01) continue;
        const mid = (a + b) / 2;
        const hole = holes.find(([ha, hb]) => mid > ha && mid < hb);
        const bands = hole ? [[0, hole[2]], [hole[3], top]] : [[0, top]];
        for (const [y0, y1] of bands) {
          if (y1 - y0 < 0.01) continue;
          const skin = w.horizontal
            ? box(b - a, y1 - y0, 0.006, wallFinishMaterial(f, b - a, y1 - y0), mid, e0 + (y0 + y1) / 2, off)
            : box(0.006, y1 - y0, b - a, wallFinishMaterial(f, b - a, y1 - y0), off, e0 + (y0 + y1) / 2, mid);
          skin.castShadow = false;
          skin.userData.target = `${floor.id}/${room.id}`;
          g.add(skin);
        }
      }
    }
  }

  // ---------- furniture & appliances ----------

  function itemObject(floor, it, e0) {
    const g = new THREE.Group();
    const info = itemInfo(it);
    const f = footprint(it);
    const h = it.h ?? info.h;
    const color = it.color || info.color;
    const cx = f.x + f.w / 2;
    const cz = f.y + f.h / 2;
    const turned = it.rot === 90 || it.rot === 270;
    // a box given in the item's own frame (u along the front, v from the back)
    const local = (u, v, w, d, y0, y1, material) => {
      const [x, z] = itemPoint(it, u + w / 2, v + d / 2);
      return box(turned ? d : w, y1 - y0, turned ? w : d, material, x, e0 + (y0 + y1) / 2, z);
    };
    const m = mat(color);
    const t = it.type;
    if (t.startsWith('dining')) {
      const ty = (it.d - 0.9) / 2;
      g.add(local(0, ty, it.w, 0.9, 0.72, 0.76, m));
      for (const [u, v] of [[0.05, ty + 0.05], [it.w - 0.1, ty + 0.05], [0.05, ty + 0.8], [it.w - 0.1, ty + 0.8]]) g.add(local(u, v, 0.05, 0.05, 0, 0.72, m));
      const seats = Math.max(1, Math.round(it.w / 0.6));
      const chair = mat('#d6c3ad');
      for (let i = 0; i < seats; i++) {
        const u = (it.w / seats) * (i + 0.5) - 0.22;
        g.add(local(u, ty - 0.45, 0.44, 0.4, 0, 0.45, chair), local(u, ty + 0.95, 0.44, 0.4, 0, 0.45, chair));
      }
    } else if (t === 'sofa-3' || t === 'armchair' || t === 'sofa-corner') {
      g.add(local(0, 0, it.w, it.d, 0, 0.42, m), local(0, 0, it.w, 0.22, 0.42, h, m));
      if (t !== 'sofa-corner') g.add(local(0, 0, 0.18, it.d, 0.42, 0.62, m), local(it.w - 0.18, 0, 0.18, it.d, 0.42, 0.62, m));
    } else if (t.startsWith('bed')) {
      g.add(local(0, 0, it.w, it.d, 0, h, m), local(0, 0, it.w, 0.08, 0, 1.0, mat('#a98b6b')));
      g.add(local(0.1, 0.12, it.w - 0.2, 0.32, h, h + 0.1, mat('#ffffff')));
    } else if (t === 'kitchen-base' || t === 'kitchen-island' || t === 'sink-kitchen' || t === 'hob' || t === 'dishwasher' || t === 'oven') {
      // a hob is a cooktop on a normal cabinet
      const body = t === 'hob' ? mat('#e9e4da') : m;
      g.add(local(0, 0, it.w, it.d, 0, h - 0.04, body), local(0, 0, it.w, it.d, h - 0.04, h, mat(t === 'hob' ? '#1f2124' : '#6b6259')));
    } else if (t === 'car') {
      g.add(local(0, 0, it.w, it.d, 0.2, 0.85, m), local(0.1, 1.1, it.w - 0.2, 2.2, 0.85, h, mat('#9fb0bf')));
    } else if (t === 'shower' || t === 'shower-walkin') {
      g.add(local(0, 0, it.w, it.d, 0, 0.05, m));
      const glass = mat('#cfe3ee', { transparent: true, opacity: 0.3, depthWrite: false });
      g.add(local(0, it.d - 0.01, it.w, 0.01, 0.05, 2.0, glass));
    } else if (info.mount !== undefined) {
      // ceiling- or wall-mounted
      const y0 = info.mount === 'ceiling' ? (floor.height ?? 2.8) - 0.4 - h : info.mount;
      g.add(local(0, 0, it.w, it.d, y0, y0 + h, m));
    } else if (t === 'sofa-u') {
      const s = Math.min(0.9, it.w / 3, it.d / 2);
      g.add(local(0, 0, it.w, s, 0, 0.42, m), local(0, s, s, it.d - s, 0, 0.42, m), local(it.w - s, s, s, it.d - s, 0, 0.42, m));
      g.add(local(0, 0, it.w, 0.22, 0.42, h, m), local(0, 0.22, 0.22, it.d - 0.22, 0.42, 0.65, m), local(it.w - 0.22, 0.22, 0.22, it.d - 0.22, 0.42, 0.65, m));
    } else if (t === 'ev-charger' || t === 'towel-rail' || t === 'boiler-gas') {
      // wall-mounted
      const y0 = t === 'boiler-gas' ? 1.2 : t === 'ev-charger' ? 1.0 : 0.4;
      g.add(local(0, 0, it.w, it.d, y0, y0 + h, m));
    } else {
      g.add(box(f.w, h, f.h, m, cx, e0 + h / 2, cz));
    }
    g.traverse((o) => {
      o.userData.target = `${floor.id}/${it.id}`;
    });
    return g;
  }

  function stairs(floor, r, e0) {
    // solid steps from the floor up to each tread, from the same geometry as the plan
    const g = new THREE.Group();
    const a = analyzeStairs(store.house, floor, r);
    const wood = mat(a.issues.length ? '#c0805a' : '#b08a63');
    for (const t of stairSteps(a).treads) {
      const shape = new THREE.Shape(t.pts.map(([x, y]) => new THREE.Vector2(x, -y)));
      const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: t.h, bevelEnabled: false }), wood);
      m.rotation.x = -Math.PI / 2;
      m.position.y = e0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.target = `${floor.id}/${r.id}`;
      g.add(m);
    }
    return g;
  }

  // Interior door leaf, shown open: hinged doors at 90° into the swing room, sliding
  // doors parked beside the opening.
  function doorLeaf(floor, d, p, e0, head, T) {
    if (d.type === 'opening') return null;
    const room = floor.rooms.find((r) => r.id === (d.swing || d.between[1]));
    const centre = room ? (p.horizontal ? room.y + room.h / 2 : room.x + room.w / 2) : p.coord + 1;
    const side = centre < p.coord ? -1 : 1;
    const w = p.to - p.from - 0.04;
    const h = head - 0.02;
    const y = e0 + h / 2;
    let leaf;
    if (d.type === 'sliding') {
      const mid = (p.from + p.to) / 2 + w * 0.55;
      const off = p.coord + side * (T / 2 + 0.04);
      leaf = p.horizontal ? box(w, h, 0.04, M.door(), mid, y, off) : box(0.04, h, w, M.door(), off, y, mid);
    } else {
      const hinge = d.hinge === 'end' ? p.to - 0.02 : p.from + 0.02;
      const across = p.coord + side * (T / 2 + w / 2);
      leaf = p.horizontal ? box(0.04, h, w, M.door(), hinge, y, across) : box(w, h, 0.04, M.door(), across, y, hinge);
    }
    leaf.userData.target = `${floor.id}/${d.id}`;
    return leaf;
  }

  function openingObject(seg, o, p, e0, sill, head, ext) {
    const g = new THREE.Group();
    const len = p.to - p.from;
    const mid = (p.from + p.to) / 2;
    const h = head - sill;
    const cy = e0 + sill + h / 2;
    const at = (w, hh, d, material, offset = 0) =>
      seg.horizontal ? box(w, hh, d, material, mid, cy, seg.y1 + offset) : box(d, hh, w, material, seg.x1 + offset, cy, mid);
    if (o.type === 'door') {
      g.add(at(len - 0.1, h - 0.05, 0.06, M.door()));
    } else {
      const pane = at(len - 0.08, h - 0.08, 0.03, M.glass());
      pane.castShadow = false;
      g.add(pane);
      // simple frame
      const t = 0.06;
      const fr = (w, hh, dy, dAlong) => {
        const b = seg.horizontal
          ? box(w, hh, 0.08, M.frame(), mid + dAlong, cy + dy, seg.y1)
          : box(0.08, hh, w, M.frame(), seg.x1, cy + dy, mid + dAlong);
        g.add(b);
      };
      fr(len, t, h / 2 - t / 2, 0);
      fr(len, t, -h / 2 + t / 2, 0);
      fr(t, h, 0, len / 2 - t / 2);
      fr(t, h, 0, -len / 2 + t / 2);
    }
    // a slim window sill / threshold outside
    if (sill > 0) {
      const out = { N: -1, S: 1, W: -1, E: 1 }[o.facade] * (ext / 2 + 0.03);
      const s = seg.horizontal
        ? box(len + 0.1, 0.04, 0.1, mat('#9c9a95'), mid, e0 + sill - 0.02, seg.y1 + out)
        : box(0.1, 0.04, len + 0.1, mat('#9c9a95'), seg.x1 + out, e0 + sill - 0.02, mid);
      g.add(s);
    }
    return g;
  }

  // Convex polygon surface from 3D points [x, y, z] (fan triangulation).
  function poly(points, material) {
    const pos = [];
    for (let i = 1; i < points.length - 1; i++) pos.push(...points[0], ...points[i], ...points[i + 1]);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.computeVertexNormals();
    const m = new THREE.Mesh(geom, material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // Roof from roof.js: flat (with parapet), mono-pitch, gable or hip.
  function roof(rg, { target = 'roof', material = null, wallMat = mat('#f3f1ec', { side: THREE.DoubleSide }), flatMat = mat('#5a5d62'), parapetMat = M.wall(), walkable = false, house = null } = {}) {
    const g = new THREE.Group();
    const { cfg, type, outer, eave, rise, ext } = rg;
    material ||= coverMat(covering(cfg));
    const ov = rg.overhang;
    if (walkable) {
      // roof terrace: paved slab and a balustrade, except where it meets a taller wall
      const cx = outer.x + outer.w / 2;
      const cz = outer.y + outer.h / 2;
      g.add(box(outer.w, 0.3, outer.h, mat('#cfc7b8'), cx, eave + 0.15, cz));
      const y0 = eave + 0.3;
      const rail = mat('#2f3133');
      for (const [x1, z1, x2, z2] of house ? openEdges(house, rg) : []) {
        const len = Math.hypot(x2 - x1, z2 - z1);
        const horiz = z1 === z2;
        const mx = (x1 + x2) / 2;
        const mz = (z1 + z2) / 2;
        g.add(horiz ? box(len, 0.12, 0.2, parapetMat, mx, y0 + 0.06, mz) : box(0.2, 0.12, len, parapetMat, mx, y0 + 0.06, mz));
        g.add(horiz ? box(len, 0.05, 0.08, rail, mx, y0 + 1.0, mz) : box(0.08, 0.05, len, rail, mx, y0 + 1.0, mz));
        const n = Math.max(2, Math.round(len / 0.13));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          g.add(box(0.025, 0.88, 0.025, rail, x1 + (x2 - x1) * t, y0 + 0.56, z1 + (z2 - z1) * t));
        }
      }
      g.traverse((o) => (o.userData.target = target));
      return g;
    }
    if (type === 'mansard') {
      // steep lower faces to the break, a cornice at the eaves, and a shallow hipped top
      const m = rg.mansard;
      const o = { x0: outer.x - ov, y0: outer.y - ov, x1: outer.x + outer.w + ov, y1: outer.y + outer.h + ov };
      const i = { x0: m.inner.x, y0: m.inner.y, x1: m.inner.x + m.inner.w, y1: m.inner.y + m.inner.h };
      const yb = eave + m.brk;
      g.add(poly([[o.x0, eave, o.y0], [o.x1, eave, o.y0], [i.x1, yb, i.y0], [i.x0, yb, i.y0]], material));
      g.add(poly([[o.x1, eave, o.y0], [o.x1, eave, o.y1], [i.x1, yb, i.y1], [i.x1, yb, i.y0]], material));
      g.add(poly([[o.x1, eave, o.y1], [o.x0, eave, o.y1], [i.x0, yb, i.y1], [i.x1, yb, i.y1]], material));
      g.add(poly([[o.x0, eave, o.y1], [o.x0, eave, o.y0], [i.x0, yb, i.y0], [i.x0, yb, i.y1]], material));
      g.add(...hipFaces(i, yb, Math.tan(((cfg.pitch ?? 20) * Math.PI) / 180), coverMat(covering(cfg, 'top'))));
      const cornice = mat('#ece6da');
      const cw = 0.35;
      g.add(box(o.x1 - o.x0 + cw, 0.28, cw, cornice, (o.x0 + o.x1) / 2, eave - 0.12, o.y0));
      g.add(box(o.x1 - o.x0 + cw, 0.28, cw, cornice, (o.x0 + o.x1) / 2, eave - 0.12, o.y1));
      g.add(box(cw, 0.28, o.y1 - o.y0, cornice, o.x0, eave - 0.12, (o.y0 + o.y1) / 2));
      g.add(box(cw, 0.28, o.y1 - o.y0, cornice, o.x1, eave - 0.12, (o.y0 + o.y1) / 2));
      g.traverse((x) => (x.userData.target = target));
      return g;
    }
    if (type === 'flat') {
      const t = 0.3;
      const cx = outer.x + outer.w / 2;
      const cz = outer.y + outer.h / 2;
      g.add(box(outer.w + 2 * ov * 0.3, t, outer.h + 2 * ov * 0.3, flatMat, cx, eave + t / 2, cz));
      const p = cfg.parapet ?? 0.3;
      if (p > 0) {
        const y = eave + t + p / 2;
        g.add(box(outer.w, p, ext / 2, parapetMat, cx, y, outer.y + ext / 4), box(outer.w, p, ext / 2, parapetMat, cx, y, outer.y + outer.h - ext / 4));
        g.add(box(ext / 2, p, outer.h, parapetMat, outer.x + ext / 4, y, cz), box(ext / 2, p, outer.h, parapetMat, outer.x + outer.w - ext / 4, y, cz));
      }
      g.traverse((o) => (o.userData.target = target));
      return g;
    }
    const t = Math.tan(((cfg.pitch ?? 35) * Math.PI) / 180);
    // local frame: u runs along the ridge (or along the high wall for mono-pitch), v across it
    const acrossX = type === 'shed' ? cfg.low === 'E' || cfg.low === 'W' : cfg.ridge === 'y';
    const [u0, u1] = acrossX ? [outer.y, outer.y + outer.h] : [outer.x, outer.x + outer.w];
    const [v0, v1] = acrossX ? [outer.x, outer.x + outer.w] : [outer.y, outer.y + outer.h];
    const P = (u, v, y) => (acrossX ? [v, y, u] : [u, y, v]);
    const U0 = u0 - ov;
    const U1 = u1 + ov;
    const V0 = v0 - ov;
    const V1 = v1 + ov;
    const low = eave - ov * t; // height at the overhang edge
    const vm = (v0 + v1) / 2;
    const ridgeY = eave + rise;

    if (type === 'gable') {
      g.add(poly([P(U0, V0, low), P(U1, V0, low), P(U1, vm, ridgeY), P(U0, vm, ridgeY)], material));
      g.add(poly([P(U0, V1, low), P(U0, vm, ridgeY), P(U1, vm, ridgeY), P(U1, V1, low)], material));
      // triangular gable walls (outer and inner face)
      for (const u of [u0, u0 + ext, u1 - ext, u1]) g.add(poly([P(u, v0, eave), P(u, v1, eave), P(u, vm, ridgeY)], wallMat));
    } else if (type === 'hip') {
      const half = (V1 - V0) / 2;
      const r0 = Math.min(U0 + half, (U0 + U1) / 2);
      const r1 = Math.max(U1 - half, (U0 + U1) / 2);
      const top = low + Math.min(half, (U1 - U0) / 2) * t;
      g.add(poly([P(U0, V0, low), P(U1, V0, low), P(r1, vm, top), P(r0, vm, top)], material));
      g.add(poly([P(U1, V1, low), P(U0, V1, low), P(r0, vm, top), P(r1, vm, top)], material));
      g.add(poly([P(U0, V1, low), P(U0, V0, low), P(r0, vm, top)], material));
      g.add(poly([P(U1, V0, low), P(U1, V1, low), P(r1, vm, top)], material));
    } else {
      // mono-pitch: high along v0 (or v1), sloping down to the `low` side
      const lowAtV1 = cfg.low === 'S' || cfg.low === 'E' || !cfg.low;
      const hv = lowAtV1 ? v0 : v1; // high wall face
      const lv = lowAtV1 ? v1 : v0;
      const HV = lowAtV1 ? V0 : V1;
      const LV = lowAtV1 ? V1 : V0;
      const highY = eave + rise + ov * t;
      g.add(poly([P(U0, HV, highY), P(U1, HV, highY), P(U1, LV, low), P(U0, LV, low)], material));
      // raised high wall and the two sloping side walls
      for (const v of [hv, lowAtV1 ? hv + ext : hv - ext]) g.add(poly([P(u0, v, eave), P(u1, v, eave), P(u1, v, eave + rise), P(u0, v, eave + rise)], wallMat));
      for (const u of [u0, u0 + ext, u1 - ext, u1]) g.add(poly([P(u, hv, eave), P(u, lv, eave), P(u, hv, eave + rise)], wallMat));
    }
    g.traverse((o) => (o.userData.target = target));
    return g;
  }

  // ---------- facade details ----------
  function addFacade(g, house, floor, floors, e0, H, W, edges, openings, ext) {
    const f = facadeSettings(house);
    const trim = mat(f.trim);
    const lowest = floor === floors[0];
    const top = floors[floors.length - 1] === floor || floors[floors.indexOf(floor) + 1]?.underRoof;
    const OUT = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
    // a band along every exterior wall, `depth` out from the wall face, between heights y0 and y1
    const band = (y0, y1, depth, material) => {
      for (const e of edges) {
        const o = OUT[e.side];
        const off = ext / 2 + depth / 2;
        const len = e.length + ext + 2 * depth;
        const b = e.horizontal
          ? box(len, y1 - y0, depth, material, (e.x1 + e.x2) / 2, (y0 + y1) / 2, e.y1 + o[1] * off)
          : box(depth, y1 - y0, len, material, e.x1 + o[0] * off, (y0 + y1) / 2, (e.y1 + e.y2) / 2);
        b.castShadow = false;
        g.add(b);
      }
    };
    if (lowest && f.plinth) band(0, e0 + 0.3, 0.05, mat(f.plinthColor));
    // rustication (bosáž): horizontal grooves in the ground-floor render, stopping at openings
    if (lowest && f.rustication) {
      const groove = mat(darken(f.render, 0.72));
      const from = e0 + (f.plinth ? 0.3 : 0.05);
      const to = e0 + W - (top && f.cornice ? 0.4 : 0.15);
      for (const e of edges) {
        const o = OUT[e.side];
        const mine = openings.filter(({ p }) => p.edge === e);
        const [a0, a1] = e.horizontal ? [Math.min(e.x1, e.x2), Math.max(e.x1, e.x2)] : [Math.min(e.y1, e.y2), Math.max(e.y1, e.y2)];
        for (let y = from + 0.4; y < to; y += 0.4) {
          const gaps = mine
            .filter(({ o: op }) => y > e0 + (op.sill ?? 0) - 0.12 && y < e0 + (op.sill ?? 0) + (op.height ?? 1.4) + (op.surround ? 0.32 : 0.1))
            .map(({ o: op, p }) => [p.from - (op.surround ? 0.2 : 0.06), p.to + (op.surround ? 0.2 : 0.06)]);
          for (const [b0, b1] of solidPieces(a0 - ext / 2, a1 + ext / 2, gaps)) {
            if (b1 - b0 < 0.05) continue;
            const off = ext / 2 + 0.004;
            const m = e.horizontal
              ? box(b1 - b0, 0.03, 0.008, groove, (b0 + b1) / 2, y, e.y1 + o[1] * off)
              : box(0.008, 0.03, b1 - b0, groove, e.x1 + o[0] * off, y, (b0 + b1) / 2);
            m.castShadow = false;
            g.add(m);
          }
        }
      }
    }
    if (!lowest && f.bands) band(e0 - 0.12, e0 + 0.06, 0.06, trim);
    if (top && f.cornice && W >= H - 0.01) {
      band(e0 + H - 0.32, e0 + H - 0.14, 0.12, trim);
      band(e0 + H - 0.14, e0 + H, 0.22, trim);
    }
    // corner stones on every outside corner, alternating long and short
    if (f.quoins) {
      const pts = new Map();
      for (const e of edges)
        for (const [x, y] of [[e.x1, e.y1], [e.x2, e.y2]]) {
          const k = `${x},${y}`;
          if (!pts.has(k)) pts.set(k, { x, y, edges: [] });
          pts.get(k).edges.push(e);
        }
      for (const p of pts.values()) {
        const h = p.edges.find((e) => e.horizontal);
        const v = p.edges.find((e) => !e.horizontal);
        if (!h || !v) continue;
        const o = [OUT[v.side][0], OUT[h.side][1]];
        // convex corner: just inside is a room, just outside is not
        if (!roomAt(floor, p.x - o[0] * 0.1, p.y - o[1] * 0.1) || roomAt(floor, p.x + o[0] * 0.1, p.y + o[1] * 0.1)) continue;
        const cx = p.x + (o[0] * ext) / 2;
        const cy = p.y + (o[1] * ext) / 2;
        const rowH = 0.3;
        for (let y = e0 + 0.02, i = 0; y + rowH - 0.04 <= e0 + W; y += rowH, i++) {
          const longX = i % 2 === 0;
          const lx = longX ? 0.6 : 0.36;
          const ly = longX ? 0.36 : 0.6;
          // block on the north/south face (runs along x) and on the east/west face (runs along y)
          g.add(box(lx, rowH - 0.04, 0.04, trim, cx - o[0] * (lx / 2), y + (rowH - 0.04) / 2, cy + o[1] * 0.02));
          g.add(box(0.04, rowH - 0.04, ly, trim, cx + o[0] * 0.02, y + (rowH - 0.04) / 2, cy - o[1] * (ly / 2)));
        }
      }
    }
    // per opening: stone surround, shutters, Juliet balcony
    for (const { o, p } of openings) {
      if (p.curved) continue; // shutters and surrounds only on straight walls
      const out = OUT[o.facade];
      const coord = p.horizontal ? p.y1 : p.x1;
      const face = coord + (out[0] + out[1]) * (ext / 2);
      const sill = o.sill ?? 0;
      const head = Math.min(sill + (o.height ?? 1.4), W);
      if (head <= sill) continue;
      const w = p.to - p.from;
      const at = (along, acrossOut, y0, y1, la, depth, material) => {
        const across = face + (out[0] + out[1]) * acrossOut;
        const b = p.horizontal ? box(la, y1 - y0, depth, material, along, (y0 + y1) / 2, across) : box(depth, y1 - y0, la, material, across, (y0 + y1) / 2, along);
        b.castShadow = false;
        g.add(b);
      };
      if (o.surround) {
        const sw = 0.16;
        at(p.from - sw / 2, 0.02, e0 + sill, e0 + head + 0.2, sw, 0.04, trim);
        at(p.to + sw / 2, 0.02, e0 + sill, e0 + head + 0.2, sw, 0.04, trim);
        at((p.from + p.to) / 2, 0.025, e0 + head, e0 + head + 0.2, w + 2 * sw, 0.05, trim);
        if (head + 0.28 <= W) at((p.from + p.to) / 2, 0.04, e0 + head - 0.05, e0 + head + 0.28, 0.24, 0.08, trim); // keystone
      }
      if (o.shutters) {
        const sm = mat(f.shutters);
        const gap = o.surround ? 0.18 : 0.04;
        const [wl, wr] = shutterWidths(floor, o, edges, placeOpening);
        for (const [a0, dir, sw] of [[p.from - gap, -1, wl], [p.to + gap, 1, wr]]) {
          if (!sw) continue;
          const mid = a0 + (dir * sw) / 2;
          at(mid, 0.03, e0 + sill + 0.02, e0 + head - 0.02, sw, 0.04, sm);
          // louvre rails
          for (let y = e0 + sill + 0.25; y < e0 + head - 0.1; y += 0.32) at(mid, 0.055, y, y + 0.03, sw - 0.06, 0.02, mat('#4f5d63'));
        }
      }
      if (o.balcony > 0) {
        // a small cantilevered balcony: slab with a stone edge, paving, iron railing on three sides
        const iron = mat('#26282a');
        const D = o.balcony;
        const Wb = o.balconyWidth || Math.max(w + 0.8, 1.6);
        const mid = (p.from + p.to) / 2;
        const y0 = e0;
        at(mid, D / 2, y0 - 0.2, y0, Wb, D, trim);
        at(mid, D / 2, y0, y0 + 0.03, Wb - 0.06, D - 0.03, mat('#cfc7b8'));
        at(mid, D - 0.03, y0 + 0.98, y0 + 1.02, Wb, 0.05, iron);
        at(mid, D - 0.03, y0 + 0.1, y0 + 0.13, Wb, 0.03, iron);
        for (let a = mid - Wb / 2 + 0.02; a <= mid + Wb / 2 - 0.01; a += 0.12) at(a, D - 0.03, y0, y0 + 1.0, 0.018, 0.018, iron);
        for (const a of [mid - Wb / 2 + 0.02, mid + Wb / 2 - 0.02]) {
          at(a, D / 2, y0 + 0.98, y0 + 1.02, 0.04, D, iron);
          at(a, D / 2, y0 + 0.1, y0 + 0.13, 0.03, D, iron);
          for (let c = 0.12; c < D - 0.05; c += 0.12) at(a, c, y0, y0 + 1.0, 0.018, 0.018, iron);
        }
      } else if (o.juliet) {
        const iron = mat('#26282a');
        const depth = 0.22;
        const y0 = e0 + sill;
        at((p.from + p.to) / 2, depth / 2, y0 - 0.08, y0, w + 0.24, depth, trim); // stone base
        at((p.from + p.to) / 2, depth - 0.02, y0 + 0.95, y0 + 0.99, w + 0.2, 0.04, iron); // top rail
        at((p.from + p.to) / 2, depth - 0.02, y0 + 0.1, y0 + 0.13, w + 0.2, 0.03, iron); // bottom rail
        for (let a = p.from - 0.1; a <= p.to + 0.1001; a += 0.11) at(a, depth - 0.02, y0, y0 + 0.97, 0.018, 0.018, iron);
        // returns back to the wall
        for (const a of [p.from - 0.1, p.to + 0.1]) {
          const across = face + (out[0] + out[1]) * (depth / 2);
          const b = p.horizontal ? box(0.03, 0.04, depth, iron, a, y0 + 0.97, across) : box(depth, 0.04, 0.03, iron, across, y0 + 0.97, a);
          g.add(b);
        }
      }
    }
  }

  // Four faces of a hipped top over a rectangle {x0,y0,x1,y1} starting at height `low`.
  function hipFaces(r, low, t, material) {
    const w = r.x1 - r.x0;
    const d = r.y1 - r.y0;
    const half = Math.min(w, d) / 2;
    const top = low + half * t;
    if (w >= d) {
      const ym = (r.y0 + r.y1) / 2;
      const a = r.x0 + half;
      const b = r.x1 - half;
      return [
        poly([[r.x0, low, r.y0], [r.x1, low, r.y0], [b, top, ym], [a, top, ym]], material),
        poly([[r.x1, low, r.y1], [r.x0, low, r.y1], [a, top, ym], [b, top, ym]], material),
        poly([[r.x0, low, r.y1], [r.x0, low, r.y0], [a, top, ym]], material),
        poly([[r.x1, low, r.y0], [r.x1, low, r.y1], [b, top, ym]], material),
      ];
    }
    const xm = (r.x0 + r.x1) / 2;
    const a = r.y0 + half;
    const b = r.y1 - half;
    return [
      poly([[r.x0, low, r.y0], [r.x0, low, r.y1], [xm, top, b], [xm, top, a]], material),
      poly([[r.x1, low, r.y1], [r.x1, low, r.y0], [xm, top, a], [xm, top, b]], material),
      poly([[r.x0, low, r.y0], [xm, top, a], [r.x1, low, r.y0]], material),
      poly([[r.x1, low, r.y1], [xm, top, b], [r.x0, low, r.y1]], material),
    ];
  }

  // Chimney stack from below the eaves to 1 m above the roof's top, with a cap.
  function chimney(c, g, target) {
    const top = g.eave + (g.type === 'flat' ? 0.5 : g.rise) + 1.0;
    const bottom = g.eave - 0.5;
    const grp = new THREE.Group();
    const stone = mat('#e3dccf');
    grp.add(box(c.w ?? 0.7, top - bottom, c.h ?? 0.9, stone, c.x + (c.w ?? 0.7) / 2, (top + bottom) / 2, c.y + (c.h ?? 0.9) / 2));
    grp.add(box((c.w ?? 0.7) + 0.16, 0.14, (c.h ?? 0.9) + 0.16, stone, c.x + (c.w ?? 0.7) / 2, top + 0.07, c.y + (c.h ?? 0.9) / 2));
    for (const dx of [0.2, 0.5]) grp.add(box(0.16, 0.35, 0.16, mat('#b8705a'), c.x + (c.w ?? 0.7) * dx + 0.08, top + 0.3, c.y + (c.h ?? 0.9) / 2));
    grp.traverse((o) => (o.userData.target = target));
    return grp;
  }

  // The roof that covers an attic floor, and the area its interior walls must stay in.
  function roofOver(house, floor) {
    const g = atticRoofOf(house, floor);
    if (!g) return { geom: null, clip: { x0: -Infinity, x1: Infinity, y0: -Infinity, y1: Infinity, top: floor.height ?? 2.8 } };
    if (g.type === 'mansard') {
      const r = g.mansard.inner;
      return { geom: g, clip: { x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h, top: g.mansard.brk } };
    }
    return { geom: g, clip: { x0: g.outer.x + 0.8, x1: g.outer.x + g.outer.w - 0.8, y0: g.outer.y + 0.8, y1: g.outer.y + g.outer.h - 0.8, top: Math.min(floor.height ?? 2.8, kneeWall(floor) + g.rise) } };
  }

  // A dormer around an attic window: cheeks, front wall, the window, and its own small roof
  // (o.dormer: 'gable' (triangle), 'arch' (round top) or 'flat').
  // The roof slopes around an attic floor, cut at height W above the floor: slate outside,
  // plaster inside and a cut face on top, with gaps for the dormers. Returns the inner outline
  // at the cut (interior walls stop there) and the dormer gaps per facade.
  function atticSection(g, geom, e0, W, openings) {
    const o = geom.outer;
    const ov = geom.overhang ?? 0;
    const T = 0.3; // roof build-up, measured horizontally
    const tan = Math.tan(((geom.cfg.pitch ?? 35) * Math.PI) / 180);
    let off; // horizontal distance from the eave line inwards at height h above the eave, per side
    if (geom.type === 'mansard') {
      const run = geom.mansard.inset + ov;
      const f = (h) => (Math.min(Math.max(h, 0), geom.mansard.brk) * run) / geom.mansard.brk;
      off = (h) => ({ n: f(h), s: f(h), w: f(h), e: f(h) });
    } else if (geom.type === 'hip') {
      const f = (h) => Math.max(0, h + ov * tan) / tan;
      off = (h) => ({ n: f(h), s: f(h), w: f(h), e: f(h) });
    } else if (geom.type === 'gable') {
      const f = (h) => Math.max(0, h + ov * tan) / tan;
      off = (h) => (geom.cfg.ridge === 'y' ? { n: ov, s: ov, w: f(h), e: f(h) } : { n: f(h), s: f(h), w: ov, e: ov });
    } else return null;
    const rect = (d, plus = 0) => ({ x0: o.x - ov + d.w + plus, x1: o.x + o.w + ov - d.e - plus, y0: o.y - ov + d.n + plus, y1: o.y + o.h + ov - d.s - plus });
    const ya = e0;
    const yc = e0 + W;
    const A = rect(off(ya - geom.eave));
    const B = rect(off(yc - geom.eave));
    const Ai = rect(off(ya - geom.eave), T);
    const Bi = rect(off(yc - geom.eave), T);
    const slate = coverMat(covering(geom.cfg));
    const plaster = mat('#ece8e1', { side: THREE.DoubleSide });
    const capMat = mat('#bdb3a2', { side: THREE.DoubleSide });
    const gaps = { N: [], S: [], W: [], E: [] };
    for (const { o: op, p } of openings) if (!isGableEnd(geom, op.facade)) gaps[op.facade]?.push([p.from - 0.16, p.to + 0.16]);
    // one side: pieces between the dormer gaps; a piece's corner end follows the rectangle corners
    const side = (facade) => {
      const horiz = facade === 'N' || facade === 'S';
      const [lo, hi] = horiz ? ['x0', 'x1'] : ['y0', 'y1'];
      const across = { N: 'y0', S: 'y1', W: 'x0', E: 'x1' }[facade];
      const P = (r, u, y) => (horiz ? [u, y, r[across]] : [r[across], y, u]);
      const cuts = gaps[facade].sort((a, b) => a[0] - b[0]);
      const pieces = [];
      let start = null;
      for (const [a, b] of cuts) {
        pieces.push([start, a]);
        start = b;
      }
      pieces.push([start, null]);
      for (const [u0, u1] of pieces) {
        const at = (r, u, end) => (u === null ? r[end] : Math.min(Math.max(u, r[lo]), r[hi]));
        const quad = (r0, r1, material) => {
          const a0 = at(r0, u0, lo), a1 = at(r0, u1, hi), b0 = at(r1, u0, lo), b1 = at(r1, u1, hi);
          if (a1 - a0 < 0.02 && b1 - b0 < 0.02) return;
          g.add(poly([P(r0, a0, ya), P(r0, a1, ya), P(r1, b1, yc), P(r1, b0, yc)], material));
        };
        quad(A, B, slate);
        quad(Ai, Bi, plaster);
        // the cut face on top
        const c0 = at(B, u0, lo), c1 = at(B, u1, hi), d0 = at(Bi, u0, lo), d1 = at(Bi, u1, hi);
        g.add(poly([P(B, c0, yc), P(B, c1, yc), P(Bi, d1, yc), P(Bi, d0, yc)], capMat));
        // close the ends at a dormer gap
        for (const [u, isCut] of [[u0, u0 !== null], [u1, u1 !== null]]) {
          if (!isCut) continue;
          g.add(poly([P(A, u, ya), P(B, u, yc), P(Bi, u, yc), P(Ai, u, ya)], plaster));
        }
      }
    };
    for (const f of ['N', 'S', 'W', 'E']) side(f);
    return { x0: Bi.x0, x1: Bi.x1, y0: Bi.y0, y1: Bi.y1, top: W, inner: Bi };
  }

  // A curved wall of a round room, as short straight pieces along the arc, with its windows
  // and doors (openings placed on the curve), a stone base and a cornice like the other walls.
  function curvedWall(g, house, floor, cw, e0, W, ext, int, openings, floors) {
    const { room: r, shape: sh } = cw;
    const mid = arcPoint(sh, (sh.t0 + sh.t1) / 2);
    const outside = [mid[0] + Math.sign(mid[0] - sh.cx) * 0.3, mid[1] + Math.sign(mid[1] - sh.cy) * 0.3];
    const exterior = !floor.rooms.some((o) => o !== r && inRoom(o, ...outside));
    const T = exterior ? ext : int;
    const F = facadeSettings(house);
    const wallMat = exterior ? mat(F.render) : M.wallInner();
    const mine = openings.filter(({ p }) => p.curved && p.edge.room === r.id);
    const lowest = floor === floors[0];
    const top = floors[floors.length - 1] === floor || floors[floors.indexOf(floor) + 1]?.underRoof;
    const piece = (sg, y0, y1, depth, offset, material) => {
      if (y1 - y0 < 0.01) return;
      // outward normal of the curve at this piece
      const nx = (sg.mid[0] - sh.cx) / sh.ax ** 2;
      const ny = (sg.mid[1] - sh.cy) / sh.by ** 2;
      const l = Math.hypot(nx, ny) || 1;
      const b = box(sg.len + 0.02, y1 - y0, depth, material, sg.mid[0] + (nx / l) * offset, (y0 + y1) / 2, sg.mid[1] + (ny / l) * offset);
      b.rotation.y = -sg.angle;
      g.add(b);
      return b;
    };
    for (const sg of arcSegments(sh, 0.15)) {
      const tm = (sg.t0 + sg.t1) / 2;
      const hit = mine.find(({ p }) => tm >= p.t0 && tm <= p.t1);
      if (!hit) piece(sg, e0, e0 + W, T, 0, wallMat);
      else {
        const { o } = hit;
        const sill = Math.min(o.sill ?? 0, W);
        const head = Math.min(W, sill + (o.height ?? 1.4));
        piece(sg, e0, e0 + sill, T, 0, wallMat);
        piece(sg, e0 + head, e0 + W, T, 0, wallMat);
        const pane = piece(sg, e0 + sill, e0 + head, o.type === 'door' ? 0.06 : 0.03, 0, o.type === 'door' ? M.door() : M.glass());
        if (pane && o.type !== 'door') pane.castShadow = false;
        // frame at the top and bottom of the opening
        piece(sg, e0 + head - 0.05, e0 + head, 0.08, 0, M.frame());
        if (sill > 0) piece(sg, e0 + sill, e0 + sill + 0.05, 0.08, 0, M.frame());
      }
      if (!exterior) continue;
      if (lowest && F.plinth) piece(sg, 0, e0 + 0.3, 0.05, T / 2 + 0.025, mat(F.plinthColor));
      if (top && F.cornice && W >= (floor.height ?? 2.8) - 0.01) {
        piece(sg, e0 + W - 0.32, e0 + W - 0.14, 0.12, T / 2 + 0.06, mat(F.trim));
        piece(sg, e0 + W - 0.14, e0 + W, 0.22, T / 2 + 0.11, mat(F.trim));
      }
    }
  }

  // A cone roof over a round room (a half cone over a rounded side, closed by a gable triangle).
  function coneRoof(c) {
    const g = new THREE.Group();
    const sh = c.shape;
    const material = coverMat(c.material);
    // three.js cone: x = r·sin θ, z = r·cos θ; the plan curve is (cos t, sin t) → θ = π/2 − t
    const [ts, tl] = c.half ? [Math.PI / 2 - sh.t1, sh.t1 - sh.t0] : [0, 2 * Math.PI];
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1, c.rise, 48, 1, true, ts, tl), material);
    cone.scale.set(sh.ax + c.overhang, 1, sh.by + c.overhang);
    cone.position.set(sh.cx, c.eave + c.rise / 2, sh.cy);
    cone.castShadow = true;
    cone.receiveShadow = true;
    g.add(cone);
    if (c.half) {
      const big = { ...sh, ax: sh.ax + c.overhang, by: sh.by + c.overhang };
      const a = arcPoint(big, sh.t0);
      const b = arcPoint(big, sh.t1);
      const apex = [sh.cx, c.eave + c.rise, sh.cy];
      const gableMat = mat(facadeSettings(store.house).render, { side: THREE.DoubleSide });
      if (c.straight) {
        // the straight part: two slopes from the cone's sides to a ridge, closed by a gable
        const shift = (p) => (c.straight.along === 'x' ? [c.straight.to, p[1]] : [p[0], c.straight.to]);
        const [a2, b2] = [shift(a), shift(b)];
        const top2 = c.straight.along === 'x' ? [c.straight.to, apex[1], sh.cy] : [sh.cx, apex[1], c.straight.to];
        g.add(poly([[a[0], c.eave, a[1]], [a2[0], c.eave, a2[1]], top2, apex], material));
        g.add(poly([[b[0], c.eave, b[1]], [b2[0], c.eave, b2[1]], top2, apex], material));
        g.add(poly([[a2[0], c.eave, a2[1]], [b2[0], c.eave, b2[1]], top2], gableMat));
      } else {
        // close the flat side of the half cone
        g.add(poly([[a[0], c.eave, a[1]], [b[0], c.eave, b[1]], apex], gableMat));
      }
    }
    // a small finial at the top
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.5, 8), mat('#8f969c', { metalness: 0.4, roughness: 0.5 }));
    tip.position.set(sh.cx, c.eave + c.rise + 0.25, sh.cy);
    g.add(tip);
    g.traverse((x) => (x.userData.target = `${c.floor.id}/${c.room.id}`));
    return g;
  }

  // A window in the gable end wall of an attic: an ordinary window just proud of the gable.
  function gableWindow(floor, o, p, e0, ext) {
    const out = { N: -1, S: 1, W: -1, E: 1 }[o.facade];
    const coord = (p.horizontal ? p.y1 : p.x1) + out * (ext / 2 + 0.02);
    const seg = p.horizontal ? { horizontal: true, y1: coord } : { horizontal: false, x1: coord };
    const sill = o.sill ?? (o.type === 'window' ? 0.9 : 0);
    const g = openingObject(seg, o, p, e0, sill, sill + (o.height ?? 1.4), 0.04);
    g.traverse((x) => (x.userData.target = `${floor.id}/${o.id}`));
    return g;
  }

  function dormer(floor, o, p, e0, ext, atticRoof, section = null) {
    if (isGableEnd(atticRoof?.geom, o.facade)) return gableWindow(floor, o, p, e0, ext);
    // A French lucarne: stone front with pilasters, a cornice and a sill ledge, slate cheeks,
    // a casement window with glazing bars, and a slate roof that runs back into the main roof.
    const grp = new THREE.Group();
    const F = facadeSettings(store.house);
    const stone = mat(F.trim);
    const front0 = M.wall();
    // dormer cheeks in the roof's own covering (slate on a slate mansard)
    const slate = atticRoof?.geom ? coverMat(covering(atticRoof.geom.cfg)) : M.roof();
    const zinc = mat('#8f969c', { metalness: 0.4, roughness: 0.5 });
    const out = { N: -1, S: 1, W: -1, E: 1 }[o.facade]; // outward across the wall
    const coord = p.horizontal ? p.y1 : p.x1;
    const front = coord + out * (ext / 2);
    const isDoor = o.type !== 'window';
    const sill = o.sill ?? (isDoor ? 0 : 0.9);
    const head = sill + (o.height ?? 1.4);
    const style = o.dormer || 'gable';
    const pil = 0.16; // pilaster width
    const a0 = p.from - pil;
    const a1 = p.to + pil;
    const width = a1 - a0;
    const mid = (a0 + a1) / 2;
    const yb = e0; // the lucarne rises from the cornice
    const yt = style === 'arch' ? e0 + head : e0 + head + 0.28;
    const at = (along, across) => (p.horizontal ? [along, across] : [across, along]);
    const pt = (al, ac, y) => { const [x, z] = at(al, ac); return [x, y, z]; };
    const addBox = (al0, al1, ac0, ac1, y0, y1, material) => {
      const [x0, z0] = at(al0, ac0);
      const [x1, z1] = at(al1, ac1);
      const m = box(Math.abs(x1 - x0), y1 - y0, Math.abs(z1 - z0), material, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      grp.add(m);
      return m;
    };
    const across = (d0, d1) => [front + out * d0, front + out * d1].sort((u, v) => u - v);
    const slab = (al0, al1, d0, d1, y0, y1, material) => addBox(al0, al1, ...across(d0, d1), y0, y1, material);

    if (section) {
      // cut-away at the section height: cheeks back to the cut roof, the front and the lower
      // part of the window, a cut face on top; no dormer roof
      const yc = e0 + section.top;
      const innerEdge = { N: section.inner.y0, S: section.inner.y1, W: section.inner.x0, E: section.inner.x1 }[o.facade];
      const back = Math.abs(front - innerEdge);
      const capMat = mat('#bdb3a2');
      for (const [c0, c1] of [[a0 + 0.02, a0 + 0.1], [a1 - 0.1, a1 - 0.02]]) {
        slab(c0, c1, -0.08, -back, yb, yc, slate);
        slab(c0, c1, -0.08, -back, yc - 0.01, yc + 0.005, capMat);
      }
      const sillY = Math.min(e0 + sill, yc);
      if (sill > 0) slab(p.from, p.to, 0, -0.14, yb, sillY, front0);
      slab(a0, p.from, 0.04, -0.14, yb, yc, stone);
      slab(p.to, a1, 0.04, -0.14, yb, yc, stone);
      slab(a0, a1, 0.04, -0.14, yc - 0.01, yc + 0.005, capMat);
      if (sill > 0 && e0 + sill < yc) slab(p.from - 0.06, p.to + 0.06, 0.1, -0.02, e0 + sill - 0.07, e0 + sill, stone);
      const top = Math.min(e0 + head, yc);
      if (top > sillY + 0.05) {
        const frame = mat('#f4f2ec');
        const gp = -0.09;
        const glass = slab(p.from, p.to, gp - 0.01, gp + 0.01, sillY, top, M.glass());
        glass.castShadow = false;
        const bar = (al0, al1, y0, y1, t = 0.07) => slab(al0, al1, gp + t / 2, gp - t / 2, y0, y1, frame);
        bar(p.from, p.to, sillY, sillY + 0.065);
        bar(p.from, p.from + 0.065, sillY, top);
        bar(p.to - 0.065, p.to, sillY, top);
        bar((p.from + p.to) / 2 - 0.04, (p.from + p.to) / 2 + 0.04, sillY, top);
      }
      grp.traverse((x) => (x.userData.target = `${floor.id}/${o.id}`));
      return grp;
    }

    // how far back the dormer must reach for its roof to disappear into the main roof
    let rise = style === 'gable' ? width * 0.55 : style === 'arch' ? width / 2 + 0.1 : 0.2;
    let depth = 1.7;
    if (atticRoof?.geom) {
      const along = [];
      for (let d = 0.3; d < 6; d += 0.05) {
        const [x, z] = at(mid, front - out * d);
        along.push([d, roofHeightAt(atticRoof.geom, x, z) ?? -Infinity]);
      }
      // near a hip the main roof stays low: flatten the pediment so the ridge still dies into it
      const maxH = Math.max(...along.map(([, h]) => h));
      if (style === 'gable' && yt + rise > maxH - 0.05) rise = Math.max(0.25, maxH - 0.05 - yt);
      const hit = along.find(([, h]) => h >= yt + rise);
      depth = hit ? hit[0] + 0.2 : along.reduce((b, c) => (c[1] > b[1] ? c : b))[0];
    }

    // slate cheeks, set just behind the stone front
    slab(a0 + 0.02, a0 + 0.1, -0.08, -depth, yb, yt, slate);
    slab(a1 - 0.1, a1 - 0.02, -0.08, -depth, yb, yt, slate);
    // stone front: apron under the window, lintel above, pilasters either side
    if (sill > 0) slab(p.from, p.to, 0, -0.14, yb, e0 + sill, front0);
    if (yt > e0 + head) slab(p.from, p.to, 0, -0.14, e0 + head, yt, front0);
    slab(a0, p.from, 0.04, -0.14, yb, yt, stone);
    slab(p.to, a1, 0.04, -0.14, yb, yt, stone);
    // projecting sill ledge
    if (sill > 0) slab(p.from - 0.06, p.to + 0.06, 0.1, -0.02, e0 + sill - 0.07, e0 + sill, stone);

    // casement window: frame, two leaves and glazing bars (petits bois)
    const glassPlane = -0.09;
    const fw = 0.065;
    const frame = mat('#f4f2ec');
    const w0 = p.from;
    const w1 = p.to;
    const s0 = e0 + sill;
    const s1 = e0 + head;
    const glass = slab(w0, w1, glassPlane - 0.01, glassPlane + 0.01, s0, s1, M.glass());
    glass.castShadow = false;
    const bar = (al0, al1, y0, y1, t = 0.05) => slab(al0, al1, glassPlane + t / 2, glassPlane - t / 2, y0, y1, frame);
    bar(w0, w1, s0, s0 + fw, 0.07);
    bar(w0, w1, s1 - fw, s1, 0.07);
    bar(w0, w0 + fw, s0, s1, 0.07);
    bar(w1 - fw, w1, s0, s1, 0.07);
    const wm = (w0 + w1) / 2;
    bar(wm - 0.04, wm + 0.04, s0, s1, 0.07);
    const rows = isDoor ? 4 : 3;
    for (let i = 1; i < rows; i++) {
      const y = s0 + ((s1 - s0) * i) / rows;
      bar(w0 + fw, w1 - fw, y - 0.015, y + 0.015, 0.03);
    }
    if (isDoor) bar(w0 + fw, w1 - fw, s0, s0 + 0.35, 0.05); // solid bottom rail of a French door

    if (style === 'arch') {
      // round-headed lucarne: arched fanlight, moulded arch with a keystone, slate barrel roof
      const r = (w1 - w0) / 2;
      const R = width / 2;
      const turn = (m) => { if (!p.horizontal) m.rotation.y = Math.PI / 2; return m; };
      const half = (radius, material, z) => {
        const shape = new THREE.Shape();
        shape.absarc(0, 0, radius, 0, Math.PI, false);
        const m = new THREE.Mesh(new THREE.ShapeGeometry(shape, 24), material);
        const [x, zz] = at(mid, front - out * z);
        m.position.set(x, yt, zz);
        return turn(m);
      };
      grp.add(half(r, M.glass(), 0.09));
      // stone spandrel: a ring between the fanlight and the arch
      const ringShape = new THREE.Shape();
      ringShape.absarc(0, 0, R, 0, Math.PI, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, r, Math.PI, 0, true);
      ringShape.holes.push(hole);
      const ring = new THREE.Mesh(new THREE.ExtrudeGeometry(ringShape, { depth: 0.14, bevelEnabled: false, curveSegments: 24 }), stone);
      // extruded 0.14 m from the wall plane outwards to the front face
      const [rx, rz] = at(mid, Math.min(front, front - out * 0.14));
      ring.position.set(rx, yt, rz);
      if (!p.horizontal) ring.rotation.y = Math.PI / 2;
      ring.castShadow = true;
      grp.add(ring);
      // moulding along the arch and the fanlight frame
      const torus = (radius, tube, material, z) => {
        const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 32, Math.PI), material);
        const [x, zz] = at(mid, front + out * z);
        m.position.set(x, yt, zz);
        return turn(m);
      };
      grp.add(torus(R - 0.03, 0.045, stone, 0.03));
      grp.add(torus(r - 0.02, 0.03, frame, -0.09));
      // fanlight glazing bars
      for (const ang of [Math.PI / 3, Math.PI / 2, (2 * Math.PI) / 3]) {
        const len = r - 0.04;
        const m = box(0.03, len, 0.03, frame, 0, 0, 0);
        const ux = Math.cos(ang) * len / 2;
        const uy = Math.sin(ang) * len / 2;
        const [x, zz] = at(mid + ux, front - out * 0.09);
        m.position.set(x, yt + uy, zz);
        m.rotation.z = p.horizontal ? ang - Math.PI / 2 : 0;
        if (!p.horizontal) { m.rotation.x = -(ang - Math.PI / 2); }
        grp.add(m);
      }
      bar(w0, w1, s1 - 0.03, s1 + 0.03, 0.07); // transom at the springing line
      slab(mid - 0.09, mid + 0.09, 0.07, -0.05, yt + R - 0.12, yt + R + 0.08, stone); // keystone
      // barrel roof in slate, closed by the arch
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.07, R + 0.07, depth, 28, 1, true, p.horizontal ? Math.PI / 2 : 0, Math.PI), slate);
      const [bx, bz] = at(mid, front - out * (depth / 2 + 0.02));
      cyl.position.set(bx, yt, bz);
      if (p.horizontal) cyl.rotation.x = Math.PI / 2;
      else cyl.rotation.z = Math.PI / 2;
      cyl.castShadow = true;
      grp.add(cyl);
    } else if (style === 'flat') {
      // flat-topped lucarne: entablature, cornice and a zinc top
      slab(a0 - 0.06, a1 + 0.06, 0.1, -0.1, yt, yt + 0.12, stone);
      slab(a0 - 0.1, a1 + 0.1, 0.14, -depth, yt + 0.12, yt + 0.2, zinc);
    } else {
      // gabled lucarne: entablature, pediment with raking cornices, slate roof, zinc finial
      slab(a0 - 0.06, a1 + 0.06, 0.1, -0.1, yt - 0.04, yt + 0.1, stone); // cornice
      const y0 = yt + 0.1;
      const top = yt + rise;
      grp.add(poly([pt(a0, front - out * 0.02, y0), pt(a1, front - out * 0.02, y0), pt(mid, front - out * 0.02, top - 0.06)], mat(F.render, { side: THREE.DoubleSide })));
      // raking cornices: thin stone strips following the two roof edges
      const rake = (sx) => {
        const e = sx < 0 ? a0 - 0.08 : a1 + 0.08;
        for (const d of [0.12, -0.02]) {
          grp.add(poly([pt(e, front + out * d, y0 - 0.02), pt(mid, front + out * d, top + 0.04), pt(mid, front + out * d, top - 0.1), pt(e, front + out * d, y0 - 0.16)], stone));
        }
        grp.add(poly([pt(e, front + out * 0.12, y0 - 0.02), pt(mid, front + out * 0.12, top + 0.04), pt(mid, front - out * 0.02, top + 0.04), pt(e, front - out * 0.02, y0 - 0.02)], stone));
      };
      rake(-1);
      rake(1);
      // slate roof from just behind the cornice back into the main roof, with a zinc ridge
      const l0 = front - out * 0.0;
      const l1 = front - out * depth;
      grp.add(poly([pt(a0 - 0.12, l0, y0 - 0.06), pt(a0 - 0.12, l1, y0 - 0.06), pt(mid, l1, top + 0.03), pt(mid, l0, top + 0.03)], slate));
      grp.add(poly([pt(a1 + 0.12, l0, y0 - 0.06), pt(mid, l0, top + 0.03), pt(mid, l1, top + 0.03), pt(a1 + 0.12, l1, y0 - 0.06)], slate));
      slab(mid - 0.03, mid + 0.03, 0, -depth, top + 0.02, top + 0.07, zinc);
      // zinc finial (épi de faîtage) on the front of the ridge
      const [fx, fz] = at(mid, front - out * 0.02);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.025, 0.32, 10), zinc);
      stem.position.set(fx, top + 0.2, fz);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), zinc);
      ball.position.set(fx, top + 0.26, fz);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.14, 10), zinc);
      tip.position.set(fx, top + 0.42, fz);
      grp.add(stem, ball, tip);
    }
    grp.traverse((x) => (x.userData.target = `${floor.id}/${o.id}`));
    return grp;
  }

  function siteObject(s) {
    const g = new THREE.Group();
    const cx = s.x + s.w / 2;
    const cz = s.y + s.h / 2;
    const color = siteColor(s.type);
    switch (s.type) {
      case 'plot': {
        if (isShaped(s)) {
          // irregular plot: polygon lawn and a fence along every boundary segment
          const shape = new THREE.Shape(s.points.map(([x, y]) => new THREE.Vector2(x, -y)));
          const lawn = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat('#a9c98a'));
          lawn.rotation.x = -Math.PI / 2;
          lawn.receiveShadow = true;
          g.add(lawn);
          const fence = new THREE.MeshStandardMaterial({ color: '#6b5a45', transparent: true, opacity: 0.55 });
          s.points.forEach((a, i) => {
            const b = s.points[(i + 1) % s.points.length];
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const f = box(len, 1.2, 0.05, fence, (a[0] + b[0]) / 2, 0.6, (a[1] + b[1]) / 2);
            f.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
            g.add(f);
          });
          break;
        }
        const m = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat('#a9c98a'));
        m.rotation.x = -Math.PI / 2;
        m.position.set(cx, 0, cz);
        m.receiveShadow = true;
        g.add(m);
        // low fence along the boundary
        const fence = mat('#6b5a45');
        g.add(box(s.w, 1.2, 0.05, fence, cx, 0.6, s.y), box(s.w, 1.2, 0.05, fence, cx, 0.6, s.y + s.h));
        g.add(box(0.05, 1.2, s.h, fence, s.x, 0.6, cz), box(0.05, 1.2, s.h, fence, s.x + s.w, 0.6, cz));
        g.children.slice(1).forEach((f) => (f.material = new THREE.MeshStandardMaterial({ color: '#6b5a45', transparent: true, opacity: 0.55 })));
        break;
      }
      case 'garage': {
        const H = s.height ?? 3;
        const t = 0.25;
        const walls = M.wall();
        g.add(box(s.w, H, t, walls, cx, H / 2, s.y + t / 2));
        g.add(box(s.w, H, t, walls, cx, H / 2, s.y + s.h - t / 2));
        g.add(box(t, H, s.h, walls, s.x + t / 2, H / 2, cz));
        g.add(box(t, H, s.h, walls, s.x + s.w - t / 2, H / 2, cz));
        g.add(roof(siteRoof(s), { target: `site/${s.id}` }));
        g.add(box(s.w - 0.1, 0.05, s.h - 0.1, mat('#c9c6c0'), cx, 0.025, cz));
        // sectional door
        const side = s.door || 'N';
        const dw = Math.min(s.w - 1, 5);
        const door = mat('#6f7378');
        if (side === 'N' || side === 'S') g.add(box(dw, 2.3, t + 0.04, door, cx, 1.15, side === 'N' ? s.y + t / 2 : s.y + s.h - t / 2));
        else g.add(box(t + 0.04, 2.3, Math.min(s.h - 1, 5), door, side === 'W' ? s.x + t / 2 : s.x + s.w - t / 2, 1.15, cz));
        break;
      }
      case 'terrace':
        g.add(box(s.w, 0.15, s.h, mat('#c59b6d'), cx, 0.075, cz));
        break;
      case 'pool': {
        g.add(box(s.w + 0.6, 0.06, s.h + 0.6, mat('#ece9e2'), cx, 0.03, cz));
        const water = box(s.w, 0.08, s.h, mat('#3fa7d6', { roughness: 0.15, metalness: 0.1 }), cx, 0.05, cz);
        water.receiveShadow = true;
        g.add(water);
        break;
      }
      case 'greenhouse': {
        const H = s.height ?? 2.5;
        const glass = box(s.w, H, s.h, mat('#cfeedd', { transparent: true, opacity: 0.35, roughness: 0.1, depthWrite: false }), cx, H / 2, cz);
        glass.castShadow = false;
        g.add(glass);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(s.w, H, s.h)), new THREE.LineBasicMaterial({ color: '#4f8a5b' }));
        edges.position.set(cx, H / 2, cz);
        g.add(edges);
        g.add(box(s.w - 0.4, 0.4, s.h * 0.35, mat('#6b8f4e'), cx, 0.2, s.y + s.h * 0.25));
        // a pitched glass roof if one is chosen (flat is the top of the glass box)
        if (s.roof && s.roof.type !== 'flat') {
          const glassRoof = mat('#cfeedd', { transparent: true, opacity: 0.4, roughness: 0.1, depthWrite: false, side: THREE.DoubleSide });
          g.add(roof(siteRoof(s), { target: `site/${s.id}`, material: glassRoof, wallMat: glassRoof }));
        }
        break;
      }
      case 'shed': {
        const H = s.height ?? 2.5;
        g.add(box(s.w, H, s.h, mat(color), cx, H / 2, cz));
        g.add(roof(siteRoof(s), { target: `site/${s.id}`, wallMat: mat(color, { side: THREE.DoubleSide }) }));
        break;
      }
      case 'garden': {
        // raised bed: timber frame, soil and a few plants
        const wood = mat('#8a6a48');
        const t = 0.06;
        const H = 0.3;
        g.add(box(s.w, H, t, wood, cx, H / 2, s.y + t / 2), box(s.w, H, t, wood, cx, H / 2, s.y + s.h - t / 2));
        g.add(box(t, H, s.h, wood, s.x + t / 2, H / 2, cz), box(t, H, s.h, wood, s.x + s.w - t / 2, H / 2, cz));
        g.add(box(s.w - 2 * t, H - 0.04, s.h - 2 * t, mat('#5b4532'), cx, (H - 0.04) / 2, cz));
        const leaf = mat('#5f9447');
        for (let i = 0; i < Math.min(40, Math.floor((s.w * s.h) / 0.5)); i++) {
          const px = s.x + 0.25 + ((i * 0.618) % 1) * (s.w - 0.5);
          const pz = s.y + 0.25 + ((i * 0.381 + 0.17) % 1) * (s.h - 0.5);
          g.add(box(0.22, 0.25, 0.22, leaf, px, H + 0.1, pz));
        }
        break;
      }
      case 'slope': {
        // ground rising towards `up` (N/S/E/W) to `height`: a grassy wedge
        const H = s.height ?? 1;
        const up = s.up || 'S';
        const along = up === 'N' || up === 'S';
        const L = along ? s.h : s.w; // rising over this length
        const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(L, 0), new THREE.Vector2(L, H)]);
        const geo = new THREE.ExtrudeGeometry(shape, { depth: along ? s.w : s.h, bevelEnabled: false });
        const wedge = new THREE.Mesh(geo, mat('#9fbf7c'));
        // the profile is drawn in the x/y plane rising towards +x, then turned to face `up`
        const [px, pz, turn] = { E: [s.x, s.y, 0], W: [s.x + s.w, s.y + s.h, Math.PI], S: [s.x + s.w, s.y, -Math.PI / 2], N: [s.x, s.y + s.h, Math.PI / 2] }[up];
        wedge.position.set(px, 0, pz);
        wedge.rotation.y = turn;
        wedge.castShadow = wedge.receiveShadow = true;
        g.add(wedge);
        break;
      }
      case 'driveway':
      case 'path': {
        const material = mat(s.type === 'driveway' ? '#9d9a94' : '#c8c2b6');
        if (!isShaped(s)) {
          g.add(box(s.w, 0.03, s.h, material, cx, 0.015, cz));
          break;
        }
        // curved road: a strip of the given width along the smoothed centre line
        const { left, right } = ribbon(smooth(s.points), s.width ?? 3);
        const pos = [];
        const y = s.type === 'driveway' ? 0.03 : 0.035;
        for (let i = 0; i < left.length - 1; i++) {
          const [l0, l1, r0, r1] = [left[i], left[i + 1], right[i], right[i + 1]];
          pos.push(l0[0], y, l0[1], r0[0], y, r0[1], l1[0], y, l1[1], l1[0], y, l1[1], r0[0], y, r0[1], r1[0], y, r1[1]);
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geom.computeVertexNormals();
        const road = new THREE.Mesh(geom, mat(s.type === 'driveway' ? '#9d9a94' : '#c8c2b6', { side: THREE.DoubleSide }));
        road.receiveShadow = true;
        g.add(road);
        break;
      }
      case 'tree':
      case 'conifer':
      case 'bush': {
        const r = Math.min(s.w, s.h) / 2;
        const H = s.height ?? { tree: 7, conifer: 8, bush: 1.4 }[s.type];
        const leaf = mat(siteColor(s.type));
        if (s.type === 'bush') {
          const b = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), leaf);
          b.scale.set(r, H / 2, r);
          b.position.set(cx, H / 2, cz);
          b.castShadow = true;
          g.add(b);
          break;
        }
        const trunkH = s.type === 'tree' ? H * 0.4 : H * 0.15;
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, trunkH, 8), mat('#6b4f35'));
        trunk.position.set(cx, trunkH / 2, cz);
        trunk.castShadow = true;
        g.add(trunk);
        const crown =
          s.type === 'tree'
            ? new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), leaf)
            : new THREE.Mesh(new THREE.ConeGeometry(1, 1, 14), leaf);
        if (s.type === 'tree') {
          crown.scale.set(r, (H - trunkH) / 2, r);
          crown.position.set(cx, trunkH + (H - trunkH) / 2, cz);
        } else {
          crown.scale.set(r, H - trunkH, r);
          crown.position.set(cx, trunkH + (H - trunkH) / 2, cz);
        }
        crown.castShadow = true;
        g.add(crown);
        break;
      }
      case 'hedge': {
        const H = s.height ?? 1.6;
        g.add(box(s.w, H, s.h, mat(siteColor(s.type)), cx, H / 2, cz));
        break;
      }
      case 'carport':
      case 'pergola': {
        const H = s.height ?? (s.type === 'carport' ? 2.4 : 2.5);
        if (isTerraceOnPosts(s)) {
          // a roof terrace on pillars: pillars (concrete, columns or an arcade), a solid slab,
          // paving and a railing (metal or a stone balustrade)
          const F = facadeSettings(store.house);
          const stone = mat(F.trim);
          const concrete = mat('#d9d5cc');
          const style = s.postStyle || 'square';
          const P = POST_SIZE(s);
          const T = 0.3;
          const posts = sitePosts(s);
          for (const [x, z] of posts) {
            if (style === 'column') {
              const shaft = new THREE.Mesh(new THREE.CylinderGeometry(P * 0.42, P * 0.48, H - 0.36, 20), stone);
              shaft.position.set(x, H / 2, z);
              shaft.castShadow = true;
              g.add(shaft, box(P + 0.06, 0.18, P + 0.06, stone, x, 0.09, z), box(P + 0.1, 0.18, P + 0.1, stone, x, H - 0.09, z));
            } else if (style === 'arcade') {
              g.add(box(P, H, P, mat(F.render), x, H / 2, z));
              g.add(box(P + 0.08, 0.25, P + 0.08, stone, x, 0.125, z)); // plinth
            } else g.add(box(P, H, P, concrete, x, H / 2, z));
          }
          if (style === 'arcade') {
            // round (or flattened) arches between neighbouring piers along every open side
            for (const [x1, z1, x2, z2] of terraceRailEdges(s)) {
              const horiz = z1 === z2;
              const line = horiz ? z1 : x1;
              const on = posts.filter(([x, z]) => Math.abs((horiz ? z : x) - line) < 0.5).map(([x, z]) => (horiz ? x : z)).sort((a, b) => a - b);
              for (let i = 0; i + 1 < on.length; i++) {
                const a = on[i] + P / 2;
                const L = on[i + 1] - P / 2 - a;
                if (L < 0.4) continue;
                const top = H - 0.02;
                const rise = Math.min(L / 2, top - 1.9);
                const spring = top - 0.22 - rise;
                const shape = new THREE.Shape();
                shape.moveTo(0, spring);
                shape.lineTo(0, top);
                shape.lineTo(L, top);
                shape.lineTo(L, spring);
                shape.absellipse(L / 2, spring, L / 2, rise, 0, Math.PI, false);
                const geo = new THREE.ExtrudeGeometry(shape, { depth: P * 0.8, bevelEnabled: false });
                const m = new THREE.Mesh(geo, mat(F.render, { side: THREE.DoubleSide }));
                // the profile is drawn in its own x/y plane: lay it along the side
                if (horiz) m.position.set(a, 0, line - (P * 0.8) / 2);
                else { m.rotation.y = -Math.PI / 2; m.position.set(line - (P * 0.8) / 2, 0, a); }
                m.castShadow = true;
                g.add(m);
                // impost mouldings where the arch springs, and a keystone
                const im = (pos) => (horiz ? box(0.12, 0.1, P + 0.06, stone, pos, spring, line) : box(P + 0.06, 0.1, 0.12, stone, line, spring, pos));
                g.add(im(a), im(a + L));
                g.add(horiz ? box(0.22, 0.28, P * 0.85, stone, a + L / 2, spring + rise + 0.06, line) : box(P * 0.85, 0.28, 0.22, stone, line, spring + rise + 0.06, a + L / 2));
              }
            }
          }
          g.add(box(s.w, T, s.h, style === 'square' ? concrete : mat(F.render), cx, H + T / 2, cz));
          g.add(box(s.w - 0.04, 0.03, s.h - 0.04, mat('#cfc7b8'), cx, H + T + 0.015, cz));
          // the slab edge: a dark fascia, or a stone cornice for the classical styles
          if (style === 'square') g.add(box(s.w + 0.02, 0.12, s.h + 0.02, mat('#8f8a82'), cx, H + T - 0.06, cz));
          else g.add(box(s.w + 0.16, 0.14, s.h + 0.16, stone, cx, H + T - 0.07, cz), box(s.w + 0.06, 0.08, s.h + 0.06, stone, cx, H + 0.04, cz));
          const y0 = H + T;
          if (s.railing === 'balustrade') {
            // stone balustrade: plinth, turned balusters, top rail, pedestals every 2.5 m
            for (const [x1, z1, x2, z2] of terraceRailEdges(s)) {
              const len = Math.hypot(x2 - x1, z2 - z1);
              const horiz = z1 === z2;
              const mx = (x1 + x2) / 2;
              const mz = (z1 + z2) / 2;
              const along = (l, y, h, d) => (horiz ? box(len + 0.04, h, d, stone, mx, y, mz) : box(d, h, len + 0.04, stone, mx, y, mz));
              g.add(along(len, y0 + 0.08, 0.16, 0.26), along(len, y0 + 0.88, 0.14, 0.28));
              const n = Math.max(2, Math.round(len / 0.22));
              const bal = new THREE.CylinderGeometry(0.045, 0.07, 0.64, 10);
              for (let i = 1; i < n; i++) {
                const t = i / n;
                const b = new THREE.Mesh(bal, stone);
                b.position.set(x1 + (x2 - x1) * t, y0 + 0.48, z1 + (z2 - z1) * t);
                g.add(b);
              }
              const k = Math.max(1, Math.round(len / 2.5));
              for (let i = 0; i <= k; i++) {
                const t = i / k;
                g.add(box(0.3, 0.95, 0.3, stone, x1 + (x2 - x1) * t, y0 + 0.475, z1 + (z2 - z1) * t));
              }
            }
          } else {
          const rail = mat('#2f3133');
          for (const [x1, z1, x2, z2] of terraceRailEdges(s)) {
            const len = Math.hypot(x2 - x1, z2 - z1);
            const horiz = z1 === z2;
            const mx = (x1 + x2) / 2;
            const mz = (z1 + z2) / 2;
            g.add(horiz ? box(len, 0.05, 0.06, rail, mx, y0 + 1.0, mz) : box(0.06, 0.05, len, rail, mx, y0 + 1.0, mz));
            g.add(horiz ? box(len, 0.03, 0.04, rail, mx, y0 + 0.12, mz) : box(0.04, 0.03, len, rail, mx, y0 + 0.12, mz));
            const n = Math.max(2, Math.round(len / 0.13));
            for (let i = 0; i <= n; i++) {
              const t = i / n;
              g.add(box(0.025, 1.0, 0.025, rail, x1 + (x2 - x1) * t, y0 + 0.5, z1 + (z2 - z1) * t));
            }
          }
          }
          break;
        }
        // posts at the corners (and mid-way on long sides), beams, then the roof
        const post = 0.15;
        const wood = mat(s.type === 'carport' ? '#6f6a63' : '#8a6a48');
        const xs = [s.x + post / 2, ...(s.w > 5 ? [cx] : []), s.x + s.w - post / 2];
        const zs = [s.y + post / 2, ...(s.h > 5 ? [cz] : []), s.y + s.h - post / 2];
        for (const x of xs) for (const z of zs) if (x === xs[0] || x === xs[xs.length - 1] || z === zs[0] || z === zs[zs.length - 1]) g.add(box(post, H, post, wood, x, H / 2, z));
        g.add(box(s.w, 0.2, 0.12, wood, cx, H - 0.1, s.y + 0.06), box(s.w, 0.2, 0.12, wood, cx, H - 0.1, s.y + s.h - 0.06));
        g.add(box(0.12, 0.2, s.h, wood, s.x + 0.06, H - 0.1, cz), box(0.12, 0.2, s.h, wood, s.x + s.w - 0.06, H - 0.1, cz));
        if (s.type === 'pergola' && (!s.roof || s.roof.type === 'flat')) {
          for (let x = s.x + 0.4; x < s.x + s.w - 0.2; x += 0.4) g.add(box(0.06, 0.16, s.h, wood, x, H + 0.08, cz));
        } else {
          const cover = s.type === 'pergola' ? mat('#dfe9ee', { transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }) : M.roof();
          g.add(roof(siteRoof(s), { target: `site/${s.id}`, material: cover, wallMat: s.type === 'pergola' ? cover : mat('#d6d2ca', { side: THREE.DoubleSide }), flatMat: cover }));
        }
        break;
      }
      default: {
        const H = s.height ?? 0.1;
        g.add(box(s.w, H, s.h, mat(color), cx, H / 2, cz));
      }
    }
    g.traverse((o) => (o.userData.target = `site/${s.id}`));
    if (s.base) g.position.y = s.base; // raised, e.g. standing on top of another element
    if (s.type !== 'plot') {
      const count = store.openComments(`site/${s.id}`);
      if (count) {
        const el = document.createElement('div');
        el.className = 'label3d';
        el.innerHTML = `${escapeHtml(s.name)}<span class="c">● ${count}</span>`;
        const label = new CSS2DObject(el);
        label.position.set(cx, (s.height ?? 0.5) + 0.6, cz);
        g.add(label);
      }
    }
    return g;
  }

  // ---------- selection ----------

  function updateSelection() {
    if (selectionHelper) {
      scene.remove(selectionHelper);
      selectionHelper = null;
    }
    if (!model || store.selected === 'house') return;
    const box3 = new THREE.Box3();
    model.traverse((o) => {
      if (o.isMesh && o.userData.target === store.selected && !o.userData.pickOnly) box3.expandByObject(o);
    });
    if (box3.isEmpty()) {
      model.traverse((o) => {
        if (o.isMesh && o.userData.target === store.selected) box3.expandByObject(o);
      });
    }
    if (box3.isEmpty()) return;
    box3.max.y = Math.max(box3.max.y, box3.min.y + 0.3);
    selectionHelper = new THREE.Box3Helper(box3, new THREE.Color('#f59e0b'));
    scene.add(selectionHelper);
  }

  const raycaster = new THREE.Raycaster();
  let downAt = null;
  const ndcOf = (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  };
  function pick(e) {
    raycaster.setFromCamera(ndcOf(e), camera);
    const hits = raycaster.intersectObject(model, true).filter((h) => h.object.userData.target);
    // prefer real geometry over invisible pick volumes, but take a room pick volume if nothing else is in front
    return hits.find((h) => !h.object.userData.pickOnly && h.object.userData.target !== 'site/plot') || hits.find((h) => h.object.userData.pickOnly) || hits[0];
  }

  // Dragging furniture across its floor. Registered in the capture phase so that the orbit
  // controls can be switched off before they react to the same pointerdown.
  let dragItem = null;
  const floorPoint = (e, plane) => {
    raycaster.setFromCamera(ndcOf(e), camera);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  };
  renderer.domElement.addEventListener(
    'pointerdown',
    (e) => {
      downAt = { x: e.clientX, y: e.clientY };
      if (e.button !== 0) return;
      const hit = pick(e);
      const t = hit && store.resolve(hit.object.userData.target);
      if (t?.kind !== 'item') return;
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(t.floor.elevation ?? 0));
      const at = floorPoint(e, plane);
      if (!at) return;
      dragItem = { t, plane, off: { x: at.x - t.item.x, z: at.z - t.item.y }, start: { x: e.clientX, y: e.clientY }, started: false };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
    },
    { capture: true },
  );
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!dragItem) return;
    if (!dragItem.started) {
      if (Math.hypot(e.clientX - dragItem.start.x, e.clientY - dragItem.start.y) < 4) return;
      dragItem.started = true;
      store.select(`${dragItem.t.floor.id}/${dragItem.t.item.id}`);
      store.beginBatch();
    }
    const at = floorPoint(e, dragItem.plane);
    if (!at) return;
    const snap = (v) => Math.round(v * 20) / 20;
    const x = snap(at.x - dragItem.off.x);
    const y = snap(at.z - dragItem.off.z);
    const it = dragItem.t.item;
    if (x !== it.x || y !== it.y) {
      Object.assign(it, { x, y });
      store.changed();
    }
  });
  const endDrag = (e) => {
    if (!dragItem) return false;
    const started = dragItem.started;
    if (started) store.endBatch();
    dragItem = null;
    controls.enabled = true;
    if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId);
    return started;
  };
  renderer.domElement.addEventListener('pointercancel', endDrag);
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (endDrag(e)) return;
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
    const hit = pick(e);
    store.select(hit ? hit.object.userData.target : 'house');
  });

  // ---------- loop ----------

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);

  renderer.setAnimationLoop(() => {
    if (container.classList.contains('hidden')) return;
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
  });

  // rebuild at most once per frame (dragging changes the house on every pointer move)
  let pending = false;
  const scheduleBuild = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      build();
    });
  };
  store.on((reason) => {
    if (reason === 'house' || reason === 'comments' || reason === 'saved') scheduleBuild();
    if (reason === 'selection') updateSelection();
  });

  build();
  resize();

  // Render a still image of the model from a fixed angle (for the printed sheets).
  // azimuth: 0 = from the south (garden), 90 = from the east, 180 = north (street); elevation in degrees.
  // focus: { x, y, z (plan metres, z = height), dist } looks at one spot from close by
  async function snapshot({ mode: m = 'whole', azimuth = 35, elevation = 28, width = 1600, height = 1000, site = false, focus = null } = {}) {
    const keep = { mode, pos: camera.position.clone(), target: controls.target.clone(), aspect: camera.aspect, w: renderer.domElement.width, h: renderer.domElement.height };
    mode = m;
    build();
    for (let t = 0; pendingImages > 0 && t < 40; t++) await new Promise((r) => setTimeout(r, 100));
    build();
    // frame the house (or the whole site)
    const rooms = store.house.floors.flatMap((f) => f.rooms);
    const b = site ? bbox([...rooms, ...store.house.site.filter((s) => s.type !== 'plot')]) : bbox(rooms);
    const top = Math.max(...store.house.floors.map((f) => (f.elevation ?? 0) + (f.height ?? 2.8))) + 3;
    const centre = focus ? new THREE.Vector3(focus.x, focus.z, focus.y) : new THREE.Vector3(b.x + b.w / 2, top / 3, b.y + b.h / 2);
    const radius = Math.hypot(b.w, b.h, top) / 2 + 1;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const dist = focus ? focus.dist : (radius / Math.sin(Math.min(fov, fov * (width / height)) / 2)) * 0.95;
    const az = THREE.MathUtils.degToRad(azimuth);
    const el = THREE.MathUtils.degToRad(elevation);
    camera.position.set(centre.x + dist * Math.sin(az) * Math.cos(el), centre.y + dist * Math.sin(el), centre.z + dist * Math.cos(az) * Math.cos(el));
    camera.lookAt(centre);
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (selectionHelper) selectionHelper.visible = false;
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/jpeg', 0.9);
    // restore the interactive view
    if (selectionHelper) selectionHelper.visible = true;
    mode = keep.mode;
    camera.position.copy(keep.pos);
    controls.target.copy(keep.target);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    resize();
    build();
    return url;
  }

  return {
    resize,
    snapshot,
    setMode(m) {
      mode = m;
      build();
    },
  };
}
