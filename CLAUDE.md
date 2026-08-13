# CLAUDE.md

Guidance for AI-assisted work (Claude Code and similar agents) in this repository.

# Start with the App Brief

**[`APP_BRIEF.md`](APP_BRIEF.md) is the central brief for this application — read
it before any task.** It covers what the app is for, who uses it, the features
and workflows, permissions, integrations, background jobs, cross-feature
dependencies, and the decisions that must not be broken. This file (CLAUDE.md)
holds the working rules and the detailed per-feature invariants; the brief holds
the understanding you need to apply them.

**The brief is a living document.** After completing any meaningful change —
feature, fix, removal, behavioral/integration/workflow/permission/schema change —
re-read it and update whatever your work made untrue, **as part of the same
task**. A task is not complete while the brief and the application disagree. The
maintenance rule is stated in full at the top of `APP_BRIEF.md`.

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
  backup. Schema changes must be additive and idempotent. The database is
  managed by the migration system in `database/migrate/`:
  `initializeDatabase()` applies the baseline `database/schema.sql` (GENERATED
  from `database/baseline/*.sql` via `npm run build:schema`; runs verbatim on
  every boot) and then any pending, run-once forward migrations in
  `database/migrations/` (tracked in the `schema_migrations` ledger). Put NEW
  changes in a forward migration (`npm run migrate:new -- <name>`); do not
  hand-edit `database/schema.sql`. See `docs/database/migration-notes.md`.
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

  **Telegram screenshot transport is a permanent invariant — do not regress it:**

  - Route Control must send screenshots to Telegram as short-lived, HMAC-signed
    HTTPS URLs produced by
    `services/routeControl/screenshotMediaReference.js`. This applies to both
    `editMessageMedia` for existing messages and `sendPhoto` for new messages.
  - Never change these calls back to raw `Buffer`/`{ source: file_data }` input,
    multipart upload, or another implementation that uploads screenshot bytes
    directly from Render to `api.telegram.org`. That production path repeatedly
    stalled without a Telegram response even though the browser upload and
    database storage had succeeded.
  - Telegram must fetch the bytes through
    `/api/route-screenshot-media/:id`. That endpoint must remain protected by a
    short expiry, HMAC signature, assignment binding, and screenshot-content
    version binding. It must not expose a permanent or unsigned public image
    URL, and signed URLs or query strings must never be logged.
  - Replacing a screenshot must invalidate URLs for the previous image. Admin
    previews remain authenticated separately.
  - Existing text-only Telegram messages must continue to be converted in place
    with `editMessageMedia` using the same stored chat ID and message ID; never
    silently post a replacement message.
  - Before changing this workflow, run and preserve:
    `tests/telegramUrlMediaTransport.test.js`,
    `tests/routeScreenshotMediaReference.test.js`,
    `tests/routeScreenshotMediaRoutes.test.js`, Route Control edit/delivery
    tests, and Admin screenshot-status tests. The transport test must continue
    proving that real Telegraf requests use `application/json`, not multipart.

- **Trailer master list** (`database/trailerMasterList/`, `services/trailerMasterList/`):
  `trailers` is the single authoritative master list.

  **No code path may create a trailer from a detection — this is a permanent
  invariant:**

  - A trailer may join the list ONLY through an approved master-list import or
    explicit, permission-gated manual creation. A Telegram message or an AI
    detection must NEVER create one. `ensureTrailerForDetection` RESOLVES ONLY
    (exact unit number, then active alias, following `merged_into_trailer_id` to
    the survivor) and returns null for an unknown unit; callers must then queue a
    `trailer_unmatched_mentions` review record, never insert a trailer.
  - Enforcement lives in the DATA ACCESS LAYER, not only in routes:
    `upsertTrailerByUnitNumber` throws `TRAILER_NOT_IN_MASTER_LIST` for any
    source other than `admin_manual`. Approved-import trailers are created ONLY
    inside the reconciliation transaction (`reconciliation.js` `createApproved`,
    direct INSERT). The legacy screenshot importer (`trailerImportService.js`
    `commitRows` and `POST /api/trailers/import/:batchId/commit`) is DISABLED —
    it returned official trailers with no reconciliation. Do not re-enable a
    second import authority; route image imports through the master-list flow.
    Guarded by `tests/trailerLegacyImportGuard.test.js`.
  - "Official" means `active AND master_status = 'active'`. `active` keeps its
    legacy soft-delete meaning and is deliberately NOT mirrored from
    `master_status`; both must hold. Pending-review, archived and merged trailers
    keep ALL their history but must never appear on a map, in a default list, or
    in a rental picker.
  - Archive and merge NEVER delete: a merge reassigns every history table to the
    survivor and keeps both identifiers resolving as aliases. A trailer with an
    open rental cannot be archived or merged.
  - Master-list imports STAGE only. Reconciliation applies approved decisions in
    ONE transaction; a failure rolls back every master-list change and leaves the
    staged import intact.
  - Before changing this, run and preserve: `tests/trailerAutoCreationGuard.test.js`
    (its static scan fails if a new `INSERT INTO trailers` site appears — update
    `KNOWN_CREATION_SITES` only deliberately), `tests/trailerMasterListPg.test.js`,
    `tests/trailerMasterListReconcile.test.js`.

- **Trailer Department file storage** (`services/trailerStorage/`, reached through
  the `services/trailerStorageService.js` re-export-only façade): uploads must
  work with NO Supabase bucket configured.

  - Requiring Supabase was a production outage: every upload threw 503, so the
    required pickup photo never stored, so "Confirm Pickup and Activate" failed.
    Never reintroduce a hard Supabase dependency on the upload path.
  - Backend selection is automatic: Supabase when fully configured, otherwise
    `database` (bytes in `trailer_media_blobs`). Reads follow `storage_backend`
    recorded ON THE ROW, never the current configuration, so files written before
    Supabase is configured keep working after it is.
  - Bytes live in `trailer_media_blobs`, separate from `trailer_media` metadata:
    never select BYTEA in a list query.
  - Telegram fetches media via short-lived HMAC-signed URLs
    (`/api/trailer-media/:id`) — same invariant as Route Control screenshots.
    Never a permanent or unsigned public URL; never log a signed URL or query
    string. The variant (original/preview) is part of the signature.
  - Inspections complete ONLY through `completeInspection()`, which verifies the
    required photo's metadata AND bytes inside a transaction. `saveInspection()`
    always writes a draft and ignores `completed`, so a failed upload can never
    leave a completed inspection.
  - Before changing this, run and preserve: `tests/trailerStoragePg.test.js`,
    `tests/trailerStorageFallback.test.js`, `tests/trailerMediaRoutes.test.js`,
    `tests/trailerInspectionAtomicityPg.test.js`.

- **Multi-trailer rental agreements** (`database/trailerAgreements/`,
  `services/trailerAgreements/`, `services/trailerPricing/`, reached through
  `server/routes/trailerAgreementRoutes.js` at `/api/trailer-agreements`):
  one company can rent many trailers under one agreement, each trailer an
  independent `trailer_rental_items` row with its own pickup/return/pricing.

  - `trailer_rental_agreements` is the header; `trailer_rental_items` is one
    row per trailer. Agreement status is DERIVED from item statuses by the pure
    `services/trailerAgreements/statusDerivation.js` — never set directly — and
    re-derived inside the SAME transaction as every item change.
  - History is AMENDMENT-BASED: add/remove/replace/rate/amount/extend changes
    append an immutable `trailer_rental_amendments` row. There is no amendment
    UPDATE path.
  - Availability is enforced by the DB: an EXCLUDE-gist overlap constraint
    (`trailer_rental_items_no_overlap`) and a partial unique "one active item per
    trailer". Only official trailers (`active AND master_status='active'`) may be
    added.
  - Invoicing writes `trailer_invoice_lines` (immutable once finalized;
    corrections via adjustments/credits) AND maintains the legacy
    `trailer_invoices` column totals as a denormalized sum, so every existing
    reader keeps working. Combined = one invoice for all items; separate = one
    per item.
  - LEGACY BACKFILL is production-critical and idempotent: `schema.sql` creates
    one agreement + one item per existing `trailer_rentals` row, guarded by
    `legacy_rental_id` (INSERT-only, fill-NULLs-only), and connects existing
    invoices/inspections/movements/media. Re-running on every boot is a strict
    no-op. The old `trailer_rentals` table and `/rentals/*` endpoints stay fully
    functional — nothing is dropped.
  - Before changing this, run and preserve: `tests/trailerAgreementsPg.test.js`,
    `tests/trailerAgreementStatus.test.js`, `tests/trailerPricing.test.js`.

- **Trailer Department safety invariants** (Phase 6 hardening):
  - USER SCOPING (`server/routes/adminUserScope.js`): a Trailer Manager
    (`trailer_users.manage` WITHOUT `users.manage`) sees and edits ONLY accounts
    whose roles are all `trailer_`-prefixed. Out-of-scope accounts return 404
    (never 403) so their existence cannot be inferred. The last active super
    administrator cannot be deactivated or demoted.
  - OVERPAYMENTS (`database/trailerFinance.js`, `database/trailerCredits.js`): a
    payment above the outstanding balance is REJECTED unless the caller holds
    `trailer_payments.record_overpayment` AND confirms; the excess is then banked
    as a `trailer_company_credits` row and applied later through an audited
    ledger. Never silently swallow an overpayment.
  - SNOOZED REMINDERS (`database/trailerNotifications.js`): `resumeExpiredSnoozes`
    restores `reminder_state='snoozed'` invoices whose `snoozed_until<=NOW()` to
    active BEFORE reminders are enqueued, so an expired snooze always resumes.
  - GRACE PERIOD: `due_at` is the payment deadline ONLY; grace is applied exactly
    once, at reminder time. Never bake grace into `due_at`.
  - OPTIMISTIC LOCKING: trailers, agreements, items, companies and invoices carry
    a `version` column. A write bumps it; a caller that sends a stale version gets
    HTTP 409, never a silent overwrite.
  - AI EVENT LINKING (`linkTrailerEventToRental`): links to a SPECIFIC validated
    movement, never "the newest one"; refuses to relink an already-linked event
    or steal a movement already linked elsewhere.
  - AUDIT REDACTION (`database/trailerAudit.js` `redact`): recursively strips
    passwords, hashes, tokens, secrets and signed-URL material at any depth.
  - Before changing these, run and preserve: `tests/adminUserScope.test.js`,
    `tests/trailerOverpaymentPg.test.js`, `tests/trailerReminderResumePg.test.js`,
    `tests/trailerEventLinkPg.test.js`, `tests/trailerAuditRedact.test.js`.

# PostgreSQL integration tests

`*Pg.test.js` need `TEST_DATABASE_URL` and SKIP without it — a skipped test is
not a passing test. The harness (`tests/helpers/trailerPgHarness.js`) creates a
throwaway DATABASE per test and applies the real, complete `schema.sql` into it.

- **Per-database, not per-schema, and not stubbed tables.** `schema.sql` contains
  guards that check `pg_constraint` / `information_schema` by constraint NAME
  with no schema filter; several schemas in one database make them see each
  other's constraints and misfire. One database per test mirrors production.
- The database must be **UTF8** (`TEMPLATE template0`) — `schema.sql` contains
  box-drawing characters in comments.
