-- Migration 0017: operational_corrections — what was changed, why, and how to undo it
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: migration 0016 gave the system a way to SAY that two of its own facts
-- disagree. This is where it is allowed to DO something about it — and the whole
-- design is about making that safe to hand to software.
--
-- The rule that governs every row here: a correction may only be applied
-- automatically when the corrected value is ALREADY RECORDED SOMEWHERE ELSE in
-- this database. Nothing is inferred, nothing is averaged, nothing is guessed.
-- Closing a home-time cycle copies a timestamp that `driver_home_status` already
-- holds; syncing a driver's status copies a state Telegram itself reported. A
-- correction that would require judgement is not applied — it is proposed, and a
-- human decides.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY BOTH old_values AND new_values, IN FULL.
--
-- Reversal is a first-class code path, not a note in a runbook. Every action in
-- the registry declares `apply` AND `revert`, and revert works by re-applying
-- `old_values` through the same audited transaction. That only works if the
-- before-image is complete, so it is stored complete — not as a diff, and not as
-- a description.
--
-- A revert is itself an audited correction. The trail is append-only: nothing
-- here is ever rewritten to pretend a change did not happen.
-- ─────────────────────────────────────────────────────────────────────────
--
-- ALSO WRITTEN: admin_audit_log. Every applied correction inserts a mirroring
-- row through database/adminAudit.js in the SAME transaction, so there stays
-- exactly one place a human looks for "what changed, who did it, why" — and so
-- the correction inherits that module's recursive secret redactor for free. The
-- audit log had been write-only since it was created; this and the Operations
-- page finally give it a reader.

CREATE TABLE IF NOT EXISTS operational_corrections (
  id SERIAL PRIMARY KEY,

  -- The finding this answers. ON DELETE SET NULL rather than CASCADE: the
  -- record of a change that was actually made to the fleet must outlive the
  -- housekeeping of the finding that prompted it.
  finding_id INTEGER NULL REFERENCES operational_findings(id) ON DELETE SET NULL,

  -- Which registered action ran. The registry keys off this, and so does revert.
  action_key TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('auto', 'approval', 'warning')),

  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,

  -- The complete before and after images (see the note above), plus the rows
  -- this touched, so the Operations page can show blast radius without
  -- re-deriving it later from code that may have changed since.
  old_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  affected_records JSONB NOT NULL DEFAULT '[]'::jsonb,

  confidence SMALLINT NULL CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 100)),

  -- 'system' for an auto-applied Tier 1, 'admin:<id>' for a human. Never a model:
  -- AI may rank and explain a finding, never author or apply a correction.
  initiator TEXT NOT NULL,
  reason TEXT NULL,

  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  reverted_at TIMESTAMPTZ NULL,
  reverted_by TEXT NULL,
  revert_reason TEXT NULL,

  CONSTRAINT operational_corrections_subject_not_blank
    CHECK (btrim(action_key) <> '' AND btrim(subject_type) <> '' AND btrim(subject_id) <> ''),

  -- A system-applied correction is only ever Tier 1. The tiers are the safety
  -- model, so the database enforces the one that matters rather than trusting
  -- every future caller to remember it.
  CONSTRAINT operational_corrections_system_is_auto_only
    CHECK (initiator <> 'system' OR tier = 'auto'),

  -- A reversal records who and why, or it is not a reversal.
  CONSTRAINT operational_corrections_revert_is_attributed
    CHECK (reverted_at IS NULL OR btrim(COALESCE(reverted_by, '')) <> '')
);

-- The History tab: newest first, and the "is this still in effect?" filter.
CREATE INDEX IF NOT EXISTS idx_operational_corrections_applied
  ON operational_corrections (applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_operational_corrections_live
  ON operational_corrections (applied_at DESC) WHERE reverted_at IS NULL;

-- "What has been done about this finding?" and "what has been done to this
-- driver?" — the two questions an operator actually asks.
CREATE INDEX IF NOT EXISTS idx_operational_corrections_finding
  ON operational_corrections (finding_id);

CREATE INDEX IF NOT EXISTS idx_operational_corrections_subject
  ON operational_corrections (subject_type, subject_id, applied_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Per-check auto-apply permission.
--
-- Default DENY, and deliberately a row per check rather than one global switch:
-- "the system may close home-time cycles from recorded evidence" is a completely
-- different decision from "the system may change a driver's status", and one
-- switch would force an operator to accept both to get either.
--
-- No rows are seeded. A check with no row is disabled, so nothing auto-applies
-- until a human turns something on, and this migration cannot itself change a
-- single fleet record.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS operational_check_settings (
  check_key TEXT PRIMARY KEY,
  auto_apply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- A check that suddenly wants to change hundreds of rows has usually found a
  -- bug in itself, not hundreds of real problems. It stops and reports instead.
  max_auto_per_run SMALLINT NOT NULL DEFAULT 50
    CHECK (max_auto_per_run BETWEEN 1 AND 500),
  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
