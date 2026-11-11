-- Migration 0102: board bitrix advice and responders
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- BOARD ↔ BITRIX QUESTIONS THAT SAY WHAT TO DO (owner, 11 November 2026).
--
-- 1. `board_bitrix_settings.responder_ids` — the Telegram user ids, typed in
--    Settings → Dispatcher Board, of the people whose replies ("done",
--    "skip", their own words) and button presses count, beside the control
--    channel's operators. Before this only the owner counted, so a teammate's
--    "skip" was silently ignored.
-- 2. `board_bitrix_discrepancies.advice_json` — the recommendation shown under
--    the question and the actions its buttons stand for, kept so a press
--    means exactly the action that was shown.
-- 3. `operational_notifications.reply_markup_json` — buttons a notice carries
--    other than the control channel's Yes / No / Later.

ALTER TABLE board_bitrix_settings
  ADD COLUMN IF NOT EXISTS responder_ids BIGINT[] NOT NULL DEFAULT '{}';

ALTER TABLE board_bitrix_discrepancies
  ADD COLUMN IF NOT EXISTS advice_json JSONB;

ALTER TABLE operational_notifications
  ADD COLUMN IF NOT EXISTS reply_markup_json JSONB;
