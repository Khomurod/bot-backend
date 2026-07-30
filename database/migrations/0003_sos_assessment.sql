-- Migration 0003: sos assessment
-- migrate:kind: schema
--
-- One-time QBQ / SOS ("Savol Ortidagi Savol") employee self-assessment for the
-- team-building event. Employees answer 10 department-specific questions on the
-- public /questions page; the /answers projector page shows anonymous
-- aggregates; a full-admin-only section shows individual submissions.
--
-- Design notes:
--   * Question/option/result TEXT lives in versioned code modules
--     (services/sosAssessment/content/), NOT in the database — a seed migration
--     for ~1,050 localized strings would be run-once and unfixable. The DB
--     stores stable keys plus a full scoring SNAPSHOT (per-answer pattern +
--     weight, aggregate pattern_scores, primary/secondary), so a stored result
--     can never change when content is edited. content_version records which
--     content revision scored the submission.
--   * These tables are deliberately separate from the existing Telegram driver
--     feedback survey (questions/options/responses) — do not merge them.
--   * dispatch_team_name is snapshotted so a later team rename/delete cannot
--     alter or orphan historical results (FK is ON DELETE SET NULL).
--   * result_token is an unguessable capability that lets an employee re-open
--     their own private result; it must never appear in public aggregates.
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.

-- Single-row open/closed switch (same shape as gmaps_settings and friends).
CREATE TABLE IF NOT EXISTS sos_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO sos_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sos_submissions (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  -- Normalized (lowercased, apostrophe-unified, punctuation-stripped) name used
  -- only for duplicate detection; display always uses full_name.
  name_normalized TEXT NOT NULL,
  department TEXT NOT NULL CHECK (department IN
    ('hr', 'safety', 'dispatch', 'trailer', 'samsara', 'accounting', 'updaters')),
  dispatch_team_id INTEGER NULL REFERENCES dispatch_teams(id) ON DELETE SET NULL,
  dispatch_team_name TEXT NULL,
  language TEXT NOT NULL CHECK (language IN ('uz', 'ru', 'en')),
  content_version INTEGER NOT NULL,
  pattern_scores JSONB NOT NULL,
  primary_pattern TEXT NOT NULL CHECK (primary_pattern IN
    ('victim', 'complaint', 'waiting', 'blame', 'ownership', 'builder')),
  secondary_pattern TEXT NULL CHECK (secondary_pattern IN
    ('victim', 'complaint', 'waiting', 'blame', 'ownership', 'builder')),
  result_token TEXT NOT NULL UNIQUE,
  duplicate_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  client_ip TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sos_submissions_dept
  ON sos_submissions (department);
CREATE INDEX IF NOT EXISTS idx_sos_submissions_name_dept
  ON sos_submissions (name_normalized, department);
CREATE INDEX IF NOT EXISTS idx_sos_submissions_team
  ON sos_submissions (dispatch_team_id) WHERE dispatch_team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sos_answers (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES sos_submissions(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  option_key TEXT NOT NULL,
  -- Pattern + weight snapshotted at submission time from the content module.
  pattern TEXT NOT NULL CHECK (pattern IN
    ('victim', 'complaint', 'waiting', 'blame', 'ownership', 'builder')),
  weight NUMERIC(4,2) NOT NULL DEFAULT 1,
  position SMALLINT NOT NULL,
  UNIQUE (submission_id, question_key)
);

CREATE INDEX IF NOT EXISTS idx_sos_answers_submission
  ON sos_answers (submission_id);
CREATE INDEX IF NOT EXISTS idx_sos_answers_question
  ON sos_answers (question_key, option_key);
