-- TABLE: chat_logs
CREATE TABLE IF NOT EXISTS chat_logs (
  id SERIAL PRIMARY KEY,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  telegram_user_id BIGINT,
  telegram_message_id BIGINT,
  sender_name TEXT,
  message_text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE chat_logs ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;

-- TABLE: bot_sent_messages
-- Telegram forwards from ordinary groups do not reliably expose the original
-- message id. This registry lets the creator-only message manager resolve a
-- forwarded Wenze Feedback message by its original timestamp and content.
CREATE TABLE IF NOT EXISTS bot_sent_messages (
  id BIGSERIAL PRIMARY KEY,
  telegram_chat_id BIGINT NOT NULL,
  telegram_message_id BIGINT NOT NULL,
  sent_at TIMESTAMPTZ,
  message_text TEXT,
  content_kind TEXT NOT NULL DEFAULT 'other',
  source_method TEXT,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_chat_id, telegram_message_id)
);

-- Keeps the admin-supplied replacement text distinct from message_text so we
-- can show what the last edit set the message to, even if content_kind changes.
ALTER TABLE bot_sent_messages ADD COLUMN IF NOT EXISTS last_edit_text TEXT;

CREATE INDEX IF NOT EXISTS idx_bot_sent_messages_forward_lookup
  ON bot_sent_messages (sent_at DESC, telegram_chat_id)
  WHERE deleted_at IS NULL;

-- Newest-first admin listing / pagination of the whole registry.
CREATE INDEX IF NOT EXISTS idx_bot_sent_messages_recent
  ON bot_sent_messages (sent_at DESC NULLS LAST, id DESC);

-- group_pinned_messages (the latest pinned-message snapshot per driver group)
-- is no longer created: its only reader, the pinned-load reading behind the
-- ETA updates, /load and /status, was removed in October 2026
-- (docs/architecture/retired-dispatch-eta.md). A deployed database keeps the
-- table until an administrator drops it from Settings → Retired feature
-- leftovers. See 008_dispatch_eta_and_loads.sql.

-- Facebook Leads self-serve connect flow
