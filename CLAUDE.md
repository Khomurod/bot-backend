# CLAUDE.md

Guidance for AI-assisted work (Claude Code and similar agents) in this repository.

# Mandatory Codebase Memory Workflow

Before beginning ANY coding, debugging, refactoring, audit, database, testing, or
documentation task in this repository:

1. Use `codebase-memory-mcp` to recall the application architecture
   (`get_architecture`, `search_graph`, `trace_path`, `get_code_snippet`).
2. Query it for the specific feature involved in the task.
3. Inspect the current source code AFTER consulting memory — memory may be
   incomplete or stale; the source is the truth.
4. Do not edit files before completing these steps.
5. After meaningful architectural or behavioral changes, update
   codebase-memory-mcp (re-index the repository and/or record an ADR with
   `manage_adr`).
6. Never state that codebase-memory-mcp was used unless it was actually called
   successfully.
7. If codebase-memory-mcp is unavailable, explicitly report that before
   continuing.

# Safety Rules

- Never expose production credentials (Telegram bot tokens, Google API keys,
  database URLs, ELD/RingCentral/Facebook secrets) in code, logs, commits, or
  chat output.
- Never make destructive database changes without explicit approval and a
  backup. Schema changes must be additive and idempotent — `database/schema.sql`
  runs on every boot.
- Never trust old repository memory without checking the current source code.
- Run the relevant tests before claiming success, and report exact test results
  (command, pass/fail counts). Do not claim a test passed unless it was run.
- Do not merge without reviewing the final diff.
  **Repository-specific caution:** pushing a feature branch to this repository
  auto-opens AND auto-merges a PR into `main` within seconds — review the
  complete diff BEFORE pushing.

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

# Tool Usage

- **codebase-memory-mcp** = understands this project. Use its graph tools before
  searching application code. This project is indexed, and automatic indexing
  and watching are enabled.
- **Context7** = checks the latest instructions. Use it only for current public
  library and API documentation. Never send private source code, passwords,
  tokens, `.env` values, or company information to Context7.
- **Gitleaks** = protects passwords and API keys. Run read-only checks with
  `gitleaks dir . --redact`. Report only the file name, line number, and finding
  type; never print a discovered value or change files automatically.

# Test Commands

```
node --test --test-concurrency=1 tests/*.test.js   # bash glob (PowerShell does not expand it)
npm run build --prefix admin
```

Some test files require environment/database access and fail in a bare local
environment — compare against `main` before attributing failures to a change.

# Key Feature Notes

- **Route Control** (`services/routeControl/`, reached through the
  `services/routeControlService.js` compatibility façade — that façade is
  re-export only; add new code to a focused module in the package and export it
  from `services/routeControl/index.js`): destination
  auto-completion (default 50 mi — single authoritative constant in
  `services/routeControlConstants.js`) runs for EVERY lifecycle-active route,
  including tracking-pending ones, and does NOT require Google Maps to be
  enabled. Off-route warnings require Settings → GMaps `enabled` and
  tracking-active. Completion is atomic (`completeRouteAssignment`,
  `WHERE status='active' RETURNING *`) — only the winner writes the audit event.
  The FINAL destination coordinate is taken from the parsed/manual point, and
  when that is address-only it falls back to the END of the computed route
  polyline (never a waypoint); existing routes self-heal from their polyline on
  the next monitor pass, so no admin re-creation is needed.
- **Route screenshots** (`route_assignment_attachments`): one per assignment,
  enforced by a unique index; replacement is a single UPSERT — never
  delete-then-insert.
