-- Migration 0052: capture what the finance group says, before claiming to read it
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR.
--
-- Money codes are issued in a Telegram group and then exist nowhere else. There
-- is no ledger, so "did we already send that one?" and "what went out last
-- week?" are answered by scrolling. This stores the messages so those questions
-- have an answer.
--
-- CAPTURE FIRST, CODIFY SECOND — AND THE SCHEMA ENFORCES THE ORDER.
-- `finance_messages.text` is the message verbatim and is the record. Everything
-- the parser concluded lives in `parse_status` / `parse_json` BESIDE it, never
-- instead of it, and `parser_version` says which parser concluded it. Nobody
-- has shown the parser a real message yet (lib/finance/moneycode.js says so in
-- its own header), so a tightened one must be able to re-read exactly the rows
-- the provisional one produced. Overwriting the text with an interpretation
-- would make that impossible, permanently.
--
-- `parse_status` has FOUR values and `ambiguous` is one of them on purpose:
-- 'not_moneycode' (ordinary chat), 'unparsed' (money words, no readable code),
-- 'ambiguous' (more than one candidate — the parser refuses to pick), 'parsed'.
--
-- OFF BY DEFAULT, AND OFF MEANS OFF. `enabled` is FALSE and `chat_id` is NULL
-- until a person validates a group in Settings. An integration that switches
-- itself on at deploy starts reading a chat nobody agreed to read — and this
-- one reads payment messages.
--
-- A DUPLICATE IS TWO DIFFERENT CLAIMS, so `duplicate_reason` records which:
-- 'same_code' is a fact (a code is what gets spent), while
-- 'same_amount_recipient_window' is a suspicion (two $500 advances to one
-- driver in a day is sometimes exactly right). The weekly report has to be able
-- to say "one code posted twice" without implying "paid twice", so the two are
-- never collapsed into a boolean. See lib/finance/duplicates.js.

CREATE TABLE IF NOT EXISTS finance_settings (
  id                    SMALLINT PRIMARY KEY DEFAULT 1,
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  -- NULL inherits FINANCE_GROUP_CHAT_ID, the house rule for every settings row.
  chat_id               TEXT,
  chat_title            TEXT,
  chat_validated_at     TIMESTAMPTZ,
  capture_documents     BOOLEAN NOT NULL DEFAULT FALSE,
  ai_reading_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  max_document_mb       INTEGER NOT NULL DEFAULT 8,
  duplicate_window_hours INTEGER NOT NULL DEFAULT 72,
  weekly_report_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  weekly_report_chat_id TEXT,
  enabled_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by            INTEGER,
  CONSTRAINT finance_settings_singleton CHECK (id = 1),
  CONSTRAINT finance_settings_document_mb CHECK (max_document_mb BETWEEN 1 AND 20),
  CONSTRAINT finance_settings_duplicate_window CHECK (duplicate_window_hours BETWEEN 1 AND 8760)
);

INSERT INTO finance_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS finance_messages (
  id               BIGSERIAL PRIMARY KEY,
  chat_id          TEXT NOT NULL,
  message_id       BIGINT NOT NULL,
  sender_user_id   BIGINT,
  sender_username  TEXT,
  sender_name      TEXT,
  -- The record. Never overwritten by anything the parser concluded.
  text             TEXT,
  has_document     BOOLEAN NOT NULL DEFAULT FALSE,
  has_photo        BOOLEAN NOT NULL DEFAULT FALSE,
  media_group_id   TEXT,
  message_date     TIMESTAMPTZ,
  edit_date        TIMESTAMPTZ,
  parse_status     TEXT NOT NULL DEFAULT 'unparsed',
  parser_version   INTEGER NOT NULL DEFAULT 1,
  parse_json       JSONB,
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT finance_messages_once UNIQUE (chat_id, message_id),
  CONSTRAINT finance_messages_parse_status CHECK (
    parse_status IN ('parsed', 'ambiguous', 'unparsed', 'not_moneycode')
  )
);

CREATE INDEX IF NOT EXISTS idx_finance_messages_date
  ON finance_messages (message_date DESC);

-- The report and the admin both read "what still needs a person", and both of
-- them ask for it by status.
CREATE INDEX IF NOT EXISTS idx_finance_messages_status
  ON finance_messages (parse_status, message_date DESC);

CREATE TABLE IF NOT EXISTS finance_moneycodes (
  id                 BIGSERIAL PRIMARY KEY,
  message_ref_id     BIGINT NOT NULL REFERENCES finance_messages(id) ON DELETE CASCADE,
  code               TEXT NOT NULL,
  code_normalized    TEXT NOT NULL,
  report_reference   TEXT,
  amount             NUMERIC(12, 2),
  currency           TEXT NOT NULL DEFAULT 'USD',
  issued_to          TEXT,
  issued_to_normalized TEXT,
  notes              TEXT,
  sender_user_id     BIGINT,
  sender_name        TEXT,
  issued_at          TIMESTAMPTZ,
  parser_version     INTEGER NOT NULL DEFAULT 1,
  confidence         SMALLINT,
  duplicate_of_id    BIGINT REFERENCES finance_moneycodes(id) ON DELETE SET NULL,
  duplicate_reason   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT finance_moneycodes_once UNIQUE (message_ref_id, code_normalized),
  CONSTRAINT finance_moneycodes_duplicate_reason CHECK (
    duplicate_reason IS NULL
    OR duplicate_reason IN ('same_code', 'same_amount_recipient_window')
  ),
  -- A row cannot claim to repeat itself, and cannot name a reason without
  -- naming the row it repeats.
  CONSTRAINT finance_moneycodes_duplicate_pair CHECK (
    (duplicate_of_id IS NULL AND duplicate_reason IS NULL)
    OR (duplicate_of_id IS NOT NULL AND duplicate_reason IS NOT NULL)
  ),
  CONSTRAINT finance_moneycodes_not_self CHECK (duplicate_of_id IS NULL OR duplicate_of_id <> id),
  CONSTRAINT finance_moneycodes_amount_positive CHECK (amount IS NULL OR amount > 0),
  CONSTRAINT finance_moneycodes_confidence CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_finance_moneycodes_code
  ON finance_moneycodes (code_normalized);

CREATE INDEX IF NOT EXISTS idx_finance_moneycodes_issued_at
  ON finance_moneycodes (issued_at DESC);

-- The weak duplicate signal looks for the same amount to the same person inside
-- a window, which is exactly this index's shape.
CREATE INDEX IF NOT EXISTS idx_finance_moneycodes_recipient_window
  ON finance_moneycodes (issued_to_normalized, amount, issued_at DESC)
  WHERE issued_to_normalized IS NOT NULL AND amount IS NOT NULL;
