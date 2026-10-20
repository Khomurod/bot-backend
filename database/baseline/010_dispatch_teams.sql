-- ─── Retired: dispatch teams ──────────────────────────────────────────────
-- This segment used to create dispatch_teams, dispatch_team_drivers and dispatch_team_members.
-- They belonged to the driver-raise review, which was removed (October 2026, see docs/architecture/retired-driver-raise.md). The baseline no longer creates them:
-- it is applied on EVERY boot, so a table it created could never be dropped for
-- good. A deployed database keeps its tables and rows until an administrator
-- drops them from Settings → Retired feature leftovers, after a backup.
--
-- The segment file stays, empty of tables, because segments are numbered
-- contiguously (tests/schemaBaselineBuild.test.js).
--
-- ONE STUB, ON A BRAND-NEW DATABASE ONLY. Migrations 0026, 0058 and 0062 still
-- alter and update `dispatch_team_drivers`, and migrations are immutable once
-- applied. On a new database they run right after this baseline, so the table
-- has to exist for them — with just the columns they touch. Once the ledger
-- exists (every deployed database) this never runs again, so a drop stays done.
DO $$
BEGIN
  -- FRESH DATABASE ONLY: the migration ledger does not exist until the first
  -- boot's migrations run, so this never fires on a deployed database.
  IF to_regclass('public.schema_migrations') IS NULL THEN
    CREATE TABLE IF NOT EXISTS dispatch_team_drivers (
      id SERIAL PRIMARY KEY,
      group_id INTEGER,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;
