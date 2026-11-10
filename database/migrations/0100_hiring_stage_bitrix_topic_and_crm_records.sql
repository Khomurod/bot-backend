-- Migration 0100: hiring stage bitrix topic and crm records
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR (owner, November 2026).
--
-- 1. THE BITRIX TOPIC. The bot still READS each candidate's conversation in the
--    recruiting group's General topic, but everything it WRITES about Bitrix —
--    stage proposals, deals it created or could not create, Move / No results,
--    Bitrix errors — goes to one topic of its own, named in Settings → Safety
--    Approvals → 5. With no topic saved nothing Bitrix is posted anywhere: the
--    worker waits (`blocked`) and the queue keeps every conversation.
--
-- 2. CONTACT + DEAL CREATED WHEN MISSING. When the conversation identifies ONE
--    candidate for certain (one name read off the post, one phone a recruiter
--    typed) and Bitrix has no open deal for them, the bot creates the contact
--    (or reuses the one holding that phone) and a deal at the pipeline's first
--    stage, then proposes the stage move as usual — a person still presses
--    Move. `hiring_stage_crm_records` is the claim that makes that creation
--    happen at most once: one row per conversation, at most one creation in
--    flight per phone, and every step recorded BEFORE the Bitrix call so a
--    retry after a timeout searches Bitrix first instead of adding again.
--
-- 3. NOTICES, ONCE. `hiring_stage_notices` remembers which notice the bot
--    posted about a conversation (reserved before the send), so a re-read
--    never posts "created" or "Bitrix error" twice.
--
-- Rows carry a driver's name and phone: deleted after 60 days with the
-- captured messages they came from (services/hiringStages/worker.js).

ALTER TABLE safety_approval_settings
  ADD COLUMN IF NOT EXISTS bitrix_topic_id INTEGER;

-- Why the bot did not create the deal itself, shown on a "please create it" request.
ALTER TABLE hiring_stage_proposals
  ADD COLUMN IF NOT EXISTS note TEXT;

CREATE TABLE IF NOT EXISTS hiring_stage_crm_records (
  id               BIGSERIAL PRIMARY KEY,
  chat_id          TEXT NOT NULL,
  root_message_id  BIGINT NOT NULL,
  -- Ten digits, as a recruiter typed it.
  phone            TEXT NOT NULL,
  driver_name      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'claimed',
  contact_id       BIGINT,
  contact_reused   BOOLEAN NOT NULL DEFAULT FALSE,
  deal_id          BIGINT,
  deal_reused      BOOLEAN NOT NULL DEFAULT FALSE,
  category_id      TEXT,
  stage_id         TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hiring_stage_crm_records_unique UNIQUE (chat_id, root_message_id),
  CONSTRAINT hiring_stage_crm_records_status CHECK (
    status IN ('claimed', 'creating_contact', 'creating_deal', 'created', 'blocked', 'failed')
  )
);

-- Two conversations about the same phone never create at the same time.
CREATE UNIQUE INDEX IF NOT EXISTS hiring_stage_crm_records_phone_in_flight
  ON hiring_stage_crm_records (phone)
  WHERE status IN ('claimed', 'creating_contact', 'creating_deal');

CREATE TABLE IF NOT EXISTS hiring_stage_notices (
  id               BIGSERIAL PRIMARY KEY,
  chat_id          TEXT NOT NULL,
  root_message_id  BIGINT NOT NULL,
  notice_key       TEXT NOT NULL,
  bot_message_id   BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hiring_stage_notices_unique UNIQUE (chat_id, root_message_id, notice_key)
);
