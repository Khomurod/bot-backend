# Migration Notes

## How schema changes are applied

The database is managed by a lightweight, versioned migration system in
[`database/migrate/`](../../database/migrate/). There are two layers, both
applied by `database/db.js → initializeDatabase()` on every boot:

1. **Baseline** — [`database/schema.sql`](../../database/schema.sql), applied
   verbatim in a single transaction. This is the accumulated, **additive,
   idempotent** schema (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN
   IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, guarded `DO $$` blocks, seed
   `INSERT … ON CONFLICT`, marker-guarded backfills). It re-runs safely on every
   boot and self-heals seed rows. `schema.sql` is a **generated** artifact,
   assembled from the per-domain segment files in
   [`database/baseline/`](../../database/baseline/) by
   [`scripts/build-schema.js`](../../scripts/build-schema.js).

2. **Forward migrations** — versioned, **run-once** `.sql` files in
   [`database/migrations/`](../../database/migrations/). The runner records each
   in the `schema_migrations` ledger and never re-runs it. This is where **all
   new** schema/seed/backfill changes go.

```
initializeDatabase()
  ├─ apply database/schema.sql            (baseline; one transaction; every boot)
  └─ runMigrations()
       ├─ ensure schema_migrations ledger
       ├─ refresh baseline sentinel row
       └─ apply each pending database/migrations/NNNN_*.sql
            (in version order, each in its own transaction, then recorded)
```

The `schema_migrations` ledger is created and owned by the runner (not by
`schema.sql`), so the baseline file and the tests that apply it carry no
migration bookkeeping. The table is additive and safe on the database shared
with `samsara-integration`.

### To change the schema (going forward)

```bash
npm run migrate:new -- add_widget_flags        # scaffold database/migrations/NNNN_add_widget_flags.sql
# edit the generated file (keep it additive + idempotent)
npm run migrate                                # apply baseline + pending migrations
npm run migrate:status                         # show ledger state
npm run db:docs                                # regenerate docs, then commit
```

Directives inside a migration file:

- `-- migrate:kind: schema|seed|backfill` — records intent in the ledger.
- `-- migrate:no-transaction` — apply outside a transaction (for
  `CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`, …). Must be internally
  idempotent — a mid-way failure leaves it unrecorded and it retries next boot.

Editing an already-applied migration is an error: the runner logs a
**checksum-drift** warning and does **not** re-execute it. Add a new migration
instead. See [`database/migrations/README.md`](../../database/migrations/README.md).

### To change the baseline (rare — maintenance only)

Edit the relevant segment in `database/baseline/`, then run
`npm run build:schema` and commit the regenerated `database/schema.sql`. A test
(`tests/schemaBaselineBuild.test.js`) fails if the two drift. Do **not**
hand-edit `database/schema.sql`. See
[`database/baseline/README.md`](../../database/baseline/README.md). Baseline
edits are reserved for squashing shipped forward migrations or reorganizing
segments — day-to-day changes are forward migrations.

### Invariants (unchanged)

- Everything the app applies on boot stays additive and idempotent; no
  destructive `DROP`/`ALTER … DROP` without an explicit backup and approval
  (`CLAUDE.md`). New columns nullable or defaulted.
- Pushing this repo can auto-deploy — review the full diff before pushing.
- The `samsara-integration` service shares the database. It creates its own
  `samsara_*` tables (and mirrors `safety_event_video_jobs`) with
  `CREATE TABLE IF NOT EXISTS` in `src/db.js → initPgDb()`. `bot-backend` remains
  the canonical owner of `safety_event_*` (music/settings) tables.

## Deferred / opt-in improvements

These are the standing conclusions of a 2026-07 structural schema audit. The
audit report itself has been retired; the decisions that outlived it are here.

- **`database/optional-index-improvements.sql`** — operator-reviewed, additive
  FK indexes (safe) plus commented redundant-index drops (reversible). Run
  manually after reviewing index usage; it is **not** part of `schema.sql`.
  (A good candidate to convert into a forward migration once reviewed.)
- **Timestamp standardization (`timestamp` → `timestamptz`)** — DEFERRED, and
  deliberately so: the conversion **reinterprets** every stored value, because
  `ALTER COLUMN … TYPE timestamptz USING col AT TIME ZONE 'UTC'` assumes the
  naive values are UTC. The app writes `NOW()`/`new Date()` on a UTC server, so
  that is *likely* true — **verify per column before converting**. Do it
  table-by-table in a maintenance window with a backup:

  ```sql
  -- Verify the column's values really are UTC first, then, in a transaction:
  ALTER TABLE drivers
    ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
  ```

### Two findings that are NOT bugs — do not "fix" them

- **`driver_road_history` has two indexes on `home_arrived_at`** (`…_bonus`,
  `…_unposted`). They are **partial indexes with different `WHERE` clauses**, so
  both earn their keep. They are not redundant duplicates; leave them.
- **A few Telegram ids are stored as `text`, on purpose**:
  `message_group_settings.{dispatch_review_group_id, mileage_bonus_group_id,
  road_bonus_group_id}` and `raise_rounds.employee_chat_id`. Those fields are
  admin-editable, allow blanks, and fall back to env vars, so `text` avoids
  cast/empty-string friction. Everywhere else a Telegram id is `bigint`. If this
  is ever normalized, validate that every stored value parses to `bigint` first.

## Rollback guidance

- The baseline and forward migrations are additive, so reverting the code does
  **not** drop already-created objects. To roll back a specific change, write a
  new, reviewed migration (or manual `DROP`/`ALTER`) with a backup first.
- A forward migration that has not yet been applied anywhere can simply be
  deleted before it ships. Once applied in production it is immutable — supersede
  it with a new migration.

## Before any destructive DB change — backup command

Take a schema+data backup first (replace the URL; **never commit it**):

```bash
pg_dump "$DATABASE_URL" --no-owner --no-privileges -Fc -f backup-$(date +%Y%m%d-%H%M%S).dump
# restore:  pg_restore --no-owner --dbname "$DATABASE_URL" backup-XXProxy.dump
```
