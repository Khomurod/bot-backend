-- Migration 0034: what Wenze is allowed to tell a candidate, taught in plain
-- language and confirmed by a person
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THIS EXISTS.
--
-- The recruiting SMS today is a template with three placeholders — a rep name,
-- a company name and a position label. That is the entire vocabulary Wenze has
-- about the company's offer. Anything a candidate asks beyond it has to wait
-- for a recruiter.
--
-- For AI to answer at all it needs facts, and the only safe source of facts is
-- a person who typed them and confirmed them. So: an administrator writes a
-- sentence in ordinary language, Wenze restates what it believes should change,
-- and NOTHING takes effect until they agree.
--
-- THE TWO PROPERTIES THAT MATTER MOST.
--
-- Nothing is ever overwritten. A rate that changes from 70 to 77 cents produces
-- a NEW row and supersedes the old one; the old one stays, marked, with its
-- dates. "What were we telling candidates in August" is a question that gets
-- asked after a dispute, and a table that overwrites cannot answer it.
--
-- And a fact is not a rule. "Company driver pay is 77 CPM" is something to say;
-- "never tell candidates orientation is paid" is something not to say. They are
-- stored with the same lifecycle but a different `kind`, because a prompt has
-- to present them differently: one is material, the other is a boundary.

CREATE TABLE IF NOT EXISTS recruiting_knowledge (
  id BIGSERIAL PRIMARY KEY,

  -- `fact`       — something Wenze may tell a candidate.
  -- `boundary`   — something Wenze must NOT say, or must defer.
  -- `correction` — a fix to a specific mistake Wenze made, which outranks a
  --                general fact because it was written about a real failure.
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'boundary', 'correction')),

  -- A short grouping an administrator chooses, so the list stays readable as it
  -- grows: pay, equipment, home time, hiring requirements, benefits.
  topic TEXT NOT NULL,

  -- EXACTLY WHAT THE PERSON TYPED, never a model's rewording of it. The
  -- statement is what a human confirmed and what a dispute would be judged
  -- against; a paraphrase stored in its place would quietly become the record.
  statement TEXT NOT NULL,

  -- Wenze's reading of the statement, shown for confirmation and kept so a
  -- later misunderstanding can be traced to what it thought at the time.
  understood_as TEXT,

  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'active', 'superseded', 'rejected', 'retired')),

  -- NOTHING IS OVERWRITTEN. A changed fact points at what it replaced.
  supersedes_id BIGINT REFERENCES recruiting_knowledge(id) ON DELETE SET NULL,

  -- When it was true, so "what were we saying in August" is answerable.
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,

  proposed_by TEXT,
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  rejected_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- What the recruiting AI is allowed to read: active rows, newest first.
CREATE INDEX IF NOT EXISTS idx_recruiting_knowledge_active
  ON recruiting_knowledge (kind, topic, created_at DESC)
  WHERE status = 'active';

-- The admin list, including what is waiting for a decision.
CREATE INDEX IF NOT EXISTS idx_recruiting_knowledge_status
  ON recruiting_knowledge (status, created_at DESC);

-- The history of one fact.
CREATE INDEX IF NOT EXISTS idx_recruiting_knowledge_supersedes
  ON recruiting_knowledge (supersedes_id)
  WHERE supersedes_id IS NOT NULL;
