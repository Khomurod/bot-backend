-- Migration 0051: a code-level ask becomes a job for a person
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR.
--
-- B1 already recognises "this is a bug", "why are you even asking me this",
-- "stop doing that" — and then tells the owner plainly that nothing changed and
-- forgets. Which is honest, and useless: the complaint that most deserves to
-- reach a person is the one that says the software itself is wrong, and it was
-- the one thing the channel dropped on the floor.
--
-- THE LINE THIS TABLE IS DRAWN AROUND. The runtime bot never touches source
-- code. Not "is discouraged from"; cannot. An owner typing "just fix the code"
-- into a group chat produces a ROW HERE and nothing else — a sentence somebody
-- reads, decides on, and turns into a pull request by hand.
--
-- SO NO COLUMN IN THIS TABLE CAN HOLD CODE OR A FILE PATH. `request_text` is
-- what a person said, capped. `summary` is a person's own restatement.
-- `linked_reference` is a free-text pointer somebody writes afterwards — "PR
-- #231", "ticket 44" — and is never read by the application for anything. There
-- is deliberately no `patch`, no `diff`, no `file`, no `branch`. A schema with
-- nowhere to put a patch cannot be talked into applying one, and that is a
-- stronger guarantee than any amount of prose above it.
-- `tests/controlNoCodeAccess.test.js` asserts the absence structurally.

CREATE TABLE IF NOT EXISTS engineering_requests (
  id SERIAL PRIMARY KEY,

  -- WHERE IT CAME FROM. Only two things may file one: a reply in the
  -- notification group, or a person in the admin. Not a check, not a model.
  source TEXT NOT NULL,
  reply_id INTEGER NULL,
  finding_id INTEGER NULL,

  -- WHO asked. `telegram:<id>` or `admin:<id>`, the same vocabulary the
  -- correction journal uses, so one trail reads end to end.
  requested_by TEXT NULL,

  -- WHAT WAS SAID, in their words. Capped rather than refused: a complaint too
  -- long to store is still a complaint, and losing its tail beats losing it.
  request_text TEXT NOT NULL,

  -- A PERSON'S RESTATEMENT, written later in the admin. Null until somebody
  -- reads it — an empty summary is the honest state for an untriaged request.
  summary TEXT NULL,

  status TEXT NOT NULL DEFAULT 'open',

  -- Where the work ended up, as free text somebody types. Never parsed, never
  -- fetched, never executed. See the header.
  linked_reference TEXT NULL,

  decided_by TEXT NULL,
  decided_at TIMESTAMPTZ NULL,
  decision_note TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT engineering_requests_source_check
    CHECK (source IN ('control_reply', 'admin')),
  CONSTRAINT engineering_requests_status_check
    CHECK (status IN ('open', 'accepted', 'in_progress', 'done', 'declined')),
  CONSTRAINT engineering_requests_text_len
    CHECK (length(request_text) BETWEEN 1 AND 2000),
  CONSTRAINT engineering_requests_summary_len
    CHECK (summary IS NULL OR length(summary) <= 2000),
  CONSTRAINT engineering_requests_reference_len
    CHECK (linked_reference IS NULL OR length(linked_reference) <= 200)
);

-- ONE ROW PER REPLY. Telegram redelivers and the bot restarts several times a
-- day; without this a redelivered complaint becomes a second request and the
-- list grows copies of one sentence. Partial, because an admin-filed request
-- has no reply behind it.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_engineering_request_reply
  ON engineering_requests (reply_id)
  WHERE reply_id IS NOT NULL;

-- "What is still waiting for somebody" — the check's read, every sweep.
CREATE INDEX IF NOT EXISTS idx_engineering_requests_open
  ON engineering_requests (created_at DESC)
  WHERE status = 'open';

COMMENT ON TABLE engineering_requests IS
  'A code-level ask, recorded for a person to act on. NO COLUMN MAY HOLD CODE OR A FILE PATH: the runtime bot never edits source, and a schema with nowhere to put a patch cannot be talked into applying one. linked_reference is free text a human writes and the application never reads.';
COMMENT ON COLUMN engineering_requests.linked_reference IS
  'Free text a person types, such as "PR #231". Never parsed, fetched or executed.';
