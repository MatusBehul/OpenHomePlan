# OpenHomePlan

A local, open-source planner for designing a family house: 2D floor plans, a 3D model, walls,
doors, stairs, load-bearing structure, roof, comments and full version history, all driven by
one JSON file per house. It runs on your own computer; nothing is uploaded anywhere.

```
npm install
npm start        # http://localhost:3000  (PORT=xxxx npm start to change)
```

Free software under the MIT license. Contributions are welcome: see
[CONTRIBUTING.md](CONTRIBUTING.md). Architects, engineers and installers: the checks and example
prices are simplified, please tell us where they are wrong (open an *Expert review* issue). The
public page lives in [`site/`](site/) and is published at https://openhomeplan.wadby.tech
(Cloud Run, see [`deploy/README.md`](deploy/README.md)).

**Privacy:** the planner runs only on `localhost` and contacts nothing on the internet, except the
European Central Bank when you ask it to download exchange rates.

**Not a permit document:** the checks are rules of thumb for the concept stage. An authorised
architect and engineers design and sign the real project.

## Your houses

Pick a house from the dropdown at the top left, or choose **＋ New house…** to start from a
template (a blank floor, or the example family house) or from a copy of the current house.

Each house is a folder with its own git history:

```
houses/
  family-house/
    house.json            the whole design
    BRIEF.md              (optional) the owner's requirements
    comments/open/*.md    comments waiting to be applied
    comments/resolved/*.md
    assets/               uploaded textures
```

To keep your houses in the cloud, put the folder in a synced drive (Google Drive, Dropbox,
iCloud, OneDrive) and point the app at it, either with an environment variable

```
HOUSES_DIR="~/Google Drive/My Drive/houses" npm start
```

or by copying `planner.config.example.json` to `planner.config.json` and editing `housesDir`.
Avoid editing the same house on two computers at once: the sync service does not merge git
histories.

## Using the planner

- **2D plan**: one tab per floor. Drag a wall to move it: every room on both sides follows, so
  the floor stays tiled. A selected room's handles do the same; Shift+drag a handle to resize
  only that room. Drag rooms to move them, or type exact numbers in the sidebar. Everything snaps
  to 0.25 m and to nearby walls. Scroll to zoom, drag empty space to pan, double-click to re-fit.
  **+ Room** in the plan toolbar adds a room on the floor you are looking at.
- **Issues**: the warning count in the top bar opens a list of everything that needs attention
  (overlapping rooms or gaps, doors and windows no longer on a wall, rooms with nothing below,
  stairs, structure). **Show** jumps to the problem in the plan.
- **Round rooms**: a room's **Shape** can be rounded on one side (a half-round bay, e.g. a
  dining space off the kitchen; make the room deeper than half its width for a D-shaped tower)
  or fully round/oval. Walls, windows, floor area and costs follow the curve; a round room open
  to the sky gets a cone roof, so a tower that rises a floor above the house gets a turret.
- **Furniture**: drag it in the plan or in 3D; the edge handles resize it (R rotates).
- **Garden**: "+ Site element…" adds trees, conifers, bushes, hedges, a garden shed, a carport or a
  pergola (a roof on posts, with the same roof options as the house). Select the driveway or a
  path and choose **Make it curved**, or the plot and choose **Irregular shape** (the plot also
  sets which side the street is on): drag the round
  points, drag a small + to add one, double-click a point to remove it.
- **Doors & windows**: select a room and use "+ Add door, passage or window…" (hinged door,
  sliding door, open passage without a door, window, exterior door). Click one in the plan to
  edit it, drag it along its wall, or drag its end handles to make it wider or narrower.
- **3D**: whole house with roof, or a cut-away of any floor (walls cut at 1.6 m, the floor above
  shown see-through so you can see where the stairs lead). Click anything to select it.
- **Walls**: click a wall to edit it: type (wall, 1 m railing, glass partition, or no wall),
  load-bearing, thickness and material. "Apply to whole wall line" copies the settings along a
  straight wall. The plan legend shows load-bearing walls dark and partitions grey.
- **Structure check** (concept level, not a calculation): warns when a floor slab spans more than
  `rules.structure.maxSlabSpan` (6 m) between load-bearing walls, and when a load-bearing wall
  has nothing load-bearing underneath. Problems are outlined in red.
- **Roof**: whole-house panel → "Edit roof" (or click the roof in 3D): flat (with parapet),
  mono-pitch, gable, hip or **mansard**, with pitch, ridge direction or low side, and overhang.
  Choose the **covering** (concrete or clay tiles, fibre-cement or natural slate, zinc or steel
  standing seam; a mansard can have zinc on its shallow top): it sets the colour and the price.
  **Split into roof areas** to give each building part its own roof: a main roof, a lower wing,
  a bay, or a flat **walkable roof terrace / balcony** with a balustrade; add **chimneys**. The
  **Roofs** layer shows the areas in the plan, where they can be moved and resized. Roof areas
  **follow the building automatically**: add, move or remove rooms and the roofs re-fit (a
  terrace split by a new room stays a terrace). An area you move or resize by hand stays where
  you put it until you choose "Fit it automatically again"; untick **Fit roofs automatically**
  to manage all areas by hand. A walkable roof terrace is also drawn on the plan of the floor
  you step out onto, where you can select and resize it. Tick
  **Attic** for a floor in the floors table to put it under the roof: its outer walls are the roof
  and its windows become **dormers** (triangle, round or flat top). The garage,
  garden shed and greenhouse have the same roof options in their own panel (select them in the
  plan or in 3D), together with their wall height.
- **Furniture & appliances**: select a room → "+ Add furniture or appliance…" (kitchen, living,
  bedroom, bathroom, utility, garage). Drag to place, **R** rotates, **Delete** removes. Each
  appliance knows what it needs (power and voltage, water, drain, gas), which feeds the utilities.
- **Utilities**: whole-house panel → **Generate utilities** proposes sockets, switches, lights,
  a distribution board, data points, cold/hot water, drains and gas from your rooms and
  appliances, groups them into circuits balanced over the three phases (230 V / 400 V) and
  estimates the load and main breaker. Points you place or move by hand are kept when you
  regenerate. Toggle the **Electrical** and **Water & gas** layers above the plan.
- **Finishes**: per room, a floor and a wall finish: a single colour (colour picker) or tiles
  (size, grout, pattern, start corner, and a photo of the tile dropped onto the panel). Add
  **tile zones** to tile parts of a room differently and set the laying order. Shown in the
  **Finishes** layer and in 3D.
- **Costs** (tab next to 2D/3D): an estimate built from the plan's own quantities (walls, slabs,
  roof, windows and doors, floor and wall finishes, utility points, fittings, site elements,
  fees and contingency) × an editable price list. Enter your **budget** to see what is left or
  how far over you are, and roughly how many m² of living area that buys at your house's cost
  per m². Untick lines (pool, greenhouse, furniture…) to try variants; loose furniture is left
  out until you tick it (all of it with "Include loose furniture", or piece by piece). Kitchen
  counters and wall cabinets are priced per metre of run. The built-in prices are
  example values (EUR, rough central-European level incl. VAT): replace them with your
  builder's quotes. Until the kitchen, bathrooms and utilities are planned, allowances stand in.
  All prices and the budget are kept in **EUR**. "Show in" converts the whole tab (and the top bar
  and the brief) to another currency using the European Central Bank's daily reference rates,
  downloaded on demand and saved with the house; type your own rate (e.g. your bank's) to
  override it. Prices and budgets typed in another currency are converted back to EUR.
- **Facade**: in the whole-house panel choose wall, trim and shutter colours and switch on a
  cornice, corner stones, a band between the floors, a stone base and a rusticated (grooved)
  ground floor. Select any window or door
  to give it shutters, a Juliet balcony or a stone surround, or use the buttons to add them to
  all suitable openings at once. Shutters are sized to fit between neighbouring openings.
- **Name & description**: edit them at the top of the whole-house panel.
- **Export** (top bar): **Plans & brief** opens print-ready sheets at true scale (site plan,
  3D views from four angles, floor plans, furniture & finishes, electrical, water & gas) with a title block, plus the
  handover brief; print them or "Save as PDF". **DXF** downloads all floors on CAD layers
  (metres). **Handover brief (.md)** downloads a document for the architect, structural
  engineer, electrician and plumber: rooms, openings, load-bearing walls, stairs, roof,
  circuits and loads, water/drainage/gas points, tile quantities and the open questions.
  **Cost estimate** comes as a spreadsheet (.csv, opens in Excel/Numbers/LibreOffice) or as a
  printable sheet with every line (also a sheet type in the plans printout, and buttons at the
  bottom of the Costs tab).
- **Undo/redo**: Ctrl/⌘+Z and Ctrl/⌘+Shift+Z (or the arrow buttons). A whole drag is one step.
- **Floors**: in the whole-house panel add floors above or a basement, rename them, and set
  levels and floor-to-floor heights (floors above move with the height). The living-area
  target is set there too.
- **Stairs check**: select a stairs room to see risers/treads, whether it fits, whether there is
  a way in at the foot and a way out at the top, and an **Auto-fix** button. Stairs are
  **straight** or **U-shaped** (half turn, with winders or a half landing, turning left or right);
  a U-shaped stair needs only about half the length. The rules
  (max riser, min tread, 2·riser + tread, min width) live in `house.json` under `rules.stairs`
  and are planning values only.
- **Save** (or Ctrl/⌘+S) writes `house.json` and commits it to git.
- **Comments**: select a room, site element, or nothing (= whole house) and add a comment.
  It is written to `comments/open/<id>.md` and committed. Run `/apply-comments` in Claude Code
  to have them applied.
- **History** in the sidebar shows the latest git commits.

## What the planner is (and is not)

It helps you think the house through and hand a precise, complete brief to the professionals.
Its checks (stairs, slab spans, electrical load) are planning rules of thumb. The permit and
construction documents must be prepared and signed by an authorised architect and engineers,
and the installations designed by licensed electricians and plumbers.

## License

MIT, see [LICENSE](LICENSE).
