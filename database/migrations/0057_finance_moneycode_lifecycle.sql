-- Finance Monitor: a money code has a LIFE, not just an existence.
--
-- Version 1 of this feature could say a code had been seen. It could not say
-- the code had since been voided, replaced, or that nobody could tell which
-- code a "voided" message referred to. A finance total that cannot subtract a
-- voided code is a total that overstates what the company spent, and an
-- auditor's first question about any of it is "on what evidence" — so the
-- evidence is stored beside the state rather than inferred later from the chat.
--
-- NOTHING IS EVER DELETED HERE. A voided code keeps its digits, its amount, its
-- original message and its issue time; voiding adds a state and a pointer to
-- the message that caused it. History that erases itself is not history.
--
-- Additive and idempotent: every statement guards itself, so this runs on every
-- boot without doing anything twice and cannot fail a deploy.

-- ── the reply relationship, which is how a void names its target ────────────
-- Telegram tells us which message a reply is answering, and that is the single
-- strongest piece of evidence for "voided" meaning THIS code. It was never
-- captured, so the association had nothing to work from.
ALTER TABLE finance_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_finance_messages_reply
  ON finance_messages (chat_id, reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

-- Finding what the current parser has not read yet, cheaply.
CREATE INDEX IF NOT EXISTS idx_finance_messages_parser_version
  ON finance_messages (parser_version, id);

-- ONE MODEL ATTEMPT PER MESSAGE, EVER. The AI fallback is offered only to
-- messages the rules could not settle, and without a marker the background pass
-- would offer the same handful of unreadable messages to a model every hour for
-- the life of the table — cost with no new information. Stamped only when a
-- model actually answered, so an outage does not burn the attempt.
ALTER TABLE finance_messages
  ADD COLUMN IF NOT EXISTS ai_read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_finance_messages_awaiting_ai
  ON finance_messages (id)
  WHERE ai_read_at IS NULL AND parse_status IN ('unparsed', 'ambiguous');

-- The parser now distinguishes a completed void from a request for one, and
-- says when a reading needs a person. The old four statuses keep their meaning.
DO $$
BEGIN
  ALTER TABLE finance_messages DROP CONSTRAINT IF EXISTS finance_messages_parse_status;
  ALTER TABLE finance_messages ADD CONSTRAINT finance_messages_parse_status CHECK (
    parse_status IN (
      'parsed', 'ambiguous', 'unparsed', 'not_moneycode',
      'void_action', 'void_request', 'needs_review'
    )
  );
END $$;

-- ── the lifecycle itself ───────────────────────────────────────────────────
ALTER TABLE finance_moneycodes
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  -- WHICH MESSAGE VOIDED IT. Not a boolean: the question asked six weeks later
  -- is "who said so, and where", and a flag cannot answer it.
  ADD COLUMN IF NOT EXISTS void_message_ref_id BIGINT REFERENCES finance_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_evidence JSONB,
  ADD COLUMN IF NOT EXISTS void_confidence SMALLINT,
  -- Only ever set when a replacement is genuinely known. A code that merely
  -- came after another one is not its replacement.
  ADD COLUMN IF NOT EXISTS replaced_by_id BIGINT REFERENCES finance_moneycodes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_reason TEXT;

DO $$
BEGIN
  ALTER TABLE finance_moneycodes DROP CONSTRAINT IF EXISTS finance_moneycodes_status;
  ALTER TABLE finance_moneycodes ADD CONSTRAINT finance_moneycodes_status CHECK (
    status IN ('active', 'voided', 'replaced', 'needs_review', 'duplicate_posting')
  );

  -- A void must be able to say WHEN. A state with no timestamp cannot be
  -- reported on by period, and the weekly summary is reported by period.
  ALTER TABLE finance_moneycodes DROP CONSTRAINT IF EXISTS finance_moneycodes_voided_pair;
  ALTER TABLE finance_moneycodes ADD CONSTRAINT finance_moneycodes_voided_pair CHECK (
    (status <> 'voided') OR (voided_at IS NOT NULL)
  );

  -- A replacement points somewhere, or it is not a replacement.
  ALTER TABLE finance_moneycodes DROP CONSTRAINT IF EXISTS finance_moneycodes_replaced_pair;
  ALTER TABLE finance_moneycodes ADD CONSTRAINT finance_moneycodes_replaced_pair CHECK (
    (status <> 'replaced') OR (replaced_by_id IS NOT NULL)
  );

  ALTER TABLE finance_moneycodes DROP CONSTRAINT IF EXISTS finance_moneycodes_not_own_replacement;
  ALTER TABLE finance_moneycodes ADD CONSTRAINT finance_moneycodes_not_own_replacement CHECK (
    replaced_by_id IS NULL OR replaced_by_id <> id
  );

  ALTER TABLE finance_moneycodes DROP CONSTRAINT IF EXISTS finance_moneycodes_void_confidence;
  ALTER TABLE finance_moneycodes ADD CONSTRAINT finance_moneycodes_void_confidence CHECK (
    void_confidence IS NULL OR void_confidence BETWEEN 0 AND 100
  );
END $$;

-- ── what the new column means for rows that already exist ──────────────────
-- EVERY EXISTING ROW DEFAULTS TO `active`, INCLUDING THE REPEATS. A repeat was
-- already being recorded before this migration — `duplicate_reason` says
-- 'same_code' on those rows — and from now on a repeat is stored as
-- `duplicate_posting` so it stays out of the active total. Without this
-- backfill the two vocabularies would disagree on the very first deploy: new
-- repeats excluded, old ones counted, and the active total claiming the
-- company is out money for a code it was only ever told about twice.
--
-- Idempotent by the WHERE: after one run those rows are no longer 'active'.
-- It touches only rows the duplicate decision had ALREADY flagged; it never
-- decides that something is a repeat.
UPDATE finance_moneycodes
   SET status = 'duplicate_posting'
 WHERE duplicate_reason = 'same_code'
   AND status = 'active';

-- Active totals are read constantly and voided rows must never join them.
CREATE INDEX IF NOT EXISTS idx_finance_moneycodes_status
  ON finance_moneycodes (status, issued_at DESC);

-- Finding a code by its digits is how a void names its target.
CREATE INDEX IF NOT EXISTS idx_finance_moneycodes_code
  ON finance_moneycodes (code_normalized);

-- ── the audit trail ────────────────────────────────────────────────────────
-- Every state change, append-only, with what caused it. The row above holds
-- the CURRENT state; this holds how it got there. Keeping both means a
-- correction never destroys the reading it corrected.
CREATE TABLE IF NOT EXISTS finance_moneycode_events (
  id              BIGSERIAL PRIMARY KEY,
  moneycode_id    BIGINT NOT NULL REFERENCES finance_moneycodes(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  from_status     TEXT,
  to_status       TEXT,
  -- The finance message that justified it, when one did.
  message_ref_id  BIGINT REFERENCES finance_messages(id) ON DELETE SET NULL,
  -- `deterministic` | `ai` | `admin` — how the conclusion was reached, so a
  -- reading a model contributed to is never mistaken for one the rules made.
  decided_by      TEXT NOT NULL DEFAULT 'deterministic',
  confidence      SMALLINT,
  evidence        JSONB,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT finance_moneycode_events_kind CHECK (
    event IN ('issued', 'voided', 'replaced', 'needs_review', 'duplicate_posting',
              'reparsed', 'review_cleared')
  ),
  CONSTRAINT finance_moneycode_events_decided_by CHECK (
    decided_by IN ('deterministic', 'ai', 'admin')
  ),
  CONSTRAINT finance_moneycode_events_confidence CHECK (
    confidence IS NULL OR confidence BETWEEN 0 AND 100
  )
);

CREATE INDEX IF NOT EXISTS idx_finance_moneycode_events_code
  ON finance_moneycode_events (moneycode_id, created_at DESC);
