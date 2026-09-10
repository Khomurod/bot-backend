-- Migration 0029: home time tells three managers what HAPPENED, instead of
-- asking one of them for permission
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT CHANGES, AND WHY IT NEEDS A TABLE.
--
-- Home time used to reach managers as ONE Telegram card carrying Approve / Do
-- Not Approve buttons. Two things were wrong with that. It asked a question the
-- company had already answered — a driver who has been out five weeks is going
-- home, and nobody pressing a button changes whether the truck stopped. And it
-- was the ONLY message: nobody was told when the driver actually got home, and
-- nobody was told when they went back to work.
--
-- So there are three events now (requested / is home / back on the road), each
-- sent once, with no buttons. "Once" is the hard part: the events are re-derived
-- by background checks that run every few minutes, and an in-memory guard is
-- lost on every deploy. This table makes the guarantee durable — `event_key` is
-- UNIQUE, so a re-derived event is an INSERT that does nothing rather than a
-- second tag of three managers.
--
-- It is also a normal durable outbox (lease + attempts + backoff), the same
-- shape as home_time_requests' internal-alert columns and
-- samsara_video_recovery_jobs: a Telegram outage delays a notice, it never
-- loses one, and a crashed worker's claim simply expires.
CREATE TABLE IF NOT EXISTS home_time_manager_notices (
  id BIGSERIAL PRIMARY KEY,

  -- The identity of the EVENT, not of the message. 'arrived_home:412' is the
  -- arrival that opened road-history row 412 — derivable from the data, so any
  -- number of re-checks produce the same key and only the first one inserts.
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('request', 'arrived_home', 'back_on_road')),

  -- Who it is about. person_id is the permanent driver (migration 0015); the
  -- chat and the cycle are where it was observed. All nullable and ON DELETE
  -- SET NULL: a delivered notice is a historical fact and outlives its subject.
  person_id INTEGER REFERENCES driver_people(id) ON DELETE SET NULL,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  road_history_id INTEGER REFERENCES driver_road_history(id) ON DELETE SET NULL,
  request_id INTEGER REFERENCES home_time_requests(id) ON DELETE SET NULL,

  -- The rendered text and its destination, stored at enqueue time so the worker
  -- re-sends exactly what was decided rather than re-deriving it from data that
  -- has since moved on.
  chat_id TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Counts and short labels only — never a driver's message, never a location.
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'failed', 'abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_until TIMESTAMPTZ,
  last_error TEXT,
  telegram_message_id BIGINT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

-- The worker's only query: due, still-pending notices, oldest first.
CREATE INDEX IF NOT EXISTS idx_home_time_manager_notices_due
  ON home_time_manager_notices (next_attempt_at ASC)
  WHERE state = 'pending';

-- "What was this driver told about?" for the admin timeline.
CREATE INDEX IF NOT EXISTS idx_home_time_manager_notices_person
  ON home_time_manager_notices (person_id, created_at DESC);

-- ─── A request that needs no decision ────────────────────────────────────────
-- 'pending' meant "dates are complete, a manager must now press a button".
-- Nobody presses one any more, so a completed request needs a terminal status
-- that says what is true: it was recorded, and home time is being tracked.
--
-- 'approved' and 'denied' are NOT touched, here or in code: they are historical
-- decisions, homeTimeEfficiencyService still reads them to classify a cycle as
-- an approved exception, and rewriting them would silently change months of
-- reporting. Legacy 'pending' rows are left exactly as they are too — the new
-- code simply treats them the way it treats 'recorded' (complete, waiting for
-- nobody), so no history is rewritten to make the new behaviour work.
ALTER TABLE home_time_requests
  DROP CONSTRAINT IF EXISTS home_time_requests_status_check;
ALTER TABLE home_time_requests
  ADD CONSTRAINT home_time_requests_status_check
  CHECK (status IN ('pending', 'recorded', 'approved', 'denied', 'cancelled',
    'awaiting_dates', 'awaiting_home_start', 'awaiting_return_to_road',
    'clarification_unanswered', 'expired'));
