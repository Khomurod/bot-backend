-- ─── Retired: fuel monitoring ──────────────────────────────────────────────
-- This segment used to create fuel_stop_alerts and fuel_monitor_inbox (truck_fuel_readings came from
-- migration 0038, which runs once).
-- Every fuel feature was removed (October 2026, see docs/architecture/retired-fuel.md). The baseline no longer creates them:
-- it is applied on EVERY boot, so a table it created could never be dropped for
-- good. A deployed database keeps its tables and rows until an administrator
-- drops them from Settings → Retired feature leftovers, after a backup.
--
-- The segment file stays, empty of tables, because segments are numbered
-- contiguously (tests/schemaBaselineBuild.test.js).
--
-- ONE STUB, ON A BRAND-NEW DATABASE ONLY: migration 0026 adds and fills
-- `fuel_stop_alerts.person_id` by `group_id`. See 010_dispatch_teams.sql.
DO $$
BEGIN
  -- FRESH DATABASE ONLY: the migration ledger does not exist until the first
  -- boot's migrations run, so this never fires on a deployed database.
  IF to_regclass('public.schema_migrations') IS NULL THEN
    CREATE TABLE IF NOT EXISTS fuel_stop_alerts (
      id SERIAL PRIMARY KEY,
      group_id INTEGER
    );
  END IF;
END $$;
