# Contributing

Thank you for helping! This is a small, dependency-light project, so contributions are easy to
review when they stay focused.

## Run it

```
npm install
npm start      # http://localhost:3000
npm test       # checks that run without a browser
```

Your test houses live in `houses/` (ignored by git) or wherever `HOUSES_DIR` points.

## How changes get in

1. Open an issue first for anything bigger than a fix, so we can agree on the approach.
2. Fork, create a branch, keep the pull request to one topic.
3. `npm test` must pass (it runs automatically on every pull request).
4. For visual changes, add before/after screenshots of the plan, the 3D view or the print sheets.
5. The maintainer reviews and merges. Nothing is merged without a review.

## Code conventions

- Plain ES modules in `public/`, no build step, no framework. Three.js is the only dependency;
  please don't add others without discussing it first.
- Geometry and checks live in modules without DOM access (`geometry.js`, `stairs.js`,
  `roof.js`, `costs.js`, …) so they can be tested in Node. Put new logic there and add a test in
  `tests/`.
- Match the surrounding code: names, comment density, small functions.
- `house.json` is the user's data. Changes to its format must stay backwards compatible (old
  files keep loading) and must be documented in `CLAUDE.md` (the data model reference).
- Checks are planning aids, not code compliance. Word messages accordingly ("about", "at least",
  "your engineer decides").

## Experts welcome

Architects, structural engineers, electricians, plumbers, energy consultants and cost
estimators: the rules and example prices in this tool are simplified on purpose, and some are
surely wrong for your country. Open an **Expert review** issue with what should change and why;
you don't need to write code.

## Working with an AI assistant

The repository is set up for Claude Code (`CLAUDE.md` describes the code and the data model,
`.claude/commands/apply-comments.md` the comment workflow). AI-assisted pull requests are welcome
under the same rules: you are responsible for what you submit, and you must have checked it.

## License

By contributing you agree that your contribution is released under the MIT license of this
project.
