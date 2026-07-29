-- Migration 0002: home time internal alert outbox
-- migrate:kind: schema
--
-- Makes the internal staff clarification alert DURABLY retryable.
--
-- 0001 gave home_time_requests a single `internal_alert_sent_at` column claimed
-- with `WHERE internal_alert_sent_at IS NULL`. That is a one-shot claim: it stops
-- duplicates, but if the process crashes after claiming and before Telegram
-- confirms, the alert is stuck "sent" forever and no staff member is ever told.
-- A transient Telegram error had the same problem unless the in-process code
-- happened to run its release path.
--
-- This adds a lease-based outbox on the same table (no new table — one alert per
-- request, so the request row IS the outbox entry):
--
--   state          pending | delivered | failed
--   next_attempt_at   when this alert may next be tried (backoff)
--   claimed_until     lease expiry; a crashed worker's claim simply times out
--   attempts          bounded retry counter
--   last_error        why the last attempt failed (diagnostics)
--
-- `internal_alert_sent_at` from 0001 is KEPT and still means "delivered at",
-- so nothing that reads it changes behaviour.
--
-- 0001 is already applied in production and is NOT modified (that would trip the
-- runner's checksum-drift guard). Additive and idempotent throughout.

ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS internal_alert_state TEXT
    CHECK (internal_alert_state IN ('pending', 'delivered', 'failed'));

ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS internal_alert_next_attempt_at TIMESTAMPTZ;

ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS internal_alert_claimed_until TIMESTAMPTZ;

ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS internal_alert_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS internal_alert_last_error TEXT;

-- Backfill rows that predate the outbox, so nothing is lost and nothing is
-- re-sent. Guarded on internal_alert_state IS NULL, so re-running is a no-op
-- (and so a row later moved to 'failed' is never resurrected).
--
--   already delivered under 0001  → 'delivered'
--   internal channel, never sent  → 'pending', eligible immediately
UPDATE home_time_requests
   SET internal_alert_state = 'delivered'
 WHERE internal_alert_state IS NULL
   AND internal_alert_sent_at IS NOT NULL;

UPDATE home_time_requests
   SET internal_alert_state = 'pending',
       internal_alert_next_attempt_at = NOW()
 WHERE internal_alert_state IS NULL
   AND internal_alert_sent_at IS NULL
   AND clarification_channel = 'internal';

-- The worker's hot query: the oldest due, unclaimed, pending alerts. Partial so
-- it stays tiny — delivered/failed rows (the overwhelming majority) are excluded.
CREATE INDEX IF NOT EXISTS idx_home_time_requests_alert_due
  ON home_time_requests (internal_alert_next_attempt_at)
  WHERE internal_alert_state = 'pending';
