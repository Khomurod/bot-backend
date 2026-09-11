-- Migration 0043: what Wenze decided, including every time it decided to do
-- nothing
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THIS EXISTS: THE RECORD STOPS AT THE THINGS THAT CHANGED.
--
-- `operational_corrections` is a good record of every change made, and it is
-- silent about every decision that made none. So the questions nobody can
-- answer today are the ones that matter most for trusting automation:
--
--   How often did it decide NOT to act, and was it right?
--   How often did it not know, and what was missing?
--   What WOULD it have done, if it had been allowed to?
--   When it did act, did the thing it predicted actually happen?
--
-- A system that only records its successes cannot learn, and cannot be audited
-- for restraint. Restraint is most of what this application does.
--
-- FOUR VERDICTS, AND `unknown` IS NOT LOW CONFIDENCE.
--
--   act      the evidence permits it and the mode allows it
--   suggest  the evidence permits it; a person must agree
--   hold     the evidence is against acting. A real answer
--   unknown  the evidence is MISSING. Not an answer at all
--
-- `hold` and `unknown` look identical in any system that models confidence as
-- one number: both come out low. They are opposites. "The truck is clearly
-- still at the shipper" and "nobody has heard from this truck since Tuesday"
-- call for different actions, and conflating them is how a stale feed becomes
-- an inactivity report.
--
-- WHY THIS TABLE IS BOUNDED, AND THE ARITHMETIC THAT FORCED IT.
--
-- A row per decision per pass was costed before it was written: the load watch
-- alone re-decides 235 loads every ten minutes, which is 33,840 rows a day, and
-- the whole set comes to about 44,000 a day — 16 million in a year, on free
-- infrastructure, to say the same thing over and over.
--
-- That is the mistake migration 0042 had just been written to undo one table
-- over, so it is not repeated here. The key is
-- (check_key, subject, verdict): the same verdict recurring updates ONE row and
-- counts itself, and only a CHANGE of verdict writes another. The ceiling is
-- about thirty-four checks times a few hundred subjects times four verdicts,
-- and the verdict changes — which are the learning signal — are all kept.

CREATE TABLE IF NOT EXISTS operational_decisions (
  id BIGSERIAL PRIMARY KEY,

  check_key TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  -- Who it is ABOUT, when it is about somebody. Nullable: most decisions are
  -- about a load or a truck. No name and no phone number — the person layer
  -- holds those and this table points at it.
  person_id BIGINT NULL,

  verdict TEXT NOT NULL,
  -- NULL when the verdict is `unknown`, and that is enforced below rather than
  -- left to callers: a confidence attached to "I do not know" is a number
  -- somebody will eventually compare against a threshold.
  confidence SMALLINT NULL CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 100)),

  -- The mode in force WHEN IT DECIDED, not the mode now. Reading a decision
  -- back through today's setting would rewrite history every time somebody
  -- changed a switch.
  mode TEXT NOT NULL DEFAULT 'suggest',
  -- Shadow is orthogonal to mode: the decision was reached and deliberately
  -- not carried out, so its `would_have` can be compared with what a person
  -- did instead.
  shadow BOOLEAN NOT NULL DEFAULT FALSE,

  -- In words, for a person. The evidence in machine form beside it.
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What it read and how much that was worth: [{source, at, fresh, agrees}].
  -- Freshness belongs HERE rather than being inferred later, because a source
  -- that was current when read and stale by the time somebody asks is not the
  -- same as one that was already stale.
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,

  action_key TEXT NULL,
  correction_id BIGINT NULL,
  -- Shadow mode's whole output: what it would have done, never done.
  would_have JSONB NULL,

  -- Filled later, by the verification pass rather than by the decider. A
  -- decision that graded its own homework would be worth nothing.
  outcome TEXT NULL,
  outcome_at TIMESTAMPTZ NULL,
  outcome_detail TEXT NULL,

  first_decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  times_decided INTEGER NOT NULL DEFAULT 1
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operational_decisions_verdict_check') THEN
    ALTER TABLE operational_decisions ADD CONSTRAINT operational_decisions_verdict_check
      CHECK (verdict IN ('act', 'suggest', 'hold', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operational_decisions_mode_check') THEN
    ALTER TABLE operational_decisions ADD CONSTRAINT operational_decisions_mode_check
      CHECK (mode IN ('observe', 'suggest', 'autopilot'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operational_decisions_outcome_check') THEN
    ALTER TABLE operational_decisions ADD CONSTRAINT operational_decisions_outcome_check
      CHECK (outcome IS NULL OR outcome IN
        ('confirmed', 'contradicted', 'reverted', 'expired', 'not_checked'));
  END IF;
  -- "I do not know" may not carry a confidence. Enforced in the schema because
  -- a caller that passes one is making a claim it cannot support, and every
  -- reader downstream would treat the number as meaningful.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operational_decisions_unknown_check') THEN
    ALTER TABLE operational_decisions ADD CONSTRAINT operational_decisions_unknown_check
      CHECK (verdict <> 'unknown' OR confidence IS NULL);
  END IF;
END$$;

-- THE KEY THAT BOUNDS THE TABLE. Same check, same subject, same verdict → one
-- row that counts itself. A different verdict is a different row, because a
-- load that flipped from `act` to `hold` five times is the single most useful
-- thing this table can tell anybody.
CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_decisions_subject_verdict
  ON operational_decisions (check_key, subject_type, subject_id, verdict);

-- "What has it been deciding lately", and the verification pass's queue.
CREATE INDEX IF NOT EXISTS idx_operational_decisions_recent
  ON operational_decisions (last_decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_decisions_unverified
  ON operational_decisions (last_decided_at) WHERE outcome IS NULL AND action_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operational_decisions_person
  ON operational_decisions (person_id) WHERE person_id IS NOT NULL;
