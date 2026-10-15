# Roadmap and to-dos

Things to revisit. Tick them off in pull requests; move bigger items into issues once the
repository is public.

## Going public

- [x] Name: **OpenHomePlan**; repository https://github.com/MatusBehul/OpenHomePlan; public page
      on https://openhomeplan.wadby.tech (Cloud Run, GCP project `openhomeplan`)
- [x] Renamed everywhere; links point to the repository
- [ ] Trademark search for "OpenHomePlan"
- [ ] Push a fresh history under the maintainer's name (one initial commit)
- [ ] GitHub settings: protect `main` (pull request + code-owner review + "Checks" passing, no
      force pushes), private vulnerability reporting, Discussions, labels (good first issue,
      help wanted, expert-review)
- [ ] Google Cloud one-time setup and repository variables (`deploy/README.md`), first deploy
- [ ] Verify `wadby.tech`, map `openhomeplan.wadby.tech`, add the CNAME record
- [ ] Release v0.1.0 with release notes; a short screen recording for the public page
- [ ] Social preview image for the repository (Settings → General): `site/img/render-hero.jpg`

## Issues to seed (label good first issue / help wanted / expert-review)

- [ ] L-shaped stairs
- [ ] Roof windows (skylights) in attics
- [ ] Knee walls for attic floors (eave above the attic floor)
- [ ] Garage door opening type
- [ ] Unheated rooms (garage, storage) priced as shell only in the cost estimate
- [ ] Round towers that cut into a corner of the house (overlapping rooms); stairs inside round rooms
- [ ] Czech / Slovak user interface (translations)
- [ ] Stair and structure rules per country; example prices per region
- [ ] Furniture under low attic eaves: warn when tall items stand where the roof is low

## Quality

- [ ] Move the browser (Playwright) tests into `tests/` and run them in CI with a bundled Chromium
- [ ] Visual regression snapshots of the plan, 3D views and print sheets for the example houses

## Outreach

- [ ] Ask civil-engineering faculties (ČVUT, VUT, STU), self-build communities and practising
      architects / structural engineers to try it and file expert reviews
