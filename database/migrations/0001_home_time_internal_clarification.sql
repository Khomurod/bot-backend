-- Migration 0001: home time internal clarification
-- migrate:kind: schema
--
-- Adds the Home-Time "silent mode": the ability to keep detecting, recording and
-- analysing driver-group home-time messages while sending NOTHING to the driver
-- group, notifying an internal staff group instead.
--
-- Strictly additive and idempotent. The existing overall "Tracking enabled"
-- switch (home_time_settings.enabled) is untouched and keeps its meaning.
--
-- See docs/superpowers/specs/2026-07-29-fleetview-archive-hometime-messaging-design.md

-- ─── Settings ────────────────────────────────────────────────────────────────

-- Master switch for talking to DRIVER groups. When FALSE the bot still reads,
-- classifies and records everything, but sends no clarification question,
-- reminder, acknowledgment, reaction or policy warning to the driver's group.
-- Defaults TRUE so deploying this migration preserves current behaviour exactly.
ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS driver_clarification_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Telegram chat id (TEXT to keep full precision on large negative supergroup
-- ids, matching completed_notify_group_id) that receives the internal
-- "please clarify the dates with this driver" alert while driver messaging is
-- off. NULL = not configured: the alert is skipped with a logged warning and the
-- request is still recorded and visible in the admin panel.
ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS internal_clarification_group_id TEXT;

-- ─── Requests ────────────────────────────────────────────────────────────────

-- Which channel this request's clarification is being handled through:
--   'driver'   — the bot asked the driver directly (existing behaviour);
--   'internal' — staff were alerted instead and must clarify out of band.
--
-- Deliberately a separate column rather than a new `status` value: the awaiting_*
-- statuses drive missingFieldFor(), statusForMissingFields(), the reminder sweep
-- and the completion path, so adding a status would touch all of them. The admin
-- panel renders "Awaiting staff clarification" from this column + an awaiting_*
-- status. NULL on historical rows means 'driver' (that was the only behaviour).
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS clarification_channel TEXT
    CHECK (clarification_channel IN ('driver', 'internal'));

-- Duplicate-alert guard. Claimed atomically:
--   UPDATE ... SET internal_alert_sent_at = NOW()
--   WHERE id = $1 AND internal_alert_sent_at IS NULL RETURNING *
-- so concurrent ticks, retries and restarts can never double-post the same
-- request to the internal group.
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS internal_alert_sent_at TIMESTAMPTZ;

-- Finding the rows that still need an internal alert is a hot-ish lookup while
-- silent mode is on; keep it cheap and skip the (majority) already-alerted rows.
CREATE INDEX IF NOT EXISTS idx_home_time_requests_internal_pending
  ON home_time_requests (group_id)
  WHERE clarification_channel = 'internal' AND internal_alert_sent_at IS NULL;
