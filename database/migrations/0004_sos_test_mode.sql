-- Migration 0004: sos test mode
-- migrate:kind: schema
--
-- Adds an isolated TEST mode to the QBQ/SOS assessment so the full flow can be
-- rehearsed on /questions/test and /answers/test before the real event without
-- touching real data.
--
--   * sos_submissions.is_test — FALSE = real production submission. The column
--     is added with NOT NULL DEFAULT FALSE, so every row that existed before
--     this migration is automatically classified as REAL, with no manual row
--     edits required after deployment.
--   * sos_settings.test_is_open — the open/closed switch for the TEST
--     questionnaire, independent of the real is_open switch, so closing or
--     opening one mode can never affect the other.
--
-- Every read/write in database/sosAssessment.js is scoped by is_test at the
-- SQL level (summaries, duplicate detection, result-token lookup, stats,
-- deletes and clears), so a frontend mistake cannot reach across modes.
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.

ALTER TABLE sos_submissions
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_sos_submissions_is_test
  ON sos_submissions (is_test);

ALTER TABLE sos_settings
  ADD COLUMN IF NOT EXISTS test_is_open BOOLEAN NOT NULL DEFAULT TRUE;
