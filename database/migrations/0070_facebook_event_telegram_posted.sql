-- Migration 0070: remember that a lead event was already posted to Telegram
-- migrate:kind: schema
--
-- WHY: a Facebook lead event runs several steps — the Telegram post, the
-- Bitrix record, the `leads` row, the auto-SMS. When a later step threw, the
-- whole event was retried from the top, and the Telegram post went out again
-- on every retry. In production seven September leads were retried 94 to 238
-- times before they went through.
--
-- `telegram_posted_at` is stamped right after the post succeeds; a retry that
-- finds it set skips the post. NULL means not posted yet, or a row that
-- predates this column (those are all finished — nothing re-runs them unless a
-- person presses Retry).
--
-- Additive and idempotent. The new `abandoned` status needs no change here:
-- `status` is free text with no CHECK constraint.

ALTER TABLE facebook_webhook_events ADD COLUMN IF NOT EXISTS telegram_posted_at TIMESTAMP NULL;

COMMENT ON COLUMN facebook_webhook_events.telegram_posted_at IS
  'When this event''s lead was posted to the leads Telegram group. A retry that finds it set does not post again.';
