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

- **Route Control** (`services/routeControlService.js`): destination
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
