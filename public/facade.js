import { curvedWalls } from './geometry.js';

// Facade appearance and classic details. house.facade = { render, trim, shutters, plinthColor,
// cornice, quoins, bands, plinth, rustication }; per exterior opening: { shutters, juliet, surround }.
export const FACADE_DEFAULTS = {
  render: '#f3f1ec', // wall colour
  trim: '#f7f4ec', // cornice, bands, corner stones, window surrounds
  shutters: '#7b8f96', // French blue-grey
  plinthColor: '#c9c2b4',
  cornice: false,
  quoins: false,
  bands: false,
  plinth: false,
  rustication: false, // horizontal grooves in the ground-floor render (bosáž)
};

export const facadeSettings = (house) => ({ ...FACADE_DEFAULTS, ...(house.facade || {}) });

// Quantities for costs and the brief.
export function facadeQuantities(house, { exteriorEdges, placeOpening, sortedFloors }) {
  const f = facadeSettings(house);
  const floors = sortedFloors(house);
  const q = { shutters: 0, juliet: 0, balconyM2: 0, balconies: 0, balconyPillars: { square: 0, column: 0, arcade: 0 }, surround: 0, cornice: 0, bands: 0, plinth: 0, quoinsM: 0, rusticationM2: 0 };
  floors.forEach((floor, i) => {
    if (floor.underRoof) return;
    const edges = exteriorEdges(floor);
    const per = edges.reduce((s, e) => s + e.length, 0) + curvedWalls(floor).filter((c) => c.exterior).reduce((s, c) => s + c.length, 0);
    const top = i === floors.length - 1 || floors[i + 1]?.underRoof;
    if (i === 0 && f.plinth) q.plinth += per;
    if (i === 0 && f.rustication) q.rusticationM2 += per * (floor.height ?? 2.8) * 0.8; // less the openings, roughly
    if (i > 0 && f.bands) q.bands += per;
    if (top && f.cornice) q.cornice += per;
    if (f.quoins) q.quoinsM += 4 * (floor.height ?? 2.8); // about four outside corners
    for (const o of floor.openings || []) {
      if (!placeOpening(floor, o, edges)) continue;
      if (o.shutters) q.shutters++;
      if (o.balcony > 0) {
        q.balconies++;
        if (o.balconyPillars in q.balconyPillars) q.balconyPillars[o.balconyPillars] += 2;
        const p = placeOpening(floor, o, edges);
        q.balconyM2 += o.balcony * (o.balconyWidth || Math.max((p ? p.to - p.from : o.width) + 0.8, 1.6));
      } else if (o.juliet) q.juliet++;
      if (o.surround) q.surround++;
    }
  });
  return q;
}

// Width of the left and right shutter of an opening: half the opening, but no more than the wall
// beside it allows (half the gap to the next opening, or up to the corner); 0 = no room.
export function shutterWidths(floor, o, edges, placeOpening) {
  const p = placeOpening(floor, o, edges);
  if (!p) return [0, 0];
  const gap = o.surround ? 0.18 : 0.04;
  const want = Math.max(0.3, (p.to - p.from) / 2);
  const same = (floor.openings || [])
    .filter((x) => x !== o && x.facade === o.facade)
    .map((x) => placeOpening(floor, x, edges))
    .filter((q) => q && q.edge === p.edge);
  const [e0, e1] = p.horizontal ? [p.edge.x1, p.edge.x2] : [p.edge.y1, p.edge.y2];
  // the shared boundary with a neighbour is halfway between the two openings
  const prev = Math.max(e0 + 0.35, ...same.filter((q) => q.to <= p.from + 1e-6).map((q) => (q.to + p.from) / 2));
  const next = Math.min(e1 - 0.35, ...same.filter((q) => q.from >= p.to - 1e-6).map((q) => (p.to + q.from) / 2));
  const fit = (space) => (space >= 0.25 ? Math.min(want, space) : 0);
  return [fit(p.from - gap - prev - 0.02), fit(next - p.to - gap - 0.02)];
}
