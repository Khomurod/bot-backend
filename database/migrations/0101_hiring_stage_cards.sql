-- Migration 0101: hiring stage cards
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- ONE CARD PER DRIVER (owner, 11 November 2026: "the bot must not spam the
-- group"). Everything the bot says about one candidate in the Bitrix topic is
-- ONE Telegram message: the driver's name and a link to the post, a short
-- history, and the question open now. A new question re-posts it at the bottom
-- (the old one is deleted); an answer edits it in place. This row is that
-- card: which message it is now, its history, and the question it shows.
--
-- The name is set once, from the post, so every line under it is about one
-- spelling of one driver. A driver's name: deleted after 60 days with the
-- captured messages (services/hiringStages/worker.js).

CREATE TABLE IF NOT EXISTS hiring_stage_cards (
  chat_id           TEXT NOT NULL,
  root_message_id   BIGINT NOT NULL,
  message_id        BIGINT,
  driver_name       TEXT,
  history           JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_text      TEXT,
  current_keyboard  JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hiring_stage_cards_pk PRIMARY KEY (chat_id, root_message_id)
);
