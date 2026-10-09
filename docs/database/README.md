# Database Documentation

This directory is the **durable, in-repo documentation of the PostgreSQL
database** shared by the two services in this system:

- **`bot-backend`** (this repo) — the Telegram bot, Express API, admin panel,
  and scheduled jobs. It **owns the canonical schema**, managed by the migration
  system in [`database/migrate/`](../../database/migrate/): `database/db.js →
  initializeDatabase()` applies the idempotent baseline
  [`database/schema.sql`](../../database/schema.sql) (GENERATED from
  [`database/baseline/*.sql`](../../database/baseline/)) and then any pending,
  run-once forward migrations in
  [`database/migrations/`](../../database/migrations/). See
  [`migration-notes.md`](migration-notes.md).
- **`samsara-integration`** — a standalone Samsara → Telegram poller that
  **shares the same `DATABASE_URL`**. It reads the `groups` table for routing
  and owns a handful of `samsara_*` tables plus writes `safety_event_video_jobs`.

## The authoritative schema

**The schema is defined by the repository, not by a document in this folder:**

1. `database/baseline/*.sql` — the source segments you edit.
2. `database/schema.sql` — **generated** from those segments by
   `npm run build:schema`, applied verbatim on every boot. Never hand-edit it.
   `npm run build:schema:check` fails CI if it drifts from the baseline.
3. `database/migrations/` — run-once forward migrations for new changes
   (`npm run migrate:new -- <name>`), tracked in the `schema_migrations` ledger.

Read those when you need to know the real shape of a table. Nothing in this
folder overrides them.

## Files

| File | What it is | Hand-edit? |
|---|---|---|
| `table-metadata.json` | Human-authored context (purpose / lifecycle status / owning service / data-safety notes) for the notable tables. | ✅ edit this |
| `migration-notes.md` | How schema changes are applied, plus the standing deferred/opt-in schema decisions. | ✅ edit this |

## Generating a database reference on demand

`scripts/generate-db-docs.js` (`npm run db:docs`) introspects a live database and
renders a per-table reference, a structural SQL snapshot and the foreign-key
graph, merging in the curated context from `table-metadata.json`.

```bash
DATABASE_URL='postgresql://…' npm run db:docs   # needs a reachable database
npm run db:docs:from-schema                     # limited render from schema.sql
```

The generator is **read-only** — it runs only `SELECT`s against the system
catalogs. It **never prints or stores the `DATABASE_URL`** (only a masked host)
and **never reads or emits row contents** — structure only, so it leaks nothing
about the data or its scale.

**Its output is deliberately not committed.** Generated snapshots used to live
here (`schema-current.md`, `schema-current.sql`, `relationships.md`) and drifted
badly — they described 76 tables while the baseline had grown well past 100,
because regenerating them needs a live database that CI cannot reach. A file
named *schema-current* that is not current is worse than no file. Generate one
when you need it, read it, and leave it out of git — the three output paths are
listed in the repository `.gitignore`.

Update `table-metadata.json` when you **add** a table (give it a purpose +
owning service) or **retire** one (set `status` to `legacy`/`retired` and add a
note).

## Moving the database to another server

The manual **Copy database** workflow (`.github/workflows/copy-database.yml`,
running `scripts/copy-database.sh`) copies the database into a new, EMPTY one.
It was written for the October 2026 move from a personal Supabase project,
whose monthly transfer allowance was spent, to the company's.

**It runs on GitHub, not in a cloud agent's container.** Those containers reach
the internet only through an HTTPS proxy, and a PostgreSQL connection is not
HTTPS. A GitHub runner connects directly, over IPv4. That is why it needs
Supabase's **Session pooler** address: the direct `db.<ref>.supabase.co` address
is IPv6 only, and the transaction pooler (port 6543) cannot hold one session for
the whole dump. The script switches 6543 to 5432 on its own, and refuses a
direct address.

What it copies is the whole `public` schema:

- every table and its rows;
- the sequences and where they stand;
- indexes, constraints and the view;
- row security and its policies;
- the extensions installed into `public` (`btree_gist`).

That is all of the application's state. The production database had no auth
users, no storage objects and no scheduled jobs, and every other schema there
belongs to Supabase. Grants are not copied, because a Supabase target applies
its own defaults to new tables. Ownership is not copied either: everything ends
up owned by the user the copy connects as, which is the user the applications
connect as.

What it guarantees:

- **The target must be empty.** If `public` holds any table, view or sequence,
  nothing is written. A run can therefore never overwrite a live database, even
  with the two secrets swapped.
- **The write is one transaction.** It lands whole or not at all. A failed run
  leaves the target empty and can simply be run again.
- **It checks its own result**, by comparing source and target:
  - the structure (tables, indexes, constraints, sequences, views, policies);
  - the row count of every table;
  - the position of every sequence.

  Anything written to the source during the copy shows up as a difference.
  Stop every writer first: the main service and the Samsara poller.
- **The log shows nothing private.** The repository and its Actions logs are
  public, so the log carries no rows, no row counts, no sizes and no part of
  either address. Errors are terse, because a failing `COPY` would otherwise
  quote its row.

To use it:

1. Create the new, empty project.
2. Store the two addresses as Actions secrets: `OLD_DATABASE_URL` (the source,
   only read) and `NEW_DATABASE_URL` (the target).
3. Stop every writer.
4. Run **Actions → Copy database → Run workflow** with `confirm` = `COPY`.
5. On success, point `DATABASE_URL` at the new address in **both** Render
   services (the main service and the Samsara poller) and start them again.
6. Delete both secrets.

A target that switches row security on for every new table, as a Supabase
project can, is reported but not refused. Row security does not restrict a
table's owner, and the applications connect as the owner.

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

Each notable table's **data-safety note** and lifecycle status is recorded in
`table-metadata.json`, and is merged into the reference when you generate one.
