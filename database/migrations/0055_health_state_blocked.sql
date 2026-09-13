-- 0055 — "switched off" is not "broken"
--
-- `lib/operations/runHealth.js` has said this since it was written: "A worker
-- that cannot run because an operator has not configured a Telegram group or an
-- API key is NOT broken, and painting it red is how a real outage gets lost
-- among things that were never switched on."
--
-- One layer up, that was defeated. `healthObservations` collapsed every
-- actionable verdict into `ok: false`, `healthTransitions` wrote `failed`, and
-- `/api/health` reported production as `systems: { failed: 3, down: [the
-- Dispatcher Board, the weekly finance report, the finance document reader] }`
-- — three features nobody had switched on yet. Left alone, each would also have
-- announced itself to the operations chat as "not working / Needs a person;
-- Wenze has not been able to recover from this one", which is untrue twice
-- over: it is not failing, and nothing is there to recover.
--
-- So `blocked` becomes a third status a component can be in. The CHECK is
-- widened the way 0047 widened `driver_profiles.driver_type`: guarded on the
-- constraint's own definition, so running it twice is a no-op and it can never
-- fail a boot.
--
-- Existing rows are NOT rewritten. The next sweep observes each component and
-- writes the honest status itself, within a quarter of an hour of the deploy —
-- and a migration that guessed which of today's `failed` rows were merely
-- unconfigured would be doing exactly the guessing this change exists to stop.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'system_health_states_status_check'
       AND conrelid = 'system_health_states'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%blocked%'
  ) THEN
    ALTER TABLE system_health_states DROP CONSTRAINT system_health_states_status_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'system_health_states_status_check'
       AND conrelid = 'system_health_states'::regclass
  ) THEN
    ALTER TABLE system_health_states
      ADD CONSTRAINT system_health_states_status_check
      CHECK (status IN ('ok', 'failed', 'blocked'));
  END IF;
END
$$;
