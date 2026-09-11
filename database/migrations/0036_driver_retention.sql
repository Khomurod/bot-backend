-- Migration 0036: what Wenze believes about the risk of losing a driver, and
-- when it last said so
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY A TABLE AT ALL.
--
-- The assessment itself is computed from other tables every pass and could be
-- thrown away. Three things need it kept:
--
--   Saying it once. A driver five weeks past the allowance is five weeks past
--   the allowance on every sweep, and a notice every fifteen minutes is how a
--   channel becomes unread.
--
--   Saying it AGAIN when it gets worse. A score that climbs from 4 to 9 is news
--   even though the driver was already flagged, and "was it worse than last
--   time" cannot be answered without last time.
--
--   Showing it. An operator asking "who is at risk" wants a list, not a
--   fifteen-minute-old Telegram message they have to scroll for.
--
-- WHAT THIS TABLE IS NOT, and the constraint is written into the schema rather
-- than left to good intentions:
--
-- IT IS NOT A PERFORMANCE RECORD. Every signal Wenze scores is something the
-- COMPANY did — a home window promised and missed, a bonus earned and unpaid,
-- weeks past the allowance — or something the DRIVER SAID in their own words.
-- Nothing here records a judgement about how somebody does their job, and
-- `lib/retention/signals.js` has no vocabulary for one. A schema that allowed
-- it would eventually be filled with it.

CREATE TABLE IF NOT EXISTS driver_retention_assessments (
  id BIGSERIAL PRIMARY KEY,

  -- The person where one is known; the chat otherwise. Both are kept because a
  -- driver who changes truck keeps their person id and loses their group id,
  -- and the whole point of the identity layer is that the history follows them.
  person_id BIGINT,
  group_id INTEGER,
  driver_name TEXT,

  score INTEGER NOT NULL DEFAULT 0,
  level TEXT NOT NULL DEFAULT 'none' CHECK (level IN ('none', 'watch', 'urgent')),

  -- The signals as they were at the time, so a notice can be explained months
  -- later without recomputing from tables that have since changed. chat_logs
  -- is pruned at 30 days, so for message-derived signals this row is the ONLY
  -- surviving record of why something was said.
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- What was actually announced, and at what score. The gap between `score`
  -- and `notified_score` is what decides whether it is worth saying again.
  notified_at TIMESTAMPTZ,
  notified_score INTEGER,

  -- An operator saying "yes, we know, we are on it". Suppresses notices for
  -- this driver until the score rises again past the acknowledged level.
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open assessment per driver. Two partial indexes rather than one
-- composite: a person and a group are alternative identities here, not a pair,
-- and a driver with no person yet must still get exactly one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_retention_person
  ON driver_retention_assessments (person_id)
  WHERE person_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_retention_group
  ON driver_retention_assessments (group_id)
  WHERE person_id IS NULL AND group_id IS NOT NULL;

-- The list an operator reads: worst first, and only the ones that matter.
CREATE INDEX IF NOT EXISTS idx_driver_retention_level
  ON driver_retention_assessments (level, score DESC, last_seen_at DESC)
  WHERE level <> 'none';

-- The one sentence at the top of a retention notice is a responsibility an
-- administrator can switch off, like every other. It changes no state: the
-- drivers flagged and the reasons given are identical with it off.
INSERT INTO ai_capabilities (capability_key, label, sends_raw_text, has_deterministic_fallback)
VALUES (
  'retention_summary',
  'Retention — summarise why a driver may be at risk',
  FALSE,
  TRUE
)
ON CONFLICT (capability_key) DO NOTHING;
