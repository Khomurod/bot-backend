-- Migration 0113: safety approval question
-- migrate:kind: schema
--
-- ONE QUESTION PER SAFETY MESSAGE, AND IT GOES AWAY WHEN IT IS ANSWERED
-- (owner, 28 November 2026). On 27 November Aubrey Davis wrote "but we can
-- hire him", then within a minute edited it to "... ANTHONY MARTEZ JOHNSON
-- #Approved" — and the bot asked her two different questions about the one
-- message. The bot now waits a few minutes before it asks, never asks twice
-- about the same message, and deletes its question when the message turns
-- out to be clear after all. That needs to remember the question it sent.
--
--   safety_approval_reviews.question_message_id   the bot's question about
--                                                 this Safety message, in
--                                                 the group; NULL when none
--
-- Additive and idempotent.

ALTER TABLE safety_approval_reviews ADD COLUMN IF NOT EXISTS question_message_id BIGINT;

COMMENT ON COLUMN safety_approval_reviews.question_message_id IS
  'The bot''s one question to Safety about this message; deleted (and cleared) once the message is clear.';
