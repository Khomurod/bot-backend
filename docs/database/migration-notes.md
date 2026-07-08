# Migration Notes

## How schema changes are applied (no migration framework)

This app has **no migration runner**. The single source of truth is
[`database/schema.sql`](../../database/schema.sql), which `database/db.js →
initializeDatabase()` executes **verbatim on every boot**. The file is written to
be **idempotent**:

- `CREATE TABLE IF NOT EXISTS …`
- `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`
- `CREATE INDEX IF NOT EXISTS …`
- seed rows via `INSERT … ON CONFLICT DO NOTHING`

**To change the schema:** edit `schema.sql` (keep every statement idempotent),
deploy, and the change is applied on the next boot. Then run `npm run db:docs`
and commit the regenerated docs.

The `samsara-integration` service shares the same database. It creates its own
`samsara_*` tables (and mirrors `safety_event_video_jobs`) with
`CREATE TABLE IF NOT EXISTS` in `src/db.js → initPgDb()`. `bot-backend` remains
the canonical owner of `safety_event_*` (music/settings) tables.

## Changes in this feature (driver-group speeding-video music overlay)

Added to `schema.sql` (all additive; no existing object altered/dropped):

| Object | Type | Notes |
|---|---|---|
| `safety_event_music_assets` | table | Uploaded music clips; bytes in `file_data BYTEA` (`storage_kind='db_bytea'`). Partial unique index `uniq_safety_event_music_active` enforces ≤1 active clip. |
| `safety_event_video_settings` | table | Single row (`id=1`) of overlay settings; seeded via `ON CONFLICT DO NOTHING`. |
| `safety_event_video_jobs` | table | Best-effort overlay-job ledger (also created by samsara `initPgDb`). |
| `idx_safety_event_music_created`, `idx_safety_event_video_jobs_event`, `idx_safety_event_video_jobs_status_created` | indexes | Supporting indexes. |

These were validated by loading `schema.sql` into a clean PostgreSQL 16 instance
(0 errors) and re-applying it (idempotent — only benign "already exists"
notices).

## Deferred / opt-in improvements (see `audit-report.md`)

- **`database/optional-index-improvements.sql`** — operator-reviewed, additive
  FK indexes (safe) plus commented redundant-index drops (reversible). Run
  manually after reviewing index usage; it is **not** part of `schema.sql`.
- **Timestamp standardization (`timestamp` → `timestamptz`)** — DEFERRED, since
  it reinterprets stored values. Do it per-column in a maintenance window with a
  backup; see the audit report for the exact `ALTER` form and rollback.

## Rollback guidance

- New tables: `DROP TABLE IF EXISTS safety_event_video_jobs,
  safety_event_video_settings, safety_event_music_assets CASCADE;` (destroys the
  stored music — export first if needed). Because everything is `IF NOT EXISTS`,
  simply reverting `schema.sql` will not drop already-created tables; drop them
  explicitly if you need to roll back.
- Opt-in indexes: `DROP INDEX IF EXISTS <name>;` (all listed in the opt-in file).

## Before any destructive DB change — backup command

Take a schema+data backup first (replace the URL; **never commit it**):

```bash
pg_dump "$DATABASE_URL" --no-owner --no-privileges -Fc -f backup-$(date +%Y%m%d-%H%M%S).dump
# restore:  pg_restore --no-owner --dbname "$DATABASE_URL" backup-XXProxy.dump
```
