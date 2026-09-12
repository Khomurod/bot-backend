-- Migration 0050: what the owner has already told Wenze
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR.
--
-- B1 made a finding answerable. It did not make the answer LAST. A finding
-- dismissed on Monday is re-derived by the sweep on Tuesday, re-opened, and
-- asked again — so the owner answers the same question every week and the
-- channel becomes the thing they mute. This remembers.
--
-- THE THING IT MUST NOT BECOME: a way to switch a check off for ever. Two
-- design decisions stop that, and both are load-bearing.
--
--   `evidence_fingerprint` — the answer is bound to the CONDITION, not to the
--   finding. "He is a team driver, that is why the truck looks shared" answers
--   THAT situation; when the situation changes — a different truck, a different
--   holder — the fingerprint changes, the memory does not match, and Wenze
--   asks again. A memory keyed on the subject alone would silence a real new
--   problem about the same driver for ever.
--
--   A REMEMBERED "YES" IS NEVER RE-APPLIED. `answer_action` may be recorded as
--   `approve`, and the ask pass reads it as context and nothing more. Applying
--   a remembered approval automatically is autopilot through a side door: the
--   owner approved ONE case, not a standing permission, and standing
--   permissions live in `operational_check_settings.mode` where they can be
--   seen and switched off. Only `dismiss` and `snooze` act from memory.

CREATE TABLE IF NOT EXISTS control_knowledge (
  id SERIAL PRIMARY KEY,

  -- WHAT the answer is about. One memory per condition, which is why the
  -- unique key is these three and not the finding id: a finding is re-created
  -- with a new id every time the condition re-appears, and a memory keyed on it
  -- would never match twice.
  check_key TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,

  -- WHAT was answered. `answer_action` is from the same closed set a reply may
  -- choose; `answer_text` is the owner's own words, which is what a person
  -- reading this later actually needs.
  answer_action TEXT NOT NULL,
  answer_text TEXT NULL,

  -- THE CONDITION THIS ANSWERS, hashed. See the header.
  evidence_fingerprint TEXT NOT NULL,

  confirmed_by TEXT NULL,
  reply_id INTEGER NULL,
  times_applied INTEGER NOT NULL DEFAULT 0,
  last_applied_at TIMESTAMPTZ NULL,

  -- A memory may be given an end, and may be taken back. Neither is required:
  -- most answers are simply true until the situation changes.
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_by TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT control_knowledge_once UNIQUE (check_key, subject_type, subject_id),
  CONSTRAINT control_knowledge_action_check CHECK (answer_action IN ('approve', 'dismiss', 'snooze')),
  CONSTRAINT control_knowledge_text_len CHECK (answer_text IS NULL OR length(answer_text) <= 1000)
);

-- "What do we already know about this condition" — the ask pass's read, on
-- every candidate, every pass.
CREATE INDEX IF NOT EXISTS idx_control_knowledge_live
  ON control_knowledge (check_key, subject_type, subject_id)
  WHERE revoked_at IS NULL;

-- The admin's list: what Wenze is currently remembering, most recent first.
CREATE INDEX IF NOT EXISTS idx_control_knowledge_recent
  ON control_knowledge (created_at DESC);

-- ── how many times a clarification has been asked ────────────────────────────
--
-- B1 asks "why?" once after a bare "no" and then takes the default. Counting
-- that on the notice means a clarification that is itself unanswered does not
-- start a third round on the next pass.
ALTER TABLE operational_notifications
  ADD COLUMN IF NOT EXISTS parent_notice_id BIGINT NULL;
ALTER TABLE operational_notifications
  ADD COLUMN IF NOT EXISTS clarify_round SMALLINT NOT NULL DEFAULT 0;

COMMENT ON TABLE control_knowledge IS
  'What the owner has already told Wenze about a condition. Bound to the CONDITION by evidence_fingerprint, not to a finding id — when the situation changes, Wenze asks again. A remembered approve is never re-applied.';
COMMENT ON COLUMN control_knowledge.evidence_fingerprint IS
  'Hash of the fields that define this condition. A changed condition does not match, and is asked about again.';
