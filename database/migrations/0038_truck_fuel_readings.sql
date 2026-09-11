-- Migration 0038: the last fuel and odometer reading per truck, so consumption
-- can actually be compared against something
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THIS EXISTS: A BRANCH THAT COULD NEVER RUN.
--
-- `lib/fuel/risk.js` has an abnormal-consumption rule that needs two readings
-- of BOTH fuel and odometer. `previousFor()` in the watcher returned
--
--     { milesToStation: <real>, fuelPercent: null, odometerMiles: null }
--
-- with those two nulls HARD-CODED, and the rule requires both to be numbers. So
-- the branch was unreachable from the day it was written: the code existed, the
-- tests covered it with hand-made fixtures, and in production it could not fire
-- once. Its own comment explained the absence as a deliberate refusal to keep a
-- position history.
--
-- That refusal was right and is kept. THIS IS NOT A POSITION HISTORY. It is one
-- row per truck, updated in place, holding the latest reading and one older
-- baseline to measure against. A hundred and ten trucks is a hundred and ten
-- rows, for ever, whatever the fleet does.
--
-- WHY A BASELINE RATHER THAN THE PREVIOUS SAMPLE.
--
-- The watcher runs every twenty minutes. Two consecutive samples are a few
-- miles apart, and a percentage point of tank resolution over four miles is
-- noise that would report every truck as burning abnormally. The baseline only
-- advances once the truck has covered a real distance, so the comparison is
-- made over something long enough to mean anything.
--
-- AND A REFUEL RESETS IT. Burn measured across a fill-up is not burn; it is
-- arithmetic about a tank that got bigger. When the percentage rises, the
-- baseline restarts from there.

CREATE TABLE IF NOT EXISTS truck_fuel_readings (
  -- The truck. Unit number is what the telemetry providers key on, and what the
  -- fleet snapshot is matched by.
  unit_number TEXT PRIMARY KEY,

  -- Identity beside it, so a reading can follow the person when the chat or the
  -- truck changes. Nullable: a reading is still worth keeping for a truck whose
  -- driver has not been resolved.
  person_id BIGINT,
  group_id INTEGER,

  -- The most recent reading. NULL means the provider did not report it, which
  -- is NOT zero — most of this fleet does not report fuel at all.
  fuel_percent DOUBLE PRECISION,
  odometer_miles DOUBLE PRECISION,
  recorded_at TIMESTAMPTZ,

  -- The older reading the current one is measured against.
  baseline_fuel_percent DOUBLE PRECISION,
  baseline_odometer_miles DOUBLE PRECISION,
  baseline_at TIMESTAMPTZ,

  -- Why the baseline last moved: 'first' | 'distance' | 'refuel' | 'stale'.
  -- Kept because "this truck burned 30% over 400 miles" and "this truck was
  -- refuelled and the window restarted" look identical in the numbers alone.
  baseline_reason TEXT,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The watcher reads the whole table once per pass, so no index is needed for
-- that. This one is for the health summary and the identity join.
CREATE INDEX IF NOT EXISTS idx_truck_fuel_readings_person
  ON truck_fuel_readings (person_id)
  WHERE person_id IS NOT NULL;
