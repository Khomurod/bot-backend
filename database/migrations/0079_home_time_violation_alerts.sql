-- Migration 0079: home-time policy violation alerts (Bitrix pipeline 33 → accounting)
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. When a company driver breaks the home-time policy — home
-- before 28 days on the road, or home longer than 4 days — accounting is told
-- in a Telegram group to charge the driver, and marks the outcome with a
-- button. The decision comes from Bitrix24's "6. HOMETIME MONITORING" pipeline
-- (category 33), never from the app's own home-time state machine. See
-- docs/architecture/home-time-violation-alerts.md.
--
-- THE SWITCH AND THE GROUP live on the existing home-time settings row. Off,
-- and no group, until a person saves both. `violation_alerts_baselined_at` is
-- set by the first pass after switching on: every card already in a violation
-- stage then is recorded as `baselined` and never posted, so a year of history
-- is not dumped into the group on day one.
ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS violation_alerts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS violation_alerts_chat_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS violation_alerts_baselined_at TIMESTAMPTZ NULL;

-- ONE ROW PER VIOLATION PER HOME STAY. The UNIQUE key is the whole idempotency
-- story: the webhook, a retried webhook, the reconciliation pass and a restart
-- all insert ON CONFLICT DO NOTHING, and only the insert that wins may post.
-- A message naming both violations is two rows sharing one telegram_message_id.
CREATE TABLE IF NOT EXISTS home_time_violation_notices (
  id                      BIGSERIAL PRIMARY KEY,
  deal_id                 BIGINT      NOT NULL,
  home_from               DATE        NOT NULL,
  violation               TEXT        NOT NULL CHECK (violation IN ('early', 'overstay')),
  stage_id                TEXT        NOT NULL,
  driver_name             TEXT        NULL,
  road_days               INTEGER     NULL,
  home_days               INTEGER     NULL,
  -- baselined: was already in a violation stage when alerts were switched on;
  -- never posted. pending → posted, or failed → (retried) → abandoned.
  state                   TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('baselined', 'pending', 'posted', 'failed', 'abandoned')),
  chat_id                 TEXT        NULL,
  telegram_message_id     BIGINT      NULL,
  attempts                INTEGER     NOT NULL DEFAULT 0,
  claimed_until           TIMESTAMPTZ NULL,
  last_error              TEXT        NULL,
  -- Accounting's answer. Written once: a second tap, or a second accountant,
  -- cannot overwrite it (the UPDATE is conditional on decision IS NULL).
  decision                TEXT        NULL CHECK (decision IN ('charged', 'not_charging')),
  decided_by_id           TEXT        NULL,
  decided_by_name         TEXT        NULL,
  decided_at              TIMESTAMPTZ NULL,
  decision_reason         TEXT        NULL,
  reason_prompt_message_id BIGINT     NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_at               TIMESTAMPTZ NULL,
  CONSTRAINT home_time_violation_notices_once UNIQUE (deal_id, home_from, violation)
);

CREATE INDEX IF NOT EXISTS idx_home_time_violation_notices_due
  ON home_time_violation_notices (state)
  WHERE state IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_home_time_violation_notices_message
  ON home_time_violation_notices (chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;
