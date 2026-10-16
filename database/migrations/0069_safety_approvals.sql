-- Migration 0069: safety approvals — Safety's hire decisions, read from the recruiting group
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR.
--
-- In the recruiting group, a recruiter posts a driver candidate (CDL photos,
-- medical card, name, phone) and Safety answers by REPLYING to that post, with
-- the PSP / MVR / CLH reports and a word like "we can hire him". The owner
-- (16 October 2026) wants each decision posted, on its own, in the group's
-- "approved / not approved" topic: the CDL, the reports, name, phone, status.
--
-- OFF BY DEFAULT, AND OFF MEANS OFF. `enabled` is FALSE and `chat_id` NULL
-- until an administrator validates the group, names the topic and picks who
-- Safety is, in Settings. Nothing is read from any chat before that.
--
-- ONLY THE PEOPLE NAMED AS SAFETY CAN DECIDE (`safety_user_ids`). A recruiter
-- asking "can we hire him?" is a question, and it never becomes "approved".
--
-- CAPTURE FIRST. `safety_approval_messages.text` is what was written, verbatim.
-- What a model made of a Safety reply lives in `safety_approval_reviews.outcome`
-- BESIDE it, and only a verified decision ever produces an announcement.
-- An unclear reply is recorded as `unclear` and posts nothing.
--
-- NO FILE IS STORED. Photos and documents are kept as Telegram file ids, which
-- only this bot can use; the bytes stay in Telegram.

CREATE TABLE IF NOT EXISTS safety_approval_settings (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  chat_id            TEXT,
  chat_title         TEXT,
  chat_validated_at  TIMESTAMPTZ,
  -- The forum topic decisions are posted to (Telegram message_thread_id).
  topic_id           INTEGER,
  -- Telegram user ids of the people whose replies count as Safety's decision.
  safety_user_ids    BIGINT[] NOT NULL DEFAULT '{}',
  enabled_at         TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         INTEGER,
  CONSTRAINT safety_approval_settings_singleton CHECK (id = 1),
  CONSTRAINT safety_approval_settings_topic CHECK (topic_id IS NULL OR topic_id > 0)
);

INSERT INTO safety_approval_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS safety_approval_messages (
  id                   BIGSERIAL PRIMARY KEY,
  chat_id              TEXT NOT NULL,
  message_id           BIGINT NOT NULL,
  thread_id            INTEGER,
  media_group_id       TEXT,
  from_user_id         BIGINT,
  from_name            TEXT,
  -- The record: text or caption, verbatim.
  text                 TEXT,
  -- [{file_id, file_unique_id, width, height, file_size}] — the largest size only.
  photos               JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{file_id, file_unique_id, file_name, mime_type, file_size}]
  documents            JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_to_message_id  BIGINT,
  sent_at              TIMESTAMPTZ,
  edited_at            TIMESTAMPTZ,
  captured_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT safety_approval_messages_unique UNIQUE (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS safety_approval_messages_media_group_idx
  ON safety_approval_messages (chat_id, media_group_id)
  WHERE media_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS safety_approval_messages_reply_idx
  ON safety_approval_messages (chat_id, reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS safety_approval_messages_captured_idx
  ON safety_approval_messages (captured_at);

-- One row per Safety reply (a message, or an album of them): the queue the
-- worker drains, and afterwards what it concluded.
CREATE TABLE IF NOT EXISTS safety_approval_reviews (
  id                BIGSERIAL PRIMARY KEY,
  chat_id           TEXT NOT NULL,
  -- 'album:<media_group_id>' or 'message:<message_id>'.
  safety_key        TEXT NOT NULL,
  safety_user_id    BIGINT,
  -- The recruiter's message Safety replied to.
  post_message_id   BIGINT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  due_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A worker's lease while it reads and posts; a crashed worker's row comes back.
  claimed_until     TIMESTAMPTZ,
  -- Bumped by every new or edited Safety message. A worker finishes a row only
  -- at the revision it claimed, so a reply edited mid-read is read again.
  revision          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  -- The verified reading: which candidates, which decisions. Never the raw answer.
  outcome           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT safety_approval_reviews_unique UNIQUE (chat_id, safety_key),
  CONSTRAINT safety_approval_reviews_status CHECK (
    status IN ('pending', 'published', 'unclear', 'no_post', 'gave_up')
  )
);

CREATE INDEX IF NOT EXISTS safety_approval_reviews_due_idx
  ON safety_approval_reviews (due_at)
  WHERE status = 'pending';

-- What was posted in the topic, per driver, so the same decision is never
-- posted twice and a reversed one is.
CREATE TABLE IF NOT EXISTS safety_approval_announcements (
  id                 BIGSERIAL PRIMARY KEY,
  chat_id            TEXT NOT NULL,
  post_message_id    BIGINT NOT NULL,
  driver_key         TEXT NOT NULL,
  driver_name        TEXT NOT NULL,
  decision           TEXT NOT NULL,
  review_id          BIGINT REFERENCES safety_approval_reviews(id) ON DELETE SET NULL,
  topic_message_ids  BIGINT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT safety_approval_announcements_decision CHECK (decision IN ('approved', 'not_approved'))
);

CREATE INDEX IF NOT EXISTS safety_approval_announcements_post_idx
  ON safety_approval_announcements (chat_id, post_message_id, driver_key, created_at DESC);
