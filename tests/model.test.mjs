// Checks that run without a browser: every example house loads cleanly, and the geometry,
// stairs, roof, cost and export modules behave. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (name) => import(path.join(ROOT, 'public', name));
const g = await mod('geometry.js');
const { collectIssues } = await mod('issues.js');
const { estimate } = await mod('costs.js');
const { houseToDxf } = await mod('dxf.js');
const { syncRoofZones, roundRoofs } = await mod('roof.js');
const { fixDuplicateIds } = await mod('model.js');
const { analyzeStairs, stairSteps } = await mod('stairs.js');
const { buildBrief, briefMarkdown } = await mod('brief.js');

const examples = fs.readdirSync(path.join(ROOT, 'examples')).filter((d) => fs.existsSync(path.join(ROOT, 'examples', d, 'house.json')));
const load = (d) => JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', d, 'house.json'), 'utf8'));

for (const d of examples) {
  test(`example "${d}" is consistent`, () => {
    const h = load(d);
    assert.equal(fixDuplicateIds(h), 0, 'ids must be unique per floor');
    const t = g.totals(h);
    for (const f of t.floors) {
      assert.ok(f.overlap < 0.001, `${f.name}: rooms overlap`);
      assert.ok(f.gaps < 0.001, `${f.name}: gaps between rooms`);
    }
    if (h.floors.some((f) => f.rooms.length > 1)) assert.deepEqual(collectIssues(h).map((i) => i.text), []);
    assert.ok(estimate(h).total >= 0);
    assert.ok(houseToDxf(h).includes('EOF'));
    assert.ok(briefMarkdown(buildBrief(h, { comments: [], briefText: '' })).length > 100);
    syncRoofZones(h);
    assert.equal(syncRoofZones(h), false, 'fitting the roofs twice changes nothing');
  });
}

test('round rooms: exact area, no gaps, windows on the curve', () => {
  const floor = {
    rooms: [
      { id: 'living', x: 0, y: 0, w: 8, h: 5 },
      { id: 'bay', x: 2, y: 5, w: 4, h: 2, round: 'S' },
      { id: 'tower', x: 8, y: 0, w: 4, h: 5, round: 'E' },
    ],
  };
  assert.ok(Math.abs(g.area(floor.rooms[1]) - 2 * Math.PI) < 1e-9);
  const c = g.checkFloor(floor);
  assert.equal(c.overlap, 0);
  assert.equal(c.gaps, 0);
  // straight walls stop where the curves begin
  assert.ok(!g.exteriorEdges(floor).some((e) => e.side === 'E' && e.x1 > 11));
  const p = g.placeOpening(floor, { facade: 'S', x: 3.5, width: 1 });
  assert.ok(p?.curved, 'a window on the bay sits on its curve');
  assert.ok(g.placeOpening(floor, { facade: 'N', x: 10.5, width: 0.8 })?.curved, 'windows also fit on the flanks of a tower');
});

test('round rooms open to the sky get cone roofs', () => {
  const h = {
    roofs: [{ id: 'main', on: 'g', x: 0, y: 0, w: 8, h: 5, type: 'hip' }],
    floors: [{ id: 'g', elevation: 0, height: 3, rooms: [{ id: 'a', x: 0, y: 0, w: 8, h: 5 }, { id: 't', x: 8, y: 0, w: 4, h: 4, round: 'all' }] }],
  };
  const cones = roundRoofs(h);
  assert.equal(cones.length, 1);
  assert.equal(cones[0].half, false);
});

test('U-shaped stairs fit where a straight flight does not', () => {
  const stair = { id: 's', name: 'Stairs', type: 'stairs', x: 6, y: 3.65, w: 2.2, h: 2.25, up: 'N', shape: 'U', turn: 'left' };
  const house = {
    floors: [
      { id: 'g', name: 'G', elevation: 0.3, height: 2.85, rooms: [stair, { id: 'hall', name: 'Hall', type: 'hall', x: 4.5, y: 3.65, w: 1.5, h: 2.25 }], doors: [{ id: 'd', type: 'opening', between: ['hall', 's'], offset: 1.2, width: 0.9 }] },
      { id: 'u', name: 'U', elevation: 3.15, rooms: [{ id: 'v', name: 'Void', type: 'void', x: 6, y: 3.65, w: 2.2, h: 2.25 }, { id: 'land', name: 'Landing', type: 'hall', x: 4.5, y: 3.65, w: 1.5, h: 2.25 }], doors: [{ id: 'o', type: 'opening', between: ['land', 'v'], offset: 1.2, width: 0.9 }] },
    ],
  };
  const a = analyzeStairs(house, house.floors[0], stair);
  assert.deepEqual(a.issues, []);
  assert.equal(stairSteps(a).treads.length, a.risers - 1);
  const straight = analyzeStairs(house, house.floors[0], { ...stair, shape: undefined });
  assert.ok(straight.issues.some((i) => i.code === 'too-short'));
});
