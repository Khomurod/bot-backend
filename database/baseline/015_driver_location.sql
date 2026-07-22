-- ─── Driver Location Monitoring — RETIRED ────────────────────────────
-- The pickup/delivery "Checked In / Checked Out" location-monitor feature was
-- RETIRED (2026-07). The poller, callback handlers, admin API/UI, and DB helper
-- module were removed; see docs/architecture/retired-checkin-checkout-feature.md.
-- These two tables (driver_location_monitors, driver_location_checkins) are
-- INTENTIONALLY RETAINED so historical check-in/dwell data is preserved and a
-- fresh init-db still succeeds. No application code references them any more.
-- They may be dropped manually AFTER a backup if the data is no longer needed;
-- do not add an automatic destructive migration.
--
-- (Original description) Per-driver-group toggle + scheduler state: a poller
-- resolved the driver's active load (Datatruck, with AI-parsed load context as
-- fallback), decided shipper (pickup) vs receiver (delivery), tracked the live
-- ETA, and — when the truck entered the check-in radius — sent the check-in
-- prompt to the driver group. Mirrored the claim/poll/reschedule shape of
-- dispatch_eta_updates + fuel_stop_alerts.
CREATE TABLE IF NOT EXISTS driver_location_monitors (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Re-poll cadence floor (minutes). The poller schedules adaptively based on
  -- ETA but never sleeps longer than this between checks.
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  -- Distance (miles) at which the check-in prompt fires (the "10–5 miles" band;
  -- prompt sends as soon as the truck is within this radius).
  checkin_radius_miles NUMERIC NOT NULL DEFAULT 8,
  -- Scheduler bookkeeping.
  next_run_at TIMESTAMP NULL,
  processing BOOLEAN NOT NULL DEFAULT FALSE,
  processing_started_at TIMESTAMP NULL,
  last_run_at TIMESTAMP NULL,
  last_status TEXT NULL,
  last_error TEXT NULL,
  -- Current load + target stop snapshot (so each tick is cheap and the admin
  -- panel can show live state without recomputing).
  current_order_id TEXT NULL,
  load_phase TEXT NULL,            -- heading_pickup | heading_delivery | unknown
  target_stop_type TEXT NULL,      -- shipper | receiver
  target_address TEXT NULL,
  target_lat DOUBLE PRECISION NULL,
  target_lng DOUBLE PRECISION NULL,
  target_appointment_at TIMESTAMPTZ NULL,
  last_eta_minutes INTEGER NULL,
  last_eta_at TIMESTAMPTZ NULL,
  last_distance_miles NUMERIC NULL,
  -- The check-in row currently awaiting a driver answer (NULL when none open).
  active_checkin_id INTEGER NULL,
  cached_context_json JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT driver_location_interval_check CHECK (interval_minutes BETWEEN 1 AND 1440),
  CONSTRAINT driver_location_radius_check CHECK (checkin_radius_miles BETWEEN 1 AND 100),
  CONSTRAINT driver_location_phase_check CHECK (
    load_phase IS NULL OR load_phase IN ('heading_pickup', 'heading_delivery', 'unknown')
  ),
  CONSTRAINT driver_location_stop_type_check CHECK (
    target_stop_type IS NULL OR target_stop_type IN ('shipper', 'receiver')
  )
);

-- Idempotent column adds (mirrors the dispatch_eta_updates migration style so
-- pre-existing deployments pick up new columns without a manual migration).
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS checkin_radius_miles NUMERIC NOT NULL DEFAULT 8;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS current_order_id TEXT NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS load_phase TEXT NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS target_stop_type TEXT NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS target_address TEXT NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS target_lat DOUBLE PRECISION NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS target_lng DOUBLE PRECISION NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS target_appointment_at TIMESTAMPTZ NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS last_eta_minutes INTEGER NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS last_eta_at TIMESTAMPTZ NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS last_distance_miles NUMERIC NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS active_checkin_id INTEGER NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS cached_context_json JSONB NULL;

CREATE INDEX IF NOT EXISTS idx_driver_location_due
  ON driver_location_monitors(next_run_at)
  WHERE enabled = TRUE;

-- One row per check-in prompt sent to a driver. Records the driver's Yes/No
-- answer and whether they were on time for that stop, building the shipper/
-- receiver on-time performance history the operator asked for.
CREATE TABLE IF NOT EXISTS driver_location_checkins (
  id SERIAL PRIMARY KEY,
  monitor_id INTEGER NOT NULL REFERENCES driver_location_monitors(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT NOT NULL,
  order_id TEXT NULL,
  stop_type TEXT NOT NULL,         -- shipper | receiver
  location_address TEXT NULL,
  appointment_at TIMESTAMPTZ NULL,
  eta_at TIMESTAMPTZ NULL,
  distance_miles_at_prompt NUMERIC NULL,
  prompt_message_id BIGINT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_response',  -- awaiting_response | answered | expired
  driver_response TEXT NULL,       -- yes | no
  responded_by_username TEXT NULL,
  responded_by_user_id BIGINT NULL,
  responded_at TIMESTAMPTZ NULL,
  on_time BOOLEAN NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT driver_location_checkin_stop_type_check CHECK (stop_type IN ('shipper', 'receiver')),
  CONSTRAINT driver_location_checkin_status_check CHECK (status IN ('awaiting_response', 'answered', 'expired')),
  CONSTRAINT driver_location_checkin_response_check CHECK (
    driver_response IS NULL OR driver_response IN ('yes', 'no', 'checked_in', 'checked_out')
  )
);

-- One-prompt-per-stop idempotency key. Stable per (group, order|address, stop_type)
-- so a given order's shipper stop (and its receiver stop) is prompted at most once,
-- and null-order fallback loads dedupe on the target address instead. The UNIQUE
-- partial index below makes a concurrent double-claim insert fail (23505) rather
-- than send a second prompt.
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS dedupe_key TEXT NULL;

-- Two-phase check-in flow: the driver taps "Checked In" on arrival (that button
-- disappears, "Checked Out" stays) and "Checked Out" on departure. Both moments
-- are stamped so checked_out_at - checked_in_at gives the facility dwell time,
-- building the dataset that will later predict how long drivers stay at a given
-- facility (grouped by location_address). Who tapped is stored per phase.
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ NULL;
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMPTZ NULL;
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_in_by_username TEXT NULL;
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_in_by_user_id BIGINT NULL;
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_out_by_username TEXT NULL;
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_out_by_user_id BIGINT NULL;

-- Status now walks awaiting_response → checked_in (at the facility) → completed.
-- 'answered' and 'expired' remain for legacy rows / stale prompts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'driver_location_checkin_status_check'
      AND table_name = 'driver_location_checkins'
  ) THEN
    ALTER TABLE driver_location_checkins DROP CONSTRAINT driver_location_checkin_status_check;
  END IF;
END
$$;

ALTER TABLE driver_location_checkins
  ADD CONSTRAINT driver_location_checkin_status_check
  CHECK (status IN ('awaiting_response', 'answered', 'checked_in', 'completed', 'expired'));

-- The buttons became "Checked In"/"Checked Out" (was Yes/No); widen the allowed
-- responses on pre-existing deployments without dropping historic 'yes'/'no' rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'driver_location_checkin_response_check'
      AND table_name = 'driver_location_checkins'
  ) THEN
    ALTER TABLE driver_location_checkins DROP CONSTRAINT driver_location_checkin_response_check;
  END IF;
END
$$;

ALTER TABLE driver_location_checkins
  ADD CONSTRAINT driver_location_checkin_response_check
  CHECK (driver_response IS NULL OR driver_response IN ('yes', 'no', 'checked_in', 'checked_out'));

CREATE INDEX IF NOT EXISTS idx_driver_location_checkins_group_created
  ON driver_location_checkins(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_location_checkins_monitor
  ON driver_location_checkins(monitor_id, created_at DESC);

-- At-most-once prompt per stop signature. Concurrent claims racing to prompt the
-- same stop collide on this index; the loser catches the unique violation and
-- treats the stop as already prompted (no duplicate message).
CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_location_checkins_stop_once
  ON driver_location_checkins(dedupe_key)
  WHERE dedupe_key IS NOT NULL;
