-- Migration 0047: fleet type becomes part of a truck's name
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: A TRUCK NUMBER ALONE IS NOT GLOBALLY UNIQUE.
--
-- Wenze runs three fleets that number their trucks independently. Company 001,
-- Owner-Operator 001 and Lease 001 are three different trucks driven by three
-- different people. Production carries ten unit numbers on more than one active
-- driver group, `001` on four of them, and to every piece of logic that compares
-- bare numbers those look like the same truck. `driver_units` enforced exactly
-- that mistake: one open row per `unit_number`, full stop.
--
-- So the truck's name becomes (fleet_type, unit_number, seat):
--
--   fleet_type  which fleet numbers this truck. `unknown` is a real value and
--               NEVER wins a match — a row Wenze cannot place is a question.
--   seat        a team is TWO people on ONE truck, seats 1 and 2. They are not
--               duplicates, and the old index made them unrepresentable.
--
-- THE ONE DESTRUCTIVE STEP IN THIS PROGRAM is dropping
-- `uniq_driver_units_open_unit`. It is strictly STRONGER than the index that
-- replaces it — one open row per unit_number implies at most one per
-- (fleet, unit, seat) — so a collision is impossible unless somebody removed
-- that index by hand. The DO block below proves it rather than assuming it:
-- zero collisions, or the old index stays and a finding is filed. A migration
-- that took the fleet's uniqueness guarantee away on a bad assumption would be
-- very hard to notice and very expensive to undo.

-- ── driver_profiles.driver_type learns `lease` ───────────────────────────────
--
-- The column speaks `owner` / `company_driver` and predates the Board. `lease`
-- has no legacy spelling, so it is simply added. `lib/drivers/fleetType.js` is
-- the one place this vocabulary is translated to the Board's.
--
-- The CHECK is declared TWICE in the baseline — inline in
-- `001_core_identity.sql` and re-added by `003_admins_and_bot_visibility.sql`,
-- the latter guarded on the constraint NAME. Both are widened in the same
-- change, so a fresh database gets the wide form and an existing one is
-- corrected here; because 003's guard tests the name, it never re-narrows what
-- this dropped and re-added.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'driver_profiles_driver_type_check'
       AND conrelid = 'driver_profiles'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%lease%'
  ) THEN
    ALTER TABLE driver_profiles DROP CONSTRAINT driver_profiles_driver_type_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'driver_profiles_driver_type_check'
       AND conrelid = 'driver_profiles'::regclass
  ) THEN
    ALTER TABLE driver_profiles
      ADD CONSTRAINT driver_profiles_driver_type_check
      CHECK (driver_type IS NULL OR driver_type IN ('owner', 'company_driver', 'lease'));
  END IF;
END
$$;

-- ── driver_units gains the other two thirds of a truck's name ────────────────
ALTER TABLE driver_units ADD COLUMN IF NOT EXISTS fleet_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE driver_units ADD COLUMN IF NOT EXISTS seat SMALLINT NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'driver_units_fleet_type_check'
       AND conrelid = 'driver_units'::regclass
  ) THEN
    ALTER TABLE driver_units
      ADD CONSTRAINT driver_units_fleet_type_check
      CHECK (fleet_type IN ('company', 'lease', 'owner_operator', 'unknown'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'driver_units_seat_check'
       AND conrelid = 'driver_units'::regclass
  ) THEN
    -- Two seats, because a team is two people and the Board describes no third.
    ALTER TABLE driver_units
      ADD CONSTRAINT driver_units_seat_check CHECK (seat IN (1, 2));
  END IF;
END
$$;

-- ── backfill from what is already recorded ───────────────────────────────────
--
-- Only where the chain person → open group → profile gives a `driver_type` that
-- is actually set. Everything else stays `unknown`, which is the honest answer
-- and the one that never wins a match. No title is parsed here: a backfill that
-- guessed would bake a guess into the column that decides who shares a truck.
-- AND ONLY WHERE THE CHAIN AGREES WITH ITSELF. A person can hold two OPEN group
-- associations at once — that is `identity.person_on_two_active_groups`, a
-- condition production actually has — and their two profiles can disagree about
-- the driver type. A plain `UPDATE ... FROM` matches both rows and Postgres
-- picks one arbitrarily: a coin toss, silently, into the column that decides who
-- may share a truck number. So the chains are aggregated first and only an
-- unambiguous one is used; a disagreement stays `unknown` for a person to settle.
UPDATE driver_units u
   SET fleet_type = agreed.fleet_type
  FROM (
    SELECT pg.person_id,
           MIN(CASE dp.driver_type
                 WHEN 'company_driver' THEN 'company'
                 WHEN 'lease'          THEN 'lease'
                 WHEN 'owner'          THEN 'owner_operator'
               END) AS fleet_type,
           COUNT(DISTINCT dp.driver_type) AS distinct_types
      FROM driver_person_groups pg
      JOIN driver_profiles dp ON dp.group_id = pg.group_id
     WHERE pg.ended_at IS NULL
       AND dp.driver_type IN ('owner', 'company_driver', 'lease')
     GROUP BY pg.person_id
  ) AS agreed
 WHERE u.person_id = agreed.person_id
   AND agreed.distinct_types = 1
   AND u.ended_at IS NULL
   AND u.fleet_type = 'unknown';

-- ── the index swap, proved rather than assumed ───────────────────────────────
DO $$
DECLARE
  collisions INTEGER;
BEGIN
  SELECT COUNT(*) INTO collisions FROM (
    SELECT 1 FROM driver_units
     WHERE ended_at IS NULL
     GROUP BY fleet_type, unit_number, seat
    HAVING COUNT(*) > 1
  ) AS c;

  IF collisions = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_units_open_fleet_unit_seat
      ON driver_units (fleet_type, unit_number, seat) WHERE ended_at IS NULL;
    DROP INDEX IF EXISTS uniq_driver_units_open_unit;
  ELSE
    -- The old, stronger index stays. Somebody has to look before the fleet
    -- loses a uniqueness guarantee it currently has.
    INSERT INTO operational_findings (
      check_key, subject_type, subject_id, title, severity, tier,
      confidence, evidence_json, first_seen_at, last_seen_at, status
    ) VALUES (
      'identity.unit_index_migration_blocked', 'system', 'driver_units',
      'The truck-identity index could not be replaced',
      'serious', 'warning', 100,
      jsonb_build_object(
        'collisions', collisions,
        'detail', 'open driver_units rows share a (fleet_type, unit_number, seat). '
                  'The old one-open-row-per-unit index is still in force, so team '
                  'seats and same-numbered trucks in different fleets remain '
                  'unrepresentable until a person resolves the collisions.'
      ),
      NOW(), NOW(), 'open'
    )
    ON CONFLICT (check_key, subject_type, subject_id) DO UPDATE
      SET last_seen_at = NOW(), status = 'open',
          evidence_json = EXCLUDED.evidence_json;
  END IF;
END
$$;

-- ── the sources that may now claim a unit or an association ──────────────────
-- Widened once, here, so later stages need no migration of their own.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'driver_units_source_check'
       AND conrelid = 'driver_units'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%board%'
  ) THEN
    ALTER TABLE driver_units DROP CONSTRAINT driver_units_source_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'driver_units_source_check'
       AND conrelid = 'driver_units'::regclass
  ) THEN
    ALTER TABLE driver_units
      ADD CONSTRAINT driver_units_source_check
      CHECK (source IN ('backfill', 'manual', 'group_title', 'profile', 'samsara', 'import', 'board'));
  END IF;
END
$$;

COMMENT ON COLUMN driver_units.fleet_type IS
  'Which fleet numbers this truck. Company 001, Owner-Operator 001 and Lease 001 are three trucks. "unknown" never wins a match.';
COMMENT ON COLUMN driver_units.seat IS
  'A team is two people on one truck: seats 1 and 2. They are not duplicates.';
