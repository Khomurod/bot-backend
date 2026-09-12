# CLAUDE.md

Working rules for AI-assisted development (Claude Code and similar agents) in
this repository. This file is **how to work here**. It is deliberately short —
what the application *is* lives in the App Brief, and deep per-feature rules live
in the specialized docs linked at the bottom.

# Start with the App Brief

**[`APP_BRIEF.md`](APP_BRIEF.md) is the central brief for this application — read
it before any task.** Its per-area sections live in
[`docs/brief/`](docs/brief/) and are part of the same document. It covers what the app is for, who uses it, the features
and workflows, permissions, integrations, background jobs, cross-feature
dependencies, and the decisions that must not be broken.

**The brief is a living document.** After completing any meaningful change —
feature, fix, removal, behavioral/integration/workflow/permission/schema change —
re-read it and update whatever your work made untrue, **as part of the same
task**. A task is not complete while the brief and the application disagree. The
maintenance rule is stated in full at the top of `APP_BRIEF.md`.

# The implementation workflow

For any real change to how the application behaves, follow
[`.claude/skills/implement/SKILL.md`](.claude/skills/implement/SKILL.md) —
understand → investigate → implement → test → self-review → verify →
documentation → report. Invoke it with `/implement <what you want to be true>`.
That skill owns the universal process; this file owns the repository-specific
rules it has to obey.

# Orientation and optional tools

**The current source code is the truth.** Every document in this repository,
including this one and the App Brief, can lag behind the code. Verify important
conclusions against the source before you rely on them.

To orient yourself in a task, use whatever is actually available to you:
`APP_BRIEF.md`, the current source, repository search and navigation, the
specialized docs below, the tests, and `git log` / `git diff` where history is
relevant. **That is always sufficient to work here.** No task in this repository
requires a machine-specific or local-only service to begin.

Optional accelerators — use them when they are present and the task is big
enough to benefit, and never let their absence block or delay work:

- **codebase-memory-mcp** — architecture, orientation and impact analysis
  (`get_architecture`, `search_graph`, `trace_path`, `get_code_snippet`). It is
  an **optional accelerator, not a prerequisite.** If it is connected and the
  task is substantial (cross-cutting change, unfamiliar feature, impact
  analysis), consult it first, then **confirm what it told you against the
  current source** — its index may be stale or incomplete. If it is not
  available, proceed normally with the sources above; there is no need to warn
  the user about its absence during ordinary work. Update or re-index it after
  meaningful architectural change **only when it is actually available**.
- **Context7** — current public library and API documentation only. Never send
  private source code, passwords, tokens, `.env` values, or company information
  to it.
- **Gitleaks** — read-only secret checks: `gitleaks dir . --redact`. Report the
  file name, line number and finding type only; never print a discovered value,
  and never let it rewrite files.

**Never claim you used a tool you did not actually call successfully.**

# Safety Rules

- Never expose production credentials (Telegram bot tokens, Google API keys,
  database URLs, ELD/RingCentral/Facebook secrets) in code, logs, commits, or
  chat output.
- Never make destructive database changes without explicit approval and a
  backup. Schema changes must be additive and idempotent. The database is
  managed by the migration system in `database/migrate/`:
  `initializeDatabase()` applies the baseline `database/schema.sql` (GENERATED
  from `database/baseline/*.sql` via `npm run build:schema`; runs verbatim on
  every boot) and then any pending, run-once forward migrations in
  `database/migrations/` (tracked in the `schema_migrations` ledger). Put NEW
  changes in a forward migration (`npm run migrate:new -- <name>`); do not
  hand-edit `database/schema.sql`. See `docs/database/migration-notes.md`.
- Never point a local process at production tokens or the production database —
  `node index.js` with production env polls the production bot and sends real
  messages to real drivers.
- Run the relevant tests before claiming success, and report exact results
  (command, pass/fail counts). Do not claim a test passed unless it was run.
- Do not merge without reviewing the final diff.
  **Repository-specific caution:** a push here opens and merges nothing by
  itself — `.github/workflows/` holds only `ci.yml`, so the agent opens the PR
  and the repository owner merges it (29 minutes to 8 hours later, on PRs
  #161–#163). The push is still the point of no return, because **`main`
  auto-deploys to Render** and the owner may merge at any moment without asking
  for a second look. **Review the complete diff BEFORE pushing.**

# Testing expectations

```
node --test --test-concurrency=1 tests/*.test.js   # bash glob (PowerShell does not expand it)
npm test                                           # gates + Node suite + Python leads tests
npm run build --prefix admin                       # admin production build
npm test --prefix admin                            # admin component tests
npm run lint:undef                                 # undefined identifiers (the check a build is NOT)
npm run lint:imports                               # an import naming a missing export
npm run lint:filesize                              # 500-line limit
npm run build:schema:check                         # schema.sql in sync with baseline/
```

- **A green build is not a scope check.** A module split once left 26
  identifiers behind in files that no longer imported them — including
  `getDaysUntilBirthday` on the Driver Groups page and `activeRun` in the
  mileage-bonus scheduler — and `vite build` passed every time, because a
  bundler treats an unresolved module-scope name as a global and defers the
  failure to runtime. `lint:undef` (only bug-finding ESLint rules: `no-undef`,
  `no-const-assign` and a few of the same shape) and `lint:imports` (a declared
  name whose module does not export it) are the two checks that catch that
  class. Both run in `npm test` and in CI. **After splitting or moving a
  module, run them** — they take seconds and they are the difference between a
  refactor and an outage.

- **The Node suite passes clean with no secrets and no database**, so **any
  failure is a real failure.** There is no "expected failures in a bare
  environment" allowance — do not dismiss one that way. (If you see mass
  failures, check that `npm install` has run; a bare clone dies at
  `require('dotenv')`.) The verified baseline is recorded in `docs/brief/testing.md` (§11 of the brief).
- **`*Pg.test.js` need `TEST_DATABASE_URL` and SKIP without it — a skipped test
  is not a passing test.** Say so plainly rather than folding skips into a green
  summary. The harness (`tests/helpers/pgHarness.js`) creates a throwaway
  **database** per test (not a schema — `schema.sql` guards look up constraints
  by name with no schema filter) and applies the real, complete `schema.sql`. The
  database must be **UTF8** (`TEMPLATE template0`), because `schema.sql` contains
  box-drawing characters in comments.
- **CI** (`.github/workflows/ci.yml`) runs static checks + the admin build, the
  Node unit suite with no application env at all, and the PostgreSQL integration
  suite against a real Postgres 16 container. **Both test jobs fail on ANY skip.**
- Prefer the test endpoints over real sends when validating manually (see
  `docs/brief/testing.md`).

# Maintainability

## Maximum source-file size

- No hand-written source-code or test-code file may exceed **500 physical lines**.
- This is a hard maximum, not a target.
- Begin splitting a file before it reaches approximately 400 lines.
- Split by cohesive responsibility and domain boundary, not arbitrary line
  ranges.
- Do not evade the limit through minification, compressed formatting, multiple
  statements per line, generated-looking code, or moving giant functions into
  another catch-all file.
- New and modified files must comply before work is considered complete.
- When touching an existing file over 500 lines, reduce it below the limit as
  part of that work, or explicitly stop and report why a separate approved
  refactor is required.
- Generated files, vendored dependencies, package-lock files, build output, and
  machine-generated artifacts are excluded.
- Database schema snapshots or generated migrations may be excluded only when
  splitting them would break their tooling.
- Prefer a small compatibility façade plus focused internal modules when an
  existing import path must be preserved. `services/routeControlService.js` →
  `services/routeControl/*` is the reference example; `database/homeTime.js` →
  `database/homeTime/*` follows the same shape. The same idea applies to a
  static page: `server/public/remote.html` is a document plus `remote.css`,
  `remote-mqtt.js` and `remote-app.js`, and `server/presentation/index.html` a
  document plus a stylesheet and three scripts — both served through an
  explicit route allow-list, never `express.static`.
- A façade must be composition or re-export ONLY. When a spread
  (`...module`) would widen the public surface with internals, list the keys
  explicitly and say why in the file's header — `database/ringcentral.js` does
  this to keep four helpers private.
- Reformatting to pack more code onto fewer lines is not a fix. A file of 285
  physical lines that is ~679 lines at normal density is over the limit in
  substance. `admin/src/index.css` was split into twelve ordered partials and
  the emitted stylesheet verified byte-identical, rather than compacted to
  satisfy the counter.

### Checking the limit

```
npm run lint:filesize        # enforce: fails on ANY file over the limit
npm run lint:filesize:list   # list every file over the limit (same scan, report only)
```

**Coverage now includes `.css`, `.html`, `.md`, `.sql`, `.yml` and `.yaml`**,
not just `.js/.jsx/.mjs/.cjs/.ts/.tsx/.py`. Excluding the first three had let a
2 500-line stylesheet, a 1 320-line page with its CSS and JS inlined, and an
1 140-line brief grow past every other rule in the repository; all three split
cleanly. SQL and YAML followed because `database/baseline/*.sql` and
`.github/workflows/*.yml` are hand-written and read by people, and the largest
baseline segment was already within 25 lines of the limit. The generated
`database/schema.sql` is excluded **by name** — not by leaving `.sql` out of
scope, which is what had made the exclusion comment's claim that "the segments
it is assembled from ARE checked" untrue. `.json` stays out: every JSON file
over the limit is a lockfile, and a JSON object cannot be given a façade.

**There is no baseline and no exemption list.** Every hand-written source, test
and config file in the repository is at or under 500 lines, so the rule is
literally true and a new violation cannot be waved through by editing a JSON
file. `scripts/fileSizeBaseline.json` is gone;
`tests/checkFileSize.test.js` asserts it stays gone.

The scanner walks from the repository ROOT and skips only what is provably not
hand-written (installed dependencies, build output, caches, minified or
generated files). It is a deny-list, not an allow-list: an earlier version
walked a hard-coded list of INCLUDED directories and silently missed whole
areas as the tree grew — first `leads-bot/` and its Python, then
`admin/vite.config.js` and its siblings one level above `admin/src`. Inverting
the default means a new directory of hand-written code is covered the moment it
is created.

`tests/checkFileSize.test.js` covers the scanner itself: the limit's exact
boundary, line counting against `wc -l`, each excluded category, and — the
sentinel — that the repository has no file over the limit.

## Module design

- Modules must have one clear primary responsibility.
- Circular dependencies are prohibited. Dependencies flow one way:
  routes/controllers → service façade/orchestrators → focused domain services →
  database and external integrations → pure helpers/constants.
- Business logic does not belong in route/controller files.
- Separate pure logic from I/O when practical — prefer pure functions for
  formatting, normalization, and decisions (tracking, deviation, completion,
  error/status construction), and keep database writes and Telegram calls in
  explicit orchestration functions.
- Shared logic must be extracted, never copied.
- Shared mutable state must have one clearly documented owner.
- Avoid "utils.js" dumping grounds and modules that exist only to re-export a
  single trivial function.
- **Pure helpers and constants live in `lib/`, the layer BELOW the database.**
  Anything with no I/O and no mutable state that more than one layer needs
  belongs there, in a domain subdirectory — see [`lib/README.md`](lib/README.md)
  for the charter and the rule for adding to it. Nine such modules used to sit
  in `services/`, a layer above the database, which forced nineteen
  `database/**` modules to depend upward. `database/**` now depends on nothing
  above it.
- Tests must be reorganized when they become oversized, rather than consolidated
  into giant files.

# Per-feature invariants — read before touching these areas

Each of these features carries hard invariants that were written after a
production incident or a near miss. **Read the linked document before changing
that area**, and run the tests it names.

| Area | Read first |
|---|---|
| Route Control, route screenshots, Telegram media transport | [`docs/architecture/route-control.md`](docs/architecture/route-control.md) |
| Which recruiter's number texts a lead, which MESSAGE they send, the E.164 `from` rule, per-recruiter RingCentral credentials, inbound-SMS subscriptions | [`docs/architecture/recruiter-sms-sender.md`](docs/architecture/recruiter-sms-sender.md) |
| The Dispatcher Board feed, which system is the authority on a driver's current assignment, fleet types, and why a truck number alone is not unique | [`docs/architecture/dispatcher-board.md`](docs/architecture/dispatcher-board.md) |
| Fleet type, `(fleet_type, unit_number, seat)`, team seats, and the two driver-type vocabularies | [`docs/architecture/fleet-type-and-unit-identity.md`](docs/architecture/fleet-type-and-unit-identity.md) |
| Which Telegram account belongs to which driver, one human per account, and why a username is never evidence | [`docs/architecture/telegram-identity.md`](docs/architecture/telegram-identity.md) |
| Samsara settings, the shared-secret envelope for its API key, missing-video recovery | [`docs/architecture/samsara-settings-and-video-recovery.md`](docs/architecture/samsara-settings-and-video-recovery.md) |
| The Bitrix assignee lookup, recruiter↔Bitrix mapping, Bitrix connection settings | [`docs/architecture/recruiter-sms-bitrix.md`](docs/architecture/recruiter-sms-bitrix.md) |
| Where AI may change stored operational state, and the verdict on each | [`docs/architecture/ai-decisions.md`](docs/architecture/ai-decisions.md) |
| How a decision is reached, why `hold` and `unknown` are opposites, and what a mode may never do | [`docs/architecture/decisions.md`](docs/architecture/decisions.md) |
| Where an operational notice goes, and what it may never say | [`docs/architecture/operational-notifications.md`](docs/architecture/operational-notifications.md) |
| Answering Wenze in Telegram: who may be obeyed, what a reply may choose, and why the bot never touches source code | [`docs/architecture/control-channel.md`](docs/architecture/control-channel.md) |
| What Wenze may tell a candidate, and how a person teaches it | [`docs/architecture/recruiting-knowledge.md`](docs/architecture/recruiting-knowledge.md) |
| Answering a candidate outside working hours, the reply guard, the SMS transcript | [`docs/architecture/recruiting-after-hours.md`](docs/architecture/recruiting-after-hours.md) |
| The Finance Monitor: which group is read, why the captured text is never overwritten, and why a duplicate is recorded and never acted on | [`docs/architecture/finance-monitor.md`](docs/architecture/finance-monitor.md) |
| Retention signals, what may never be scored about a driver, the notice rules | [`docs/architecture/driver-retention.md`](docs/architecture/driver-retention.md) |
| When a recovery is worth announcing, and why a suggestion can never apply itself | [`docs/architecture/self-healing-and-learning.md`](docs/architecture/self-healing-and-learning.md) |
| Database changes, migrations, deferred schema decisions | [`docs/database/`](docs/database/) |
| What was deliberately removed and must not be resurrected | [`docs/ARCHIVED_FEATURES.md`](docs/ARCHIVED_FEATURES.md), [`docs/architecture/retired-*.md`](docs/architecture/) |
| The Dispatch Center's removal, and the ETA schedules that outlived it | [`docs/architecture/retired-dispatch-center.md`](docs/architecture/retired-dispatch-center.md) |
| Clearing a removed feature's leftover tables, roles and accounts | [`docs/architecture/retired-trailers-qbq-sos.md`](docs/architecture/retired-trailers-qbq-sos.md) |
| Module ownership map | [`docs/architecture/module-map.md`](docs/architecture/module-map.md) |
| Deployment checks | [`docs/deployment/pre-deploy-checklist.md`](docs/deployment/pre-deploy-checklist.md) |
| A feature designed but deliberately NOT built | [`docs/future/`](docs/future/) |

The highest-consequence invariants are summarized in `APP_BRIEF.md` §9. The
linked documents hold the full rules and the tests that guard them.
