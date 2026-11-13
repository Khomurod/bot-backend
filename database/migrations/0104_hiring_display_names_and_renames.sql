-- Migration 0104: hiring display names and renames
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- HIRING DEAL NAMES (owner, 13–14 November 2026). Deals the bot created were
-- titled from the recruiter's post line as written — surname first, with the
-- recruiter's typos ("Goowin Leah Ann" while Safety wrote "LEAH GOODWIN
-- APPROVED") — and deals titled "No name" were found by phone and moved but
-- never renamed.
--
--   hiring_stage_crm_records.display_name   the name a creation writes to
--       Bitrix: the post's words, with Safety's own spelling and order where
--       Safety's message names the same driver (lib/hiringStages/displayName.js).
--       Stored at the claim, so a creation resumed after a timeout writes the
--       name it started with. `driver_name` stays the post's name — the one a
--       contact is FOUND by. NULL on older rows: they use `driver_name`.
--
--   hiring_stage_cards.aside_text / aside_keyboard   a second, smaller
--       question on the driver's card that stays while the stage question
--       changes: today only "✏️ Name in Bitrix: “No name” → “…”?".
--
--   hiring_stage_renames   offering to rename a placeholder deal ("No name",
--       empty, digits only), and what a person answered. A deal's TITLE (and a
--       placeholder contact's name) is written only after somebody presses
--       ✏️ Rename, by services/hiringStages/rename.js, after re-reading the
--       deal; who pressed and the outcome are kept here like a Move. Offered
--       once per conversation and deal; at most one open per conversation.
--
-- Rows carry a driver's name: deleted after 60 days with the captured
-- messages they came from (services/hiringStages/worker.js).

ALTER TABLE hiring_stage_crm_records
  ADD COLUMN IF NOT EXISTS display_name TEXT;

ALTER TABLE hiring_stage_cards
  ADD COLUMN IF NOT EXISTS aside_text TEXT;

ALTER TABLE hiring_stage_cards
  ADD COLUMN IF NOT EXISTS aside_keyboard JSONB;

CREATE TABLE IF NOT EXISTS hiring_stage_renames (
  id                  BIGSERIAL PRIMARY KEY,
  chat_id             TEXT NOT NULL,
  root_message_id     BIGINT NOT NULL,
  deal_id             BIGINT NOT NULL,
  category_id         TEXT,
  -- Bitrix's title as it was read, exactly (a press writes only while it still is).
  from_title          TEXT NOT NULL,
  to_name             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  contact_id          BIGINT,
  contact_renamed     BOOLEAN NOT NULL DEFAULT FALSE,
  -- This offer's TITLE write was confirmed (a later step of the press may still fail).
  title_written       BOOLEAN NOT NULL DEFAULT FALSE,
  bot_message_id      BIGINT,
  decided_by_user_id  BIGINT,
  decided_by_name     TEXT,
  decided_at          TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hiring_stage_renames_once UNIQUE (chat_id, root_message_id, deal_id),
  CONSTRAINT hiring_stage_renames_status CHECK (
    status IN ('pending', 'applying', 'applied', 'declined', 'stale', 'unsent')
  )
);

-- At most one open rename question per conversation (one card, one aside).
CREATE UNIQUE INDEX IF NOT EXISTS hiring_stage_renames_one_open
  ON hiring_stage_renames (chat_id, root_message_id)
  WHERE status IN ('pending', 'applying');
