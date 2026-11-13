-- Migration 0105: activity log
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.

--
-- LOGS (owner, 14 November 2026). The owner saw changes in Bitrix and could
-- not tell who made them, what changed or why. Every Bitrix WRITE the app
-- makes — and every automatic attempt it refused or that failed — is one row
-- here, newest first on Monitoring → Logs (super administrators only).
-- docs/architecture/activity-log.md.
--
--   system / action        'bitrix' / 'deal.stage', 'deal.title', 'deal.fields',
--                          'deal.create', 'contact.create', 'contact.update',
--                          'lead.create', 'item.update', … (text, so Telegram,
--                          RingCentral or Meta can follow without a migration)
--   target_*               the record: its type, its id, and — only for 60 days —
--                          the driver's / candidate's name or the deal title at
--                          the time (`target_label`)
--   change                 [{field, from, to}] — never a secret, a phone number
--                          or chat text
--   actor_*                who: a person's button or reply (their Telegram id is
--                          the evidence, the name a label), an admin, or
--                          'automatic' with the feature in `trigger`
--   reason / evidence      why, in one sentence, and the ids that prove it
--   result / error         done | refused | failed | already_done, and Bitrix's
--                          own words with every URL and credential removed
--   attempt / correlation  attempts of one action share `correlation_key`
--
-- APPEND-ONLY. The one UPDATE is retention's: after 60 days the name is taken
-- out (`target_label`, names in `change` / `evidence`; `names_scrubbed_at`
-- marks it done so a row is rewritten once), and after 365 days the row is
-- deleted (services/operations/dataRetention.js). Nothing else updates a row.

CREATE TABLE IF NOT EXISTS activity_log (
  id                  BIGSERIAL PRIMARY KEY,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  system              TEXT NOT NULL,
  action              TEXT NOT NULL,
  target_type         TEXT,
  target_id           TEXT,
  target_label        TEXT,
  change              JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_kind          TEXT NOT NULL DEFAULT 'unknown',
  actor_telegram_id   BIGINT,
  actor_admin_id      INTEGER,
  actor_name          TEXT,
  trigger             TEXT,
  reason              TEXT,
  evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
  result              TEXT NOT NULL,
  error               TEXT,
  attempt             INTEGER,
  correlation_key     TEXT,
  names_scrubbed_at   TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_result_check') THEN
    ALTER TABLE activity_log ADD CONSTRAINT activity_log_result_check
      CHECK (result IN ('done', 'refused', 'failed', 'already_done'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_actor_kind_check') THEN
    ALTER TABLE activity_log ADD CONSTRAINT activity_log_actor_kind_check
      CHECK (actor_kind IN ('person_button', 'person_reply', 'admin', 'automatic', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_error_length_check') THEN
    ALTER TABLE activity_log ADD CONSTRAINT activity_log_error_length_check
      CHECK (error IS NULL OR char_length(error) <= 400);
  END IF;
END $$;

-- The page: newest first, and newest first within one feature.
CREATE INDEX IF NOT EXISTS idx_activity_log_occurred
  ON activity_log (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_trigger
  ON activity_log (trigger, occurred_at DESC, id DESC);
-- One deal's history; a search by deal number.
CREATE INDEX IF NOT EXISTS idx_activity_log_target
  ON activity_log (target_type, target_id);
-- Retention's name scrub reads only the rows it has not scrubbed yet.
CREATE INDEX IF NOT EXISTS idx_activity_log_unscrubbed
  ON activity_log (occurred_at)
  WHERE names_scrubbed_at IS NULL;
