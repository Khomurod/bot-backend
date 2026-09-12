-- Migration 0053: the documents attached to a finance message, and one queue
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR.
--
-- Migration 0052 captured what the finance group SAYS. A good part of what it
-- says is an attachment: a receipt, an invoice, a screenshot of a transfer. The
-- text beside one is often just "here" — so a ledger that only reads text has a
-- hole exactly where the evidence is.
--
-- THIS TABLE IS A QUEUE, AND THE QUEUE IS WHY THE COLUMNS LOOK LIKE THIS.
-- `status`, `attempt_count`, `next_attempt_at`, `processing_started_at` and
-- `last_error` are the repository's proven durable-job shape (see
-- database/facebookLeads/webhookEvents.js and
-- database/homeTimeInternalAlertOutbox.js): a row is claimed with FOR UPDATE
-- SKIP LOCKED, attempts are incremented AT CLAIM TIME so a crash loop stays
-- bounded, and a failure carries an exact next-due timestamp rather than being
-- re-polled.
--
-- `needs_review` AND `failed` ARE DIFFERENT ANSWERS AND MUST NOT BE MERGED.
--   failed        — Wenze could not GET the document (download error, timeout).
--                   Retrying is sensible, so it has a backoff and a cap.
--   needs_review  — Wenze got it and could not read it well enough for a person
--                   to rely on. Retrying the same bytes through the same reader
--                   is pointless; a PERSON is what it needs.
-- Collapsing them would either retry a scan forever or give up on a network
-- blip. `review_reason` says which kind of unreadable it was.
--
-- AI BEING UNAVAILABLE IS `needs_review`, NEVER `failed`. A provider outage is
-- not the document's fault and must not consume the retry budget; the document
-- is intact, it simply has not been read, and a person can still open it.
--
-- NOTHING HERE HOLDS THE FILE. Only Telegram's `file_id` / `file_unique_id` and
-- what was read out of it. `file_id` is per-bot and reissuable; `file_unique_id`
-- identifies the same file forever, which is why the uniqueness key uses it.
-- The download URL Telegram hands back EMBEDS THE BOT TOKEN — it is never
-- stored, never logged, and there is deliberately no column it could go in.

CREATE TABLE IF NOT EXISTS finance_documents (
  id                    BIGSERIAL PRIMARY KEY,
  message_ref_id        BIGINT NOT NULL REFERENCES finance_messages(id) ON DELETE CASCADE,
  chat_id               TEXT NOT NULL,
  message_id            BIGINT NOT NULL,
  kind                  TEXT NOT NULL,
  file_id               TEXT NOT NULL,
  file_unique_id        TEXT NOT NULL,
  mime_type             TEXT,
  file_name             TEXT,
  -- What TELEGRAM said the size is, before anything is fetched. The size gate
  -- reads this so an oversized file is refused without downloading it.
  file_size             BIGINT,
  caption               TEXT,
  media_group_id        TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,
  last_error            TEXT,
  read_method           TEXT,
  text_chars            INTEGER,
  extracted             JSONB,
  review_reason         TEXT,
  ai_provider           TEXT,
  ai_model              TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT finance_documents_once UNIQUE (chat_id, message_id, file_unique_id),
  CONSTRAINT finance_documents_kind CHECK (kind IN ('document', 'photo')),
  CONSTRAINT finance_documents_status CHECK (
    status IN ('pending', 'processing', 'read', 'needs_review', 'failed',
               'skipped_too_large', 'skipped_unsupported')
  ),
  CONSTRAINT finance_documents_read_method CHECK (
    read_method IS NULL OR read_method IN ('pdf_text', 'ai_vision', 'pdf_text_ai')
  ),
  CONSTRAINT finance_documents_attempts CHECK (attempt_count >= 0)
);

-- The claim query: the oldest thing that is due. Partial, because `read` and
-- the two `skipped_*` states are terminal and are the bulk of the table.
CREATE INDEX IF NOT EXISTS idx_finance_documents_due
  ON finance_documents (next_attempt_at, id)
  WHERE status IN ('pending', 'failed');

-- "What still needs a person", which is both the admin list and the reason a
-- notice was sent.
CREATE INDEX IF NOT EXISTS idx_finance_documents_status
  ON finance_documents (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_finance_documents_message
  ON finance_documents (message_ref_id);
