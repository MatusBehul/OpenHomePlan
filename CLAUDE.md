# OpenHomePlan — guide for Claude Code

An open-source (MIT), local web app for planning a family house. No framework, no build
step: `npm install && npm start`, then http://localhost:3000. The only dependency is Three.js.

## Layout

- `server.js` — Node HTTP server. Serves `public/`, manages the houses folder, writes files and
  commits them to git.
- `public/` — the browser app (ES modules, no bundler).
  - `app.js` state store (undo/redo), top bar, sidebar panels, house picker
  - `plan2d.js` SVG floor plan and all drag interactions
  - `view3d.js` Three.js model
  - `geometry.js` room rasterising, exterior/interior wall edges, doors/windows placement
  - `walls.js` per-wall properties (type, load-bearing, thickness, material)
  - `stairs.js` stair calculation, checks and auto-fix
  - `structure.js` slab-span and support checks for load-bearing walls
  - `roof.js` roof shapes and heights
  - `catalog.js` room/site types and colours
  - `items.js` furniture/appliance catalogue; `utilities.js` utility points, generator, circuits,
    load summary; `symbols.js` 2D symbols and finish patterns; `model.js` target resolution
  - `costs.js` cost estimate, `costsView.js` the Costs tab
  - `brief.js` handover brief (Markdown/HTML); `dxf.js` DXF export; `print.html`/`print.js`
    printable sheets at true scale (static mode of `plan2d.js`)
- `examples/<id>/` — templates for new houses (`family-house`, `blank`). Tracked in git.
- `houses/<slug>/` — the user's houses (git-ignored here). Each house folder is **its own git
  repository** containing `house.json`, `comments/open|resolved/*.md`, `assets/` (uploaded
  textures) and optionally `BRIEF.md` (the owner's requirements). The folder can be moved
  anywhere with `HOUSES_DIR` or `planner.config.json` (`housesDir`), e.g. into a synced
  cloud folder.

## Data model (`house.json`)

Coordinates are metres, origin at the north-west corner of the house, x → east, y → south.
Rooms are axis-aligned rectangles measured wall-axis to wall-axis and must tile each floor
without overlaps or gaps.

- `floors[]`: `id`, `name`, `elevation`, `height` (floor-to-floor), `rooms[]`
  (`id`, `name`, `type`, `x`, `y`, `w`, `h`; stairs have `up`: N/S/E/W, optional `shape: 'U'` with `turn`
  left|right and `winders: false` for a half landing; `stairSteps(analyzeStairs(...))` in
  `public/stairs.js` gives the tread polygons every view draws),
  optional `round`: 'N'|'S'|'E'|'W' rounds that side into a half ellipse as wide as the room (a
  bay or apse; deeper rooms become D-shaped towers), 'all' makes an ellipse/circle; geometry in
  `public/geometry.js` (`roundShape`, `inRoom`, `area`, `curvedWalls`); exterior openings on the
  curve use the facade it faces; round rooms open to the sky get cone roofs (`roundRoofs` in
  `public/roof.js`, `roofPitch` on the room),
  `openings[]` (exterior: `type` window/door/terrace-door/sliding-door, `facade`, absolute `x`
  (N/S) or `y` (E/W) of the start, `width`, `sill`, `height`; hinged doors `hinge` start|end and
  `swing` in|out, sliding doors `hinge` = side the leaf slides to), `doors[]` (interior: `between: [a, b]`, `offset` along the
  shared wall from its west/north end, `type` door/sliding/opening, `swing`, `hinge`),
  `walls[]` (settings: `{between:[a,b]}` sorted or `{room, side}`, with `type`
  wall/railing/glass/none, `loadBearing`, `thickness`, `material`).
- `floors[].items[]`: furniture/appliances (`type` from `public/items.js`, `x`/`y` top-left of
  the footprint, `w` along the front, `d` depth, `h`, `rot` 0/90/180/270, optional `name`,
  `color`, `circuit`).
- `floors[].points[]`: utility points (`kind` from `POINT_KINDS` in `public/utilities.js`, `x`,
  `y`, `h` mounting height, `room`, `circuit`, `for` = item id, `auto: true` when generated —
  generated points are replaced on regeneration, hand-placed ones are kept).
- `electrical.circuits[]`: `id` (L1 lights, S1 sockets, K1 counter, B1 bathroom, A1 appliance),
  `name`, `kind`, `voltage`, `breaker`, `rcd`, `phase`, `load` (W), `auto`.
- `rooms[].finish`: `{ floor, walls }`, each `{ kind: 'color', color }` or `{ kind: 'tiles',
  color, texture: 'assets/<file>', tileW, tileH, grout, groutWidth, pattern
  straight|brick|diagonal, start NW|NE|SW|SE|center }`; walls also take `height`.
  `rooms[].zones[]`: `{ id, name, order, x, y, w, h, finish }` tile zones inside the room.
- `costs`: `{ currency, budget, prices: { key: unit price } (overrides of DEFAULT_PRICES /
  ITEM_PRICES in public/costs.js), exclude: [line ids], includeFurniture, designPct,
  contingencyPct, currency (display only), rates { date, source, values } (ECB, 1 EUR = x),
  rateOverride { CUR: x } }`. All amounts are EUR; `estimate(house)` in `public/costs.js` computes
  the lines and `moneyFor(house)` formats EUR in the display currency; `public/costExport.js`
  turns it into CSV / a printable table. Wall-mounted items (`mount` in `public/items.js`, e.g.
  `kitchen-wall` at 1.5 m) may overlap the counters below them. `/api/rates` serves the ECB
  rates (cached in `rates-cache.json`).
- `site[]`: plot, garage, terrace, pool, greenhouse, driveway, path… (`x`, `y`, `w`, `h`);
  garage/shed/greenhouse/carport/pergola also take `height` and `roof` (same fields as the house
  roof, default flat); trees/conifers/bushes/hedges use w/h as the crown and `height`. The plot
  sets `street` (N/S/E/W, for the site plan label) and can carry `points` (polygon) and driveway/path `points` + `width` (curved centre line); x/y/w/h
  stay the bounding box (`public/shapes.js`, call `syncBox` after editing points).
- `roof` (single roof) or `roofs[]` (roof areas: `id`, `name`, `on` floor id, wall-axis `x/y/w/h`,
  `type` flat/shed/gable/hip/mansard, `pitch`, `ridge` x|y, `low`, `overhang`, `parapet`,
  `walkable`, `lowerPitch`/`breakHeight` (mansard), `material` / `topMaterial` (covering, keys of
  `ROOF_COVERINGS` in `public/roof.js`; topMaterial is a mansard's shallow top), `chimneys[]`). Floors with `underRoof: true`
  are attics: no outer walls in 3D, their windows (`dormer`: gable/arch/flat) become dormers.
  Comment target for a roof area: `roofs/<id>`. Roof areas re-fit to the floors on every change (lower wings keep their roof type)
  (`syncRoofZones` in `public/roof.js`, called from `store.changed()`) unless `house.roofAuto`
  is `false`; areas with `fixed: true` were placed by hand and are left alone. When editing
  rooms in `house.json` directly, run `syncRoofZones(house)` afterwards.
  `public/issues.js` `collectIssues(house)` lists every warning shown in the top-bar popover.
- `facade`: `render`, `trim`, `shutters`, `plinthColor` colours and `cornice`, `quoins`, `bands`,
  `plinth`, `rustication` (bosáž) switches (`public/facade.js`); exterior openings may have `shutters`, `juliet`, `surround`.
- `wall`: default thicknesses; `targets.livingArea`; `rules.stairs`, `rules.structure`.

Comment targets: `house`, `roof`, `site/<id>`, `<floorId>/<roomId|doorId|openingId>`,
`<floorId>/wall:<a>:<b>` (interior) or `<floorId>/wall:<room>:<side>` (exterior).

## Applying comments (`/apply-comments [house]`)

See `.claude/commands/apply-comments.md`. Work inside `houses/<slug>/`, commit in that
house's own repository (one commit per comment), and respect its `BRIEF.md` if present.

## Conventions

- Keep the app dependency-free apart from Three.js; plain ES modules.
- Every geometric helper lives in `public/*.js` modules that also run in Node (no DOM), so
  checks can be scripted: `node --input-type=module -e "import('./public/stairs.js')…"`.
- The planner gives concept-level checks only. Never present them as code compliance; the
  architect, structural engineer and licensed installers sign the real project.
