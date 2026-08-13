# CLAUDE.md

Working rules for AI-assisted development (Claude Code and similar agents) in
this repository. This file is **how to work here**. It is deliberately short —
what the application *is* lives in the App Brief, and deep per-feature rules live
in the specialized docs linked at the bottom.

# Start with the App Brief

**[`APP_BRIEF.md`](APP_BRIEF.md) is the central brief for this application — read
it before any task.** It covers what the app is for, who uses it, the features
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
  **Repository-specific caution:** pushing a feature branch to this repository
  auto-opens AND auto-merges a PR into `main` within seconds — review the
  complete diff **BEFORE** pushing.

# Testing expectations

```
node --test --test-concurrency=1 tests/*.test.js   # bash glob (PowerShell does not expand it)
npm test                                           # Node suite + Python leads tests
npm run build --prefix admin                       # admin production build
npm test --prefix admin                            # admin component tests
npm run lint:filesize                              # 500-line limit
npm run build:schema:check                         # schema.sql in sync with baseline/
```

- **The Node suite passes clean with no secrets and no database**, so **any
  failure is a real failure.** There is no "expected failures in a bare
  environment" allowance — do not dismiss one that way. (If you see mass
  failures, check that `npm install` has run; a bare clone dies at
  `require('dotenv')`.) The verified baseline is recorded in `APP_BRIEF.md` §11.
- **`*Pg.test.js` need `TEST_DATABASE_URL` and SKIP without it — a skipped test
  is not a passing test.** Say so plainly rather than folding skips into a green
  summary. The harness (`tests/helpers/trailerPgHarness.js`) creates a throwaway
  **database** per test (not a schema — `schema.sql` guards look up constraints
  by name with no schema filter) and applies the real, complete `schema.sql`. The
  database must be **UTF8** (`TEMPLATE template0`), because `schema.sql` contains
  box-drawing characters in comments.
- **CI** (`.github/workflows/ci.yml`) runs static checks + the admin build, the
  Node unit suite with no application env at all, and the PostgreSQL integration
  suite against a real Postgres 16 container. **Both test jobs fail on ANY skip.**
- Prefer the test endpoints over real sends when validating manually (see
  `APP_BRIEF.md` §11).

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
  `services/routeControl/*` is the reference example.

### Checking the limit

```
npm run lint:filesize        # enforce: fails on NEW violations
npm run lint:filesize:list   # list every file currently over the limit
```

Legacy violations that predate this rule are recorded in
`scripts/fileSizeBaseline.json`. That baseline may only ever **shrink**: a file
that is not listed fails the check if it exceeds the limit, a listed file fails
if it grows, and a listed file that drops to/below 500 lines must be removed
from the baseline so the win is locked in. Do not add new entries to the
baseline to work around the rule.

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
- Tests must be reorganized when they become oversized, rather than consolidated
  into giant files.

# Per-feature invariants — read before touching these areas

Each of these features carries hard invariants that were written after a
production incident or a near miss. **Read the linked document before changing
that area**, and run the tests it names.

| Area | Read first |
|---|---|
| Route Control, route screenshots, Telegram media transport | [`docs/architecture/route-control.md`](docs/architecture/route-control.md) |
| Trailer master list, trailer storage, rental agreements, Trailer Department safety rules | [`docs/architecture/trailer-invariants.md`](docs/architecture/trailer-invariants.md) |
| Trailer Department operations (URLs, feature flag, storage config) | [`docs/trailer-department.md`](docs/trailer-department.md) |
| Database changes, migrations, deferred schema decisions | [`docs/database/`](docs/database/) |
| What was deliberately removed and must not be resurrected | [`docs/ARCHIVED_FEATURES.md`](docs/ARCHIVED_FEATURES.md), [`docs/architecture/retired-*.md`](docs/architecture/) |
| Module ownership map | [`docs/architecture/module-map.md`](docs/architecture/module-map.md) |
| Deployment checks | [`docs/deployment/pre-deploy-checklist.md`](docs/deployment/pre-deploy-checklist.md) |

The highest-consequence invariants are summarized in `APP_BRIEF.md` §9. The
linked documents hold the full rules and the tests that guard them.
