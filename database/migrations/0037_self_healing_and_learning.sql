-- Migration 0037: whether each part of Wenze is working, and what it has been
-- corrected about
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THE FIRST TABLE EXISTS, and what it is NOT.
--
-- It is not a recovery mechanism. Wenze already recovers from most of its own
-- integration failures and always has: RingCentral refresh tokens are rotated
-- daily and at boot, an AI provider in cooldown returns on its own timer, a
-- retired model is dropped and the next promoted, the durable outboxes back off
-- and retry.
--
-- Every one of those recoveries is SILENT. So "Wenze fixed itself" and "Wenze
-- has been broken for three days" look identical from outside — and the second
-- one is the reason the first is worth saying out loud.
--
-- What was missing is the NOTICING, and the whole difficulty of the noticing is
-- saying it rarely enough to be read. That is `announced_status`: not what is
-- true now, but what the people reading were last told, which is what every
-- suppression rule is decided against.
--
-- WHY THE SECOND TABLE EXISTS.
--
-- The only feedback this application collects about its own mistakes is a human
-- UNDOING something — reverting a correction, answering a candidate themselves.
-- Three reverts of the same action in a fortnight is the point at which "this
-- check is wrong" becomes more likely than "those three rows were unusual".
--
-- AND NOTHING IT PRODUCES TAKES EFFECT. A suggestion is a sentence for a person
-- to agree with; `status` starts at 'proposed' and only an administrator moves
-- it. Important business rules must not change permanently without somebody
-- confirming, and the cheapest way to keep that true is to give the machine no
-- column to write the change into.

CREATE TABLE IF NOT EXISTS system_health_states (
  -- A stable name for one thing that can be working or not: 'ringcentral',
  -- 'samsara', 'ai_providers', 'telegram'. Chosen by the observer, not derived
  -- from a message, so a reworded error cannot fork one component into two.
  component TEXT PRIMARY KEY,

  status TEXT CHECK (status IN ('ok', 'failed')),
  since TIMESTAMPTZ,

  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_ok INTEGER NOT NULL DEFAULT 0,

  -- WHAT THE READERS WERE LAST TOLD, which is a different thing from what is
  -- true. A recovery is announced only where a failure was, so a blip that
  -- self-corrects inside the threshold produces zero messages rather than one.
  announced_status TEXT,

  last_error TEXT,

  -- Recent state changes, for the flapping rule. Bounded in JavaScript so a
  -- long-lived row cannot grow without limit.
  transitions JSONB NOT NULL DEFAULT '[]'::jsonb,
  flapping_since TIMESTAMPTZ,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS operational_learning_suggestions (
  id BIGSERIAL PRIMARY KEY,

  -- 'reverted_correction' | 'recruiting_refusal'
  kind TEXT NOT NULL,
  -- What it is about: an action_key, or a refusal reason. With `kind` it is the
  -- dedup key, so a pattern that persists updates one row rather than filing a
  -- new suggestion every pass.
  subject_id TEXT NOT NULL,

  title TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- 'proposed' until a person decides. There is deliberately no status that
  -- means "applied automatically", because nothing here can apply anything.
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'dismissed')),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,

  notified_at TIMESTAMPTZ,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_suggestion_subject
  ON operational_learning_suggestions (kind, subject_id);

CREATE INDEX IF NOT EXISTS idx_learning_suggestion_open
  ON operational_learning_suggestions (last_seen_at DESC)
  WHERE status = 'proposed';
