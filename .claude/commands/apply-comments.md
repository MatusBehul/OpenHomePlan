---
description: Apply a house's open comments to its house.json (one commit per comment)
argument-hint: "[house folder name]"
---

Which house: `$ARGUMENTS` if given, otherwise the house in the houses folder whose
`comments/open/` has comments (ask if several do). The houses folder is `HOUSES_DIR`, else
`housesDir` in `planner.config.json`, else `./houses`. Below, paths are relative to that
house's folder, and **git commands run inside that folder** (each house is its own repository).

0. Comments written in the online demo wait in a Google Drive folder "OpenHomePlan comments"
   (the commenter's Drive). If a Google Drive connector is available, find that folder, download
   each `.md` file in it to a temporary folder and run `npm run import-comments -- <that folder>`
   from the planner's folder: it files every comment under its house (matched by `house_folder`)
   and commits it. Then move the imported files to the Drive trash (the command prints
   "Imported comment …" per file; files it could not match stay, report them). The running
   planner also imports them by itself from a Google Drive folder synced on this computer.
1. Read `BRIEF.md` if the house has one, then every `.md` file in `comments/open/` (ignore
   `.gitkeep`). Process them oldest first (by `created`).
2. For each comment, change `house.json` (and the app code in the app repository, if the comment
   is about the app).
   - Targets: `<floorId>/<roomId>` is a room, `site/<id>` is a site element, `house` is the whole
     house, `roof` is the roof; doors, windows and walls have their own ids (see CLAUDE.md).
   - Keep total living area (all rooms except `type: "void"`) within `targets.livingArea` unless the
     owner says otherwise.
   - Keep rooms tiling each floor's footprint with no overlaps or gaps. When moving a wall, change
     every room edge on that wall line so neighbours follow.
   - Exterior windows/doors (`floor.openings`) are placed by absolute `x` (north/south facades) or
     `y` (east/west facades) of their start; keep them on an exterior wall of the right room.
   - Interior doors (`floor.doors`) sit on the wall shared by the two rooms in `between`, `offset`
     metres from that wall's west/north end. `type` is `door` (hinged; `swing` = room it opens into,
     `hinge` = `start`|`end`), `sliding`, or `opening` (open passage, no door). Remove doors whose
     rooms no longer touch, and make sure every room stays reachable.
   - Wall settings live in `floor.walls`: `{ between: [roomA, roomB] }` (ids sorted) for interior
     walls or `{ room, side }` for exterior ones, with `type` (wall/railing/glass/none),
     `loadBearing`, `thickness`, `material`. Comment targets for walls look like
     `<floorId>/wall:<a>:<b>`. Keep `structureIssues` in `public/structure.js` clean.
   - Furniture, utility points, circuits, finishes and tile zones are described in CLAUDE.md. After
     moving rooms or appliances, regenerate utilities with `generateUtilities` from
     `public/utilities.js` if the comment asks for it (hand-placed points are kept).
   - The roof is `house.roof`: `type` flat/shed/gable/hip, `pitch`, `ridge` (x|y), `low`
     (mono-pitch), `overhang`, `parapet`.
   - Stairs (`type: "stairs"`, climbing towards `up`) must keep a way in at the foot and arrive in a
     walkable room through an opening in the railing above. Check them with `analyzeStairs` /
     `fixStairs` in `public/stairs.js` (rules in `house.rules.stairs`).
3. Append a `## Resolution` section to the comment describing what changed, set `status: resolved`
   in the front matter, and move the file to `comments/resolved/` (use `git mv`).
4. Make one git commit per comment containing the house.json change and the moved comment file,
   with the message `Apply comment <id>: <short summary>`.
5. If a comment is unclear or conflicts with the brief, leave it in `comments/open/`, don't commit
   anything for it, and ask the owner about it at the end.

Finish with a short list of what was applied and what was left open. The running app picks up
changes after a browser reload.
