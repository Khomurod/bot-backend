-- Migration 0026: operational facts learn WHICH PERSON they are about
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY. Migration 0015 gave Wenze a person above `groups`, and nothing read it.
-- Every road leg, home stay, home-time request, fuel watch, route assignment,
-- dispatch-team seat and mileage snapshot was still keyed on the CHAT (or on a
-- normalised name), so a driver who changed truck — and therefore chat — left
-- their history behind on the old row and started again from zero.
--
-- WHAT. A nullable `person_id` on each of those seven tables, stamped at write
-- time by the data layer from the group's OPEN association (a subquery, so an
-- unpopulated person layer simply yields NULL and nothing else changes), and
-- filled here for the rows that already exist. No foreign key is repointed:
-- `group_id` stays exactly what it was, and `person_id` sits beside it.
--
-- ON DELETE SET NULL, never CASCADE: deleting a person row (which nothing does
-- — a merge is a pointer) must not take a driver's bonus history with it.
--
-- The backfill is guarded by `person_id IS NULL`, so a re-run is a no-op, and
-- it only fills from an OPEN association — a group's whole history goes to
-- whoever holds the group today. That is the honest answer for a fleet where a
-- chat has had one occupant; the identity resolver closes and reopens
-- associations from here on, so future rows are stamped for the right person
-- even when a chat is handed on.

ALTER TABLE driver_road_history
  ADD COLUMN IF NOT EXISTS person_id INTEGER NULL REFERENCES driver_people(id) ON DELETE SET NULL;
ALTER TABLE driver_home_status
  ADD COLUMN IF NOT EXISTS person_id INTEGER NULL REFERENCES driver_people(id) ON DELETE SET NULL;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS person_id INTEGER NULL REFERENCES driver_people(id) ON DELETE SET NULL;
ALTER TABLE fuel_stop_alerts
  ADD COLUMN IF NOT EXISTS person_id INTEGER NULL REFERENCES driver_people(id) ON DELETE SET NULL;
ALTER TABLE route_assignments
  ADD COLUMN IF NOT EXISTS person_id INTEGER NULL REFERENCES driver_people(id) ON DELETE SET NULL;
ALTER TABLE dispatch_team_drivers
  ADD COLUMN IF NOT EXISTS person_id INTEGER NULL REFERENCES driver_people(id) ON DELETE SET NULL;
ALTER TABLE mileage_bonus_progress
  ADD COLUMN IF NOT EXISTS person_id INTEGER NULL REFERENCES driver_people(id) ON DELETE SET NULL;

-- The reads that matter are "everything about this person", so each gets an
-- index; partial, because rows without a person are never looked up that way.
CREATE INDEX IF NOT EXISTS idx_driver_road_history_person
  ON driver_road_history (person_id, home_arrived_at DESC) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_driver_home_status_person
  ON driver_home_status (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_home_time_requests_person
  ON home_time_requests (person_id, requested_at DESC) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fuel_stop_alerts_person
  ON fuel_stop_alerts (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_route_assignments_person
  ON route_assignments (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_team_drivers_person
  ON dispatch_team_drivers (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mileage_bonus_progress_person
  ON mileage_bonus_progress (person_id) WHERE person_id IS NOT NULL;

-- ─── Fill from the open associations, once ──────────────────────────────────
UPDATE driver_road_history h
   SET person_id = pg.person_id
  FROM driver_person_groups pg
 WHERE pg.group_id = h.group_id AND pg.ended_at IS NULL AND h.person_id IS NULL;

UPDATE driver_home_status s
   SET person_id = pg.person_id
  FROM driver_person_groups pg
 WHERE pg.group_id = s.group_id AND pg.ended_at IS NULL AND s.person_id IS NULL;

UPDATE home_time_requests r
   SET person_id = pg.person_id
  FROM driver_person_groups pg
 WHERE pg.group_id = r.group_id AND pg.ended_at IS NULL AND r.person_id IS NULL;

UPDATE fuel_stop_alerts f
   SET person_id = pg.person_id
  FROM driver_person_groups pg
 WHERE pg.group_id = f.group_id AND pg.ended_at IS NULL AND f.person_id IS NULL;

UPDATE route_assignments a
   SET person_id = pg.person_id
  FROM driver_person_groups pg
 WHERE pg.group_id = a.group_id AND pg.ended_at IS NULL AND a.person_id IS NULL;

UPDATE dispatch_team_drivers d
   SET person_id = pg.person_id
  FROM driver_person_groups pg
 WHERE pg.group_id = d.group_id AND pg.ended_at IS NULL AND d.person_id IS NULL;

-- Mileage rows are keyed on a normalised NAME, not a group. They are filled only
-- where exactly ONE canonical person normalises to the same name — a collision
-- is precisely the bug this column exists to escape from, so it is left NULL
-- for a human, never guessed.
UPDATE mileage_bonus_progress m
   SET person_id = k.person_id
  FROM (
    SELECT regexp_replace(btrim(upper(regexp_replace(display_name, '[^A-Za-z0-9 ]+', ' ', 'g'))), '\s+', ' ', 'g') AS name_key,
           MIN(id) AS person_id
      FROM driver_people
     WHERE merged_into_person_id IS NULL
     GROUP BY 1
    HAVING COUNT(*) = 1
  ) k
 WHERE k.name_key = m.driver_normalized_name AND m.person_id IS NULL;
