-- Migration 0040: let an accepted suggestion actually change something, and
-- make it obvious when accepting it does not
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: "ACCEPTED" MEANT NOTHING, AND DID NOT SAY SO.
--
-- The learning pass proposes; an administrator marks a suggestion `accepted`;
-- and then nothing whatsoever happens. The route's own comment says so plainly
-- and treats it as the safety property. It is half of one: the guarantee worth
-- keeping is that AI cannot change a business rule by itself, and that is kept
-- by requiring a person's confirmation — not by making the confirmation inert.
--
-- As it stood, an administrator who accepted "switch automatic correction off
-- for this check" reasonably believed they had switched it off. They had
-- written a word in a table. The check kept correcting.
--
-- THE SPLIT THIS MIGRATION MAKES, and it is the whole point:
--
--   accepted_active     the suggestion named a CONFIGURABLE setting, the
--                       acceptance changed it, the old value is recorded, and
--                       one click puts it back
--   accepted_manual     the suggestion is a recommendation a person has to
--                       carry out — teach Wenze a fact, reword a boundary.
--                       Accepting it records agreement and NOTHING ELSE, and
--                       the screen says exactly that
--
-- A suggestion that cannot be represented as a configurable rule must never
-- pretend to have been learned. That is the difference between a system that
-- learns and one that files agreement.
--
-- WHAT MAY BE APPLIED IS DELIBERATELY TINY. `apply_action` is a key into a
-- registry in `services/operations/learningActions.js` which today holds ONE
-- action: turn a check's automatic correction off. Nothing in this schema or
-- that registry can change pay, employment status, hiring conditions, safety
-- discipline, or a line of application code, and a test asserts the registry
-- stays that way.

ALTER TABLE operational_learning_suggestions
  -- NULL means "there is nothing safe to apply" — the `accepted_manual` case.
  ADD COLUMN IF NOT EXISTS apply_action TEXT NULL,
  -- What the action needs. For the one action that exists: which check keys.
  ADD COLUMN IF NOT EXISTS apply_payload JSONB NULL,
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS applied_by TEXT NULL,
  -- THE OLD VALUES, so a revert restores what was actually there rather than a
  -- default somebody assumed. Without this the undo is a guess.
  ADD COLUMN IF NOT EXISTS applied_before JSONB NULL,
  ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS reverted_by TEXT NULL;

-- Widen the status vocabulary. The old 'accepted' stays legal so existing rows
-- remain valid — they are agreements recorded before anything could be applied,
-- and rewriting them would be inventing a history they do not have.
DO $$
DECLARE
  conname TEXT;
BEGIN
  SELECT c.conname INTO conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'operational_learning_suggestions'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%status%'
   LIMIT 1;
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE operational_learning_suggestions DROP CONSTRAINT %I', conname);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operational_learning_suggestions_status_check2'
  ) THEN
    ALTER TABLE operational_learning_suggestions
      ADD CONSTRAINT operational_learning_suggestions_status_check2
      CHECK (status IN (
        'proposed',
        'accepted',          -- legacy: agreed before anything could be applied
        'accepted_active',   -- agreed AND a setting was changed
        'accepted_manual',   -- agreed; a person still has to do it
        'dismissed',
        'reverted'
      ));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_learning_suggestion_applied
  ON operational_learning_suggestions (applied_at DESC) WHERE applied_at IS NOT NULL;
