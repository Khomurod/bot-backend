-- ─── Retired: Google Maps settings and Route Control ──────────────────────────────────────────────
-- This segment used to create gmaps_settings, route_assignments, route_assignment_attachments and
-- route_monitor_events.
-- Route Control and its Settings → GMaps tab were removed (October 2026, see docs/architecture/retired-route-control.md). The baseline no longer creates them:
-- it is applied on EVERY boot, so a table it created could never be dropped for
-- good. A deployed database keeps its tables and rows until an administrator
-- drops them from Settings → Retired feature leftovers, after a backup.
--
-- `duplicate_unit_reports`, at the end of this segment, belongs to the
-- duplicate-unit scan, which is still running; it stays exactly as it was.
--
-- ONE STUB, ON A BRAND-NEW DATABASE ONLY: migration 0026 adds and fills
-- `route_assignments.person_id` by `group_id`. See 010_dispatch_teams.sql.
DO $$
BEGIN
  -- FRESH DATABASE ONLY: the migration ledger does not exist until the first
  -- boot's migrations run, so this never fires on a deployed database.
  IF to_regclass('public.schema_migrations') IS NULL THEN
    CREATE TABLE IF NOT EXISTS route_assignments (
      id SERIAL PRIMARY KEY,
      group_id INTEGER
    );
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Duplicate unit-number reports (Samsara / provider ↔ driver-group mismatches).
--
-- When two active driver groups carry the same truck/unit number, or a provider
-- vehicle label lists a different driver than the group it is matched to, the bot
-- can pick the wrong truck in /location and live tracking. A 15-minute sanity
-- check records these situations here for admin review instead of guessing. Rows
-- are keyed by (unit_number, report_type) and reopened/refreshed each run; issues
-- that disappear are auto-resolved.
CREATE TABLE IF NOT EXISTS duplicate_unit_reports (
  id SERIAL PRIMARY KEY,
  unit_number TEXT NOT NULL,
  -- duplicate_unit  = same unit across >1 active driver group
  -- name_mismatch   = provider vehicle label's driver ≠ the group's driver
  -- ambiguous_match = duplicate unit AND no confident driver-name winner
  report_type TEXT NOT NULL CHECK (report_type IN ('duplicate_unit', 'name_mismatch', 'ambiguous_match')),
  group_ids INTEGER[] NOT NULL DEFAULT '{}',
  group_names TEXT[] NOT NULL DEFAULT '{}',
  group_driver_name TEXT,
  provider TEXT,
  provider_driver_name TEXT,
  detail TEXT,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'serious')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  UNIQUE (unit_number, report_type)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_unit_reports_open
  ON duplicate_unit_reports(status, last_seen_at DESC) WHERE status = 'open';
