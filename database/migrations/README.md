# Forward migrations

Versioned, **run-once**, tracked schema changes. Everything NEW goes here — do
not edit `database/schema.sql` (the baseline) by hand for ongoing changes.

## How it works

On every boot, `database/db.js → initializeDatabase()`:

1. applies the **baseline** (`database/schema.sql`, idempotent, whole-file
   transaction) — this is the accumulated schema, re-applied every boot;
2. calls the migration runner (`database/migrate/`), which ensures the
   `schema_migrations` ledger exists and then applies every file in this
   directory that is **not yet recorded as applied**, in version order, each in
   its own transaction (migration SQL + its ledger row commit together).

An already-applied migration is never re-run. Editing an applied migration is
an error — the runner logs a checksum-drift warning and does NOT re-execute it.
Add a new migration instead.

## Creating a migration

```
npm run migrate:new -- add_widget_flags
# → database/migrations/0001_add_widget_flags.sql
```

Then edit the generated file and apply it (or just boot the app):

```
npm run migrate
```

## File format

- Name: `NNNN_snake_case_description.sql` — `NNNN` is a zero-padded, strictly
  increasing integer that fixes the apply order.
- Directives (SQL line comments):
  - `-- migrate:kind: schema|seed|backfill` — records the change's intent in the
    ledger. Defaults to `schema`.
  - `-- migrate:no-transaction` — apply without a wrapping transaction (needed
    for `CREATE INDEX CONCURRENTLY`, `ALTER TYPE ... ADD VALUE`, etc.). Such a
    migration MUST be internally idempotent, because a mid-way failure leaves it
    unrecorded and it is retried on the next boot.

## Guidelines

- **Keep it additive and safe.** No `DROP`/destructive `ALTER` without an
  explicit backup and approval (see `CLAUDE.md`). New columns nullable or
  defaulted. Pushing this repo can auto-deploy — review the full diff first.
- **Prefer idempotent statements** (`IF NOT EXISTS`, `ON CONFLICT`) even though
  a migration runs once: it makes a no-transaction migration safe to retry and a
  transactional one safe to fold into the baseline later.
- **Backfills** (`-- migrate:kind: backfill`) are one-time data changes — guard
  them so a re-run (e.g. if later squashed into the baseline) is a no-op.
- **Separate concerns**: one logical change per migration.
