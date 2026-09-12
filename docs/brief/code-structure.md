# §9a. Code-structure rules (enforced by CI)

Part of the App Brief — see [`../../APP_BRIEF.md`](../../APP_BRIEF.md).

Moved out of `APP_BRIEF.md` §9 when that file passed the 500-line cap it is
itself describing. The rules did not change; `CLAUDE.md` states the same ones as
working instructions, and this is the brief's record of WHY each exists.

- **500-line hard maximum** for every hand-written
  `.js/.jsx/.mjs/.cjs/.ts/.tsx/.py` file in the repository. `npm run
  lint:filesize` enforces it, walking from the repository ROOT and skipping only
  what is provably machine-produced (installed dependencies, build output,
  caches, minified files). **There is no baseline and no exemption list** —
  `scripts/fileSizeBaseline.json` is gone and `tests/checkFileSize.test.js`
  asserts it stays gone, so a new violation cannot be waved through by editing a
  JSON file. The scanner is a deny-list on purpose: an earlier version walked a
  hard-coded list of INCLUDED directories and silently missed whole areas as the
  tree grew (first `leads-bot/`, then `admin/vite.config.js` and its siblings).
- **`npm run lint:undef`** — `eslint .` with only bug-finding rules enabled
  (`no-undef`, `no-const-assign` and a handful of the same shape; no style
  rules, so a report is always real). This is the check a build is not: a
  module split left 26 identifiers behind in files that no longer imported them,
  and `vite build` passed every time because a bundler treats an unresolved
  module-scope name as a global and defers the failure to runtime. Coverage is a
  deny-list, and `tests/checkUndefined.test.js` asserts the rule is in force for
  every hand-written JS file in the tree.
- **`npm run lint:imports`** — the mirror image, which no scope check can see: a
  name that IS declared, by an import pointing at a module that does not export
  it (Rollup only warns and emits `undefined`). Conservative by design: a module
  whose export surface is not statically knowable is skipped rather than guessed
  at. Covered by `tests/checkImports.test.js`, including the false-positive
  classes that nearly made it useless.
- Prefer a **re-export-only façade plus focused modules** when an import path must
  be preserved. `services/routeControlService.js` → `services/routeControl/*` is
  the reference example: 18 lines, pure re-export, nothing of its own.
  (`database/db.js` is a *partial* version of the same idea — it re-exports, but
  it also still owns live code: `initializeDatabase()`, the `admins` queries, the
  `service_runs` claim helpers and the group-directory queries. Do not treat it as
  re-export-only.)
- Dependencies flow one way: routes → service façade → focused services →
  database/integrations → pure helpers. **No circular dependencies.** No business
  logic in route files.
- Keep pure decision logic separate from I/O so it can be unit-tested without a
  database or network — this is why so many services export pure evaluators.
