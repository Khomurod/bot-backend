-- Migration 0024: a model retirement that has been told to a person, and one that has not
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY. The chain refresh saves the new chain, then the maintenance job writes
-- the finding and queues the Telegram line. If that second step fails — a
-- transient database error, the outbox table briefly unavailable — the next
-- pass sees a chain with nothing retired and never tells anyone. That is the
-- exact "nothing told a human" failure the durable outbox was built against.
--
-- So the notice is driven by the EVENT, not by the refresh result. A `retired`
-- row with `notified_at IS NULL` is a person who has not been told yet; the
-- job reads those, writes the finding and the alert, then stamps them. A
-- failure anywhere leaves the stamp off, and the next pass tries again.

ALTER TABLE ai_model_events ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_ai_model_events_pending_notice
  ON ai_model_events (provider_key, created_at)
  WHERE event = 'retired' AND notified_at IS NULL;
