-- Migration 0093: a truck is (fleet, number, OWNER, seat); the truck's fleet is not the driver's type
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- THE OWNER'S DECISIONS OF 5 NOVEMBER 2026.
--
--   1. On the Dispatcher Board the name after a number is the truck's OWNER:
--      "1 ERNST", "1 ROGER" and "1 RUDOLPH" are three trucks, four owners each
--      have an "001". Migration 0047 named a truck (fleet_type, unit_number,
--      seat), so those were one truck and only one driver could hold it. The
--      owner joins the name: `driver_units.truck_owner`, NULL for a truck with
--      no owner in its label (a company, lease or lease-to-own truck).
--
--   2. "By the truck an owner-operator, by the driver a company driver": a
--      driver hired by an owner. The profile keeps the DRIVER's type in
--      `driver_type` and may now record the TRUCK's fleet and owner beside it
--      (`truck_fleet`, `truck_owner`), copied from the board
--      (`identity.truck_from_board`). Where they are NULL, nothing changes: the
--      driver's type stands in for the truck's, as before.
--
-- THE INDEX SWAP IS SAFE BY CONSTRUCTION. Every set of rows unique on
-- (fleet_type, unit_number, seat) is also unique on (fleet_type, unit_number,
-- owner, seat) — the new index only ADMITS more — so it is built first and the
-- old one dropped after, with no collision to prove.

ALTER TABLE driver_units ADD COLUMN IF NOT EXISTS truck_owner TEXT;

ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS truck_fleet TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS truck_owner TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS truck_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS truck_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_units_truck_owner_not_blank') THEN
    ALTER TABLE driver_units ADD CONSTRAINT driver_units_truck_owner_not_blank
      CHECK (truck_owner IS NULL OR btrim(truck_owner) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_profiles_truck_fleet_check') THEN
    ALTER TABLE driver_profiles ADD CONSTRAINT driver_profiles_truck_fleet_check
      CHECK (truck_fleet IS NULL OR truck_fleet IN ('company', 'owner_operator', 'lease'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_profiles_truck_owner_not_blank') THEN
    ALTER TABLE driver_profiles ADD CONSTRAINT driver_profiles_truck_owner_not_blank
      CHECK (truck_owner IS NULL OR btrim(truck_owner) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_profiles_truck_source_check') THEN
    ALTER TABLE driver_profiles ADD CONSTRAINT driver_profiles_truck_source_check
      CHECK (truck_source IS NULL OR truck_source IN ('board', 'manual'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_units_open_truck
  ON driver_units (fleet_type, unit_number, (COALESCE(truck_owner, '')), seat) WHERE ended_at IS NULL;
DROP INDEX IF EXISTS uniq_driver_units_open_fleet_unit_seat;

-- The owner's instruction of 5 November 2026: Wenze copies the truck from the
-- board when the board's driver and the chat's driver are the same person on
-- the same number. A check with no row here is disabled (default deny).
-- ON CONFLICT DO NOTHING: a row a person already saved is theirs.
--
-- CAP 60, MEASURED. A check wanting more than its cap applies NOTHING, so a cap
-- below the first pass stalls the owner's decision on its first day. Production
-- on 5 November 2026: of 104 present board lines, 46 name an owner; the chats on
-- the same number as a board line whose truck the profile does not already name
-- number at most 54 (38 owners' trucks, 8 hired drivers in an owner's truck, 8
-- company lines sharing a number with an owner's chat — most of which the name
-- rule drops). 60 holds that once; a pass wanting more than every owner's truck
-- plus every hired driver on the board has found a bug, not a fleet.
INSERT INTO operational_check_settings (check_key, auto_apply_enabled, mode, max_auto_per_run, updated_by, updated_at)
VALUES ('identity.truck_from_board', TRUE, 'autopilot', 60, 'migration 0093 (owner decision, 2026-11-05)', NOW())
ON CONFLICT (check_key) DO NOTHING;

-- THE TRUCK ROW FOLLOWS. Every profile this fills is then one
-- `identity.unit_fleet_behind_profile` finding (the truck record gains the
-- owner), so the same first pass reaches that check, whose 0092 cap of 20 would
-- stop it outright. Raised to the same measured 60 — ONLY while the row is
-- still exactly what 0092 wrote: a cap or switch a person has saved since is
-- theirs, and a missing row is not created here.
UPDATE operational_check_settings
   SET max_auto_per_run = 60,
       updated_by = 'migration 0093 (measured first pass, 2026-11-05)',
       updated_at = NOW()
 WHERE check_key = 'identity.unit_fleet_behind_profile'
   AND updated_by = 'migration 0092 (owner decision, 2026-11-05)'
   AND max_auto_per_run = 20;
