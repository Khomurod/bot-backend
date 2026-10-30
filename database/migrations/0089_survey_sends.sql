-- Migration 0089: survey sends
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.

--
-- WHAT THIS IS FOR. Messages → Surveys can now create and send a survey
-- (until the October 2026 audit the tab was read-only). A saved survey and a
-- sent one looked identical, and nothing told a person that the one they were
-- about to send to every active driver group had already gone out. These two
-- columns remember the LAST send: when, and to how many groups it was
-- delivered. Additive and nullable: a survey from before this migration has
-- NULL, and the screen reads one that has answers as "Sent earlier" (it must
-- have gone out to be answered) and one without as "Not sent yet".

ALTER TABLE questions ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS last_sent_groups INTEGER;
