-- Migration 0076: hiring stage proposals — Bitrix deal stages, proposed from the recruiting group
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR.
--
-- In the recruiting group's General topic Safety and the recruiters talk each
-- candidate through: "CLH sent", "CLEAN", "Approved", "drug test all set".
-- The owner (20 October 2026) wants the bot to follow that conversation and,
-- when it shows a candidate has moved on, propose — with a button — moving
-- the candidate's Bitrix deal to that stage. Anyone in the group may confirm.
-- When no deal can be found, the bot asks the recruiter who posted the
-- candidate to create one.
--
-- A MODEL PROPOSES; A PERSON MOVES THE DEAL. Nothing changes in Bitrix until
-- somebody presses the button, and the deal is re-read at that moment: a deal
-- somebody moved by hand meanwhile is not moved again.
--
-- OFF BY DEFAULT (`stage_proposals_enabled`), and it needs Safety Approvals
-- switched on, because it reads the messages Safety Approvals captures.

ALTER TABLE safety_approval_settings
  ADD COLUMN IF NOT EXISTS stage_proposals_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per conversation (the candidate post every reply leads back to):
-- the queue the worker drains. Every new message in the conversation pushes
-- `due_at` out and bumps `revision`, so a burst of messages is read once.
CREATE TABLE IF NOT EXISTS hiring_stage_threads (
  id                BIGSERIAL PRIMARY KEY,
  chat_id           TEXT NOT NULL,
  root_message_id   BIGINT NOT NULL,
  -- The newest message in the conversation: the proposal replies to it.
  last_message_id   BIGINT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  due_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_until     TIMESTAMPTZ,
  revision          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  -- What the last read concluded (verified; never the raw model answer).
  outcome           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hiring_stage_threads_unique UNIQUE (chat_id, root_message_id),
  CONSTRAINT hiring_stage_threads_status CHECK (status IN ('pending', 'done', 'gave_up'))
);

CREATE INDEX IF NOT EXISTS hiring_stage_threads_due_idx
  ON hiring_stage_threads (due_at)
  WHERE status = 'pending';

-- What the bot proposed in the group, and what became of it.
--   kind 'move'        — "move <driver> to <stage>?" with Move / No buttons
--   kind 'create_deal' — no deal found; the recruiter is asked to create one,
--                        with a "search again" button
CREATE TABLE IF NOT EXISTS hiring_stage_proposals (
  id                  BIGSERIAL PRIMARY KEY,
  chat_id             TEXT NOT NULL,
  root_message_id     BIGINT NOT NULL,
  kind                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  driver_name         TEXT,
  driver_phone        TEXT,
  deal_id             BIGINT,
  deal_title          TEXT,
  category_id         TEXT,
  from_stage_id       TEXT,
  from_stage_name     TEXT,
  to_stage_id         TEXT NOT NULL,
  to_stage_name       TEXT NOT NULL,
  -- Words quoted verbatim from the conversation.
  evidence            TEXT,
  recruiter_user_id   BIGINT,
  recruiter_name      TEXT,
  bot_message_id      BIGINT,
  decided_by_user_id  BIGINT,
  decided_by_name     TEXT,
  decided_at          TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hiring_stage_proposals_kind CHECK (kind IN ('move', 'create_deal')),
  CONSTRAINT hiring_stage_proposals_status CHECK (
    status IN ('pending', 'applying', 'applied', 'declined', 'superseded', 'stale', 'unsent')
  )
);

-- At most one open proposal per conversation: a newer one supersedes it.
CREATE UNIQUE INDEX IF NOT EXISTS hiring_stage_proposals_one_open
  ON hiring_stage_proposals (chat_id, root_message_id)
  WHERE status IN ('pending', 'applying');

CREATE INDEX IF NOT EXISTS hiring_stage_proposals_root_idx
  ON hiring_stage_proposals (chat_id, root_message_id, created_at DESC);
