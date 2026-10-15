// Everything the planner thinks needs attention, with a target to jump to. No DOM.
import { totals, exteriorEdges, interiorEdges, placeOpening, placeDoor, inRoom } from './geometry.js';
import { allStairIssues, sortedFloors } from './stairs.js';
import { structureIssues } from './structure.js';
import { doorName, openingName } from './model.js';

const STEP = 0.05;
const cellsOf = (floor) => {
  const s = new Set();
  const idx = (v) => Math.round(v / STEP);
  for (const r of floor.rooms)
    for (let j = idx(r.y); j < idx(r.y + r.h); j++)
      for (let i = idx(r.x); i < idx(r.x + r.w); i++) if (inRoom(r, (i + 0.5) * STEP, (j + 0.5) * STEP)) s.add(j * 100000 + i);
  return s;
};

export function collectIssues(house) {
  const out = [];
  const t = totals(house);
  for (const f of t.floors) {
    const floor = house.floors.find((x) => x.id === f.id);
    if (f.overlap > 0.001) out.push({ kind: 'Layout', text: `${f.name}: rooms overlap by ${f.overlap.toFixed(1)} m².`, target: floor ? `${floor.id}/${floor.rooms[0]?.id}` : 'house' });
    if (f.gaps > 0.001) out.push({ kind: 'Layout', text: `${f.name}: ${f.gaps.toFixed(1)} m² of gaps between rooms.`, target: floor ? `${floor.id}/${floor.rooms[0]?.id}` : 'house' });
  }
  // doors and windows that no longer sit on a wall
  for (const floor of house.floors) {
    const edges = exteriorEdges(floor);
    const inner = interiorEdges(floor);
    for (const o of floor.openings || [])
      if (!placeOpening(floor, o, edges)) out.push({ kind: 'Layout', text: `${openingName(floor, o)} is not on an outside wall any more: move it, or delete it.`, target: `${floor.id}/${o.id}` });
    for (const d of floor.doors || [])
      if (!placeDoor(floor, d, inner)) out.push({ kind: 'Layout', text: `${doorName(floor, d)}: the two rooms no longer share a wall.`, target: `${floor.id}/${d.id}` });
  }
  // parts of a floor with nothing underneath
  const floors = sortedFloors(house);
  floors.forEach((floor, k) => {
    if (k === 0) return;
    const below = floors[k - 1];
    const under = cellsOf(below);
    for (const r of floor.rooms) {
      const mine = cellsOf({ rooms: [r] });
      let missing = 0;
      for (const c of mine) if (!under.has(c)) missing++;
      const m2 = missing * STEP * STEP;
      if (m2 > 0.5) out.push({ kind: 'Structure', text: `${r.name} (${floor.name.toLowerCase()}): ${m2.toFixed(1)} m² has no floor below it.`, target: `${floor.id}/${r.id}` });
    }
  });
  for (const i of allStairIssues(house)) out.push({ kind: 'Stairs', text: `${i.room.name} (${i.floor.name.toLowerCase()}): ${i.text}`, target: `${i.floor.id}/${i.room.id}` });
  for (const i of structureIssues(house)) out.push({ kind: 'Structure', text: `${i.floor.name}: ${i.text}`, target: i.target });
  return out;
}
