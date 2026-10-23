-- Migration 0083: ai lessons
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. The owner, 23 October 2026: when the models are still not
-- sure after Claude has looked (services/ai/escalation.js), Wenze asks the
-- owner in the system-notifications group — in English, ONE question at a
-- time, answered in plain words, no buttons — and learns from the answer.
-- Accounting's reason for "Not charging" a home-time violation is learned from
-- too. See docs/architecture/ai-learning.md.
--
-- Two tables and one switch:
--
--   ai_learning_questions   the queue. One question per (capability, subject):
--                           the same Safety reply, the same candidate thread or
--                           the same driver message is never asked twice.
--                           Only one is ever `asked` and unanswered at a time.
--   ai_lessons              what was learned. `statement` is the person's own
--                           words and is what later prompts are given;
--                           `understood_as` is only Wenze's restatement, shown
--                           back to the owner and on the admin screen.
--                           Removed from the admin, never deleted:
--                           `removed_at` is set and the row stays.
--   ai_settings.learning_enabled   Settings → AI, "Ask me when unsure".

CREATE TABLE IF NOT EXISTS ai_learning_questions (
  id BIGSERIAL PRIMARY KEY,
  capability TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  -- What the owner is shown: a short, phone-masked excerpt and the question.
  context TEXT NOT NULL,
  ask TEXT NOT NULL,
  confidence SMALLINT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'asked', 'answered', 'skipped')),
  asked_at TIMESTAMPTZ NULL,
  answered_at TIMESTAMPTZ NULL,
  answer_text TEXT NULL,
  answered_by_telegram_id BIGINT NULL,
  lesson_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_ai_learning_question_subject UNIQUE (capability, subject_key)
);

-- The ask pass reads "is one out?" and "the oldest waiting" on every run.
CREATE INDEX IF NOT EXISTS idx_ai_learning_questions_status
  ON ai_learning_questions (status, created_at);

CREATE TABLE IF NOT EXISTS ai_lessons (
  id BIGSERIAL PRIMARY KEY,
  -- Which readers are given it: home_time, safety, hiring, … (lib/ai/lessons.js).
  scope TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('owner_answer', 'accounting_reason')),
  -- What the question was about, so a later prompt knows when the lesson applies.
  about TEXT NOT NULL,
  -- The person's own words. THIS is what prompts are given.
  statement TEXT NOT NULL,
  -- Wenze's restatement, for the owner to check. Never given to a prompt.
  understood_as TEXT NULL,
  question_id BIGINT NULL REFERENCES ai_learning_questions(id) ON DELETE SET NULL,
  created_by_telegram_id BIGINT NULL,
  created_by_name TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ NULL,
  removed_by TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_lessons_scope_active
  ON ai_lessons (scope, created_at DESC) WHERE removed_at IS NULL;

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS learning_enabled BOOLEAN NOT NULL DEFAULT TRUE;
