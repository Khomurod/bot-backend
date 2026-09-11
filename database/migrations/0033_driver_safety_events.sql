-- Migration 0033: keep safety events, so a driver's PATTERN can be seen rather
-- than only each incident as it happens
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THIS DID NOT EXIST.
--
-- The Samsara poller has been formatting safety events and sending them to
-- Telegram for a long time, and then throwing them away. The only durable
-- record is `samsara_processed_events(id, processed_at)` — an id and a
-- timestamp, for deduplication — plus a `raw_event` blob kept ONLY for the
-- subset of events that arrived without video.
--
-- So "how many harsh-braking events has this driver had this month" has never
-- been answerable. Every alert was treated as an isolated incident, which is
-- exactly the framing that makes safety coaching impossible: a first hard brake
-- in traffic and the fourth this week are the same message today.
--
-- This table is the missing half. The poller already has every field below in
-- memory at the moment it formats the alert; it simply had nowhere to put them.
--
-- WHAT IT IS NOT. It is not a copy of the Samsara event, and it stores NO media
-- reference: a signed video URL is a credential with an expiry, and this table
-- is read by features that put things in chat messages.
CREATE TABLE IF NOT EXISTS driver_safety_events (
  -- Samsara's own event id, so a re-poll cannot double-count a pattern.
  samsara_event_id TEXT PRIMARY KEY,

  -- WHO, through the identity spine. `person_id` is the column every pattern
  -- query groups by: a driver who changes truck or chat is still the same
  -- person, and a scorecard that resets on a truck change is worse than none.
  person_id INTEGER REFERENCES driver_people(id) ON DELETE SET NULL,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  vehicle_id TEXT,
  unit_number TEXT,
  driver_name TEXT,

  -- WHAT. `behavior` is Samsara's own label, normalised to snake_case so
  -- "Harsh Braking", "harshBraking" and "HARSH_BRAKING" group together.
  behavior TEXT NOT NULL,
  severity TEXT,
  -- Samsara frequently gives raw telematics instead of a severity word, so the
  -- number is kept beside the label rather than folded into it.
  g_force DOUBLE PRECISION,
  speed_mph DOUBLE PRECISION,
  posted_speed_mph DOUBLE PRECISION,

  -- WHEN and WHERE. The coordinates are for "was this the same junction twice",
  -- not for tracking: they are a point on one event, not a trail.
  occurred_at TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The pattern query: this driver, this window, newest first.
CREATE INDEX IF NOT EXISTS idx_driver_safety_events_person
  ON driver_safety_events (person_id, occurred_at DESC)
  WHERE person_id IS NOT NULL;

-- The same question for a driver not yet matched to a person.
CREATE INDEX IF NOT EXISTS idx_driver_safety_events_group
  ON driver_safety_events (group_id, occurred_at DESC)
  WHERE group_id IS NOT NULL;

-- "What kind of events is the fleet having", for the fleet-level view.
CREATE INDEX IF NOT EXISTS idx_driver_safety_events_behavior
  ON driver_safety_events (behavior, occurred_at DESC);

-- ─── What Wenze has already said to a driver about their driving ─────────────
-- Coaching that repeats itself is nagging, and a driver who is nagged stops
-- reading. This records each coaching message so the next pass can see it.
CREATE TABLE IF NOT EXISTS driver_safety_coaching (
  id BIGSERIAL PRIMARY KEY,
  person_id INTEGER REFERENCES driver_people(id) ON DELETE SET NULL,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  -- The pattern that prompted it, so "we already talked about braking" is
  -- answerable separately from "we already talked about speeding".
  behavior TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  -- What was actually sent, so a person can see what the driver was told.
  message TEXT,
  -- Whether it reached the driver's own group or only the operations chat.
  delivered_to TEXT NOT NULL DEFAULT 'operations'
    CHECK (delivered_to IN ('operations', 'driver_group')),
  telegram_message_id BIGINT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_safety_coaching_person
  ON driver_safety_coaching (person_id, behavior, sent_at DESC)
  WHERE person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_driver_safety_coaching_group
  ON driver_safety_coaching (group_id, behavior, sent_at DESC)
  WHERE group_id IS NOT NULL;
