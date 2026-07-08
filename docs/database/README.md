# Database Documentation

This directory is the **durable, in-repo documentation of the PostgreSQL
database** shared by the two services in this system:

- **`bot-backend`** (this repo) — the Telegram bot, Express API, admin panel,
  and scheduled jobs. It **owns the canonical schema** in
  [`database/schema.sql`](../../database/schema.sql), which is applied
  idempotently on every boot by `database/db.js → initializeDatabase()`.
- **`samsara-integration`** — a standalone Samsara → Telegram poller that
  **shares the same `DATABASE_URL`**. It reads the `groups` table for routing
  and owns a handful of `samsara_*` tables plus writes `safety_event_video_jobs`.

## Files

| File | What it is | Hand-edit? |
|---|---|---|
| `schema-current.md` | Per-table reference: columns, keys, indexes, constraints, purpose, lifecycle status. **Generated.** | ❌ regenerate |
| `schema-current.sql` | Structural SQL snapshot rebuilt from the live catalog (CREATE TABLE + constraints + indexes, **no row data**). **Generated.** | ❌ regenerate |
| `relationships.md` | The foreign-key graph (child → parent). **Generated.** | ❌ regenerate |
| `table-metadata.json` | Human-authored context (purpose / lifecycle status / owning service / data-safety notes) merged into `schema-current.md`. | ✅ edit this |
| `migration-notes.md` | How schema changes are applied + notes for this and future migrations. | ✅ edit this |
| `audit-report.md` | Point-in-time schema audit: findings, severity, safe vs deferred fixes. | ✅ edit this |

## How to refresh the docs

```bash
# Introspects the LIVE database and rewrites the generated files above.
DATABASE_URL='postgresql://…' npm run db:docs
```

The generator (`scripts/generate-db-docs.js`) is **read-only** — it runs only
`SELECT`s against the system catalogs. It **never prints or stores the
`DATABASE_URL`** (only a masked host), and **never reads or emits row
contents** — structure only, so the output is deterministic and leaks nothing
about the data or its scale.

If `DATABASE_URL` is not set the command fails with a clear message. For a
limited, best-effort render straight from `database/schema.sql` (clearly marked
as *not* live-introspected), use:

```bash
npm run db:docs:from-schema
```

## When to run it

**Every pull request that changes the schema must also run `npm run db:docs`
and commit the regenerated files.** "Changes the schema" means any edit to
`database/schema.sql`, any new `CREATE TABLE`/`ALTER TABLE`, or any new table
created by the `samsara-integration` service.

Also update `table-metadata.json` when you **add** a table (give it a purpose +
owning service) or **retire** one (set `status` to `legacy`/`retired` and add a
note).

## Lifecycle status legend

| Badge | Meaning |
|---|---|
| 🟢 active | In active use; safe to rely on. |
| 🟡 legacy | Still present, tied to an old/soft-retired feature; verify before removing. |
| 🔴 retired | Kept only so old data isn't lost; not written by current code. |
| 🔵 historical | Append-only history/audit data. |

## Data-safety reminders

Some tables must **never** be "cleaned up" with `DELETE`:

- **`groups`** — referenced by ~30 foreign keys. Deactivate (`active=false`),
  never delete; a delete cascades to chat logs, members, driver profiles, etc.
- **`drivers` / `driver_profiles`** — contain driver PII.
- **`safety_event_music_assets`** — the BYTEA is the only copy of the uploaded
  music; the app refuses to hard-delete the *active* asset (deactivate first).

See each table's **⚠️ Data-safety note** in `schema-current.md`.
