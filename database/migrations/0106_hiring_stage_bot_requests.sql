-- Migration 0106: hiring stage bot requests
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- ASKING THE BOT FOR A LEAD (owner, 13–14 November 2026). The bot sometimes
-- missed a lead in the recruiting group: a deal was created only after a
-- model verified a stage move, a post nobody had answered was never queued,
-- and a post sent while the bot was down was never captured. Now ANY person
-- in the group may reply to the lead's post with a message that mentions the
-- bot; the post is read in its CURRENT (edited) version and, when Bitrix has
-- no deal, the contact and deal are created — see
-- services/hiringStages/requestQueue.js and requested.js.
--
--   hiring_stage_threads.requested_at / requested_by_user_id /
--   requested_by_name   the FIRST person who asked (kept on a later tag), for
--       the card ("Requested by …") and Monitoring → Logs.
--   hiring_stage_threads.request_message_id   the newest tagging message —
--       the one the bot reacts on (👀, then 👍 or 🤷).
--
--   safety_approval_messages.recovered_from_reply   a post the bot never saw
--       (it was down), rebuilt from the `reply_to_message` Telegram sends in
--       full with the tag; TRUE only while no real capture of it has arrived.
--   safety_approval_messages.bot_request   the message mentions the bot: it is
--       a request, never data — no stage read, name, phone or evidence is ever
--       taken from it.
--
-- All columns are new and nullable or defaulted: nothing existing changes.
-- Thread rows and captured messages are deleted after 60 days, as before.

ALTER TABLE hiring_stage_threads
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ;

ALTER TABLE hiring_stage_threads
  ADD COLUMN IF NOT EXISTS requested_by_user_id BIGINT;

ALTER TABLE hiring_stage_threads
  ADD COLUMN IF NOT EXISTS requested_by_name TEXT;

ALTER TABLE hiring_stage_threads
  ADD COLUMN IF NOT EXISTS request_message_id BIGINT;

ALTER TABLE safety_approval_messages
  ADD COLUMN IF NOT EXISTS recovered_from_reply BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE safety_approval_messages
  ADD COLUMN IF NOT EXISTS bot_request BOOLEAN NOT NULL DEFAULT FALSE;
