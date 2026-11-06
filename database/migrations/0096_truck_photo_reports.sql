-- Migration 0096: truck photo reports — the hand-over / return photos, as a PDF to one person
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR (the owner, 6 November 2026). In a driver's group the
-- driver or a fleet manager sends photos of the truck when it is handed over
-- or returned, and somebody writes `outbound` (hand-over) or `inbound`
-- (return). Wenze puts those photos into a PDF and sends it to ONE person,
-- privately. Nothing is ever written in the driver's group; the bot only sets
-- a 👍 reaction on the word once the PDF was delivered.
-- docs/architecture/truck-photo-reports.md.
--
-- OFF BY DEFAULT, AND IT CANNOT BE SWITCHED ON WITHOUT A RECIPIENT THE BOT HAS
-- REACHED. `enabled` is FALSE; the CHECK below refuses TRUE unless a recipient
-- is saved AND a test message reached them (`recipient_verified_at`). A
-- Telegram user who never pressed Start on the bot cannot be messaged at all,
-- and a switch that turns on to send PDFs nobody receives is worse than off.
--
-- THE BOT CANNOT READ A CHAT'S HISTORY, so the photos are remembered as they
-- arrive — Telegram FILE IDS ONLY, never bytes (the database's monthly
-- transfer allowance, docs/brief/database-transfer.md). The buffer is deleted
-- after 30 days by the hourly data-retention pass. The PDFs are NOT stored
-- anywhere: they are built in memory, sent, and dropped; what stays is the
-- record that one was sent.

CREATE TABLE IF NOT EXISTS truck_photo_settings (
  id                     SMALLINT PRIMARY KEY DEFAULT 1,
  enabled                BOOLEAN NOT NULL DEFAULT FALSE,
  -- The one person the PDFs go to: a Telegram USER id (positive), not a group.
  recipient_telegram_id  BIGINT,
  -- When a test message last reached THIS recipient. Cleared when the
  -- recipient changes; the switch needs it.
  recipient_verified_at  TIMESTAMPTZ,
  lookback_hours         INTEGER NOT NULL DEFAULT 3,
  -- 60 photos at ~1600 px keep a part well under Telegram's 50 MB document cap.
  max_photos_per_pdf     INTEGER NOT NULL DEFAULT 60,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by             INTEGER,
  CONSTRAINT truck_photo_settings_singleton CHECK (id = 1),
  CONSTRAINT truck_photo_settings_lookback CHECK (lookback_hours BETWEEN 1 AND 24),
  CONSTRAINT truck_photo_settings_max_photos CHECK (max_photos_per_pdf BETWEEN 1 AND 60),
  CONSTRAINT truck_photo_settings_recipient CHECK (recipient_telegram_id IS NULL OR recipient_telegram_id > 0),
  CONSTRAINT truck_photo_settings_enable_needs_recipient CHECK (
    NOT enabled OR (recipient_telegram_id IS NOT NULL AND recipient_verified_at IS NOT NULL)
  )
);

INSERT INTO truck_photo_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One row per `outbound` / `inbound` message. The row is CLAIMED (status
-- `pending`) before anything is done: Telegram redelivers an update it thinks
-- was not handled, and a second claim of the same message is refused by the
-- UNIQUE constraint, so a redelivered word never makes a second PDF.
CREATE TABLE IF NOT EXISTS truck_photo_reports (
  id                  BIGSERIAL PRIMARY KEY,
  chat_id             BIGINT NOT NULL,
  -- The record outlives a group row, so the group goes to NULL rather than
  -- taking the record with it.
  group_id            INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  trigger_message_id  BIGINT NOT NULL,
  kind                TEXT NOT NULL,
  -- The Telegram user who wrote the word, and the name Telegram showed (the
  -- recipient is told who marked it, and so is Settings).
  triggered_by        BIGINT,
  triggered_by_name   TEXT,
  photo_count         INTEGER NOT NULL DEFAULT 0,
  excluded_count      INTEGER NOT NULL DEFAULT 0,
  parts               INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending',
  -- A fixed phrase saying why it did not become a PDF. Never message text.
  reason              TEXT,
  -- Written explicitly on every row: did a model's answer shape this report?
  ai_assisted         BOOLEAN NOT NULL,
  ai_provider         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at             TIMESTAMPTZ,
  CONSTRAINT truck_photo_reports_trigger_unique UNIQUE (chat_id, trigger_message_id),
  CONSTRAINT truck_photo_reports_kind CHECK (kind IN ('outbound', 'inbound')),
  CONSTRAINT truck_photo_reports_status CHECK (
    status IN ('pending', 'sent', 'failed', 'no_photos', 'not_a_handover', 'unclear')
  ),
  CONSTRAINT truck_photo_reports_counts CHECK (photo_count >= 0 AND excluded_count >= 0 AND parts >= 0)
);

-- "Outbound on <date>, <n> photos" on an inbound PDF: the group's last sent outbound.
CREATE INDEX IF NOT EXISTS truck_photo_reports_group_kind_idx
  ON truck_photo_reports (group_id, kind, created_at DESC);
-- The hourly sweep that finishes a claim a restarted process left behind.
CREATE INDEX IF NOT EXISTS truck_photo_reports_pending_idx
  ON truck_photo_reports (created_at)
  WHERE status = 'pending';

-- The photos sent in driver groups while the feature is on (a photo's largest
-- size, or a picture sent "as a file"). `report_id` is set once the photo went
-- out in a delivered PDF, so the next word does not send it again.
CREATE TABLE IF NOT EXISTS driver_group_photos (
  id               BIGSERIAL PRIMARY KEY,
  chat_id          BIGINT NOT NULL,
  group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  message_id       BIGINT NOT NULL,
  media_group_id   TEXT,
  from_user_id     BIGINT,
  -- The sender's name as Telegram showed it, for the photo's caption in the PDF.
  from_name        TEXT,
  file_id          TEXT NOT NULL,
  file_unique_id   TEXT,
  kind             TEXT NOT NULL,
  width            INTEGER,
  height           INTEGER,
  file_size        BIGINT,
  sent_at          TIMESTAMPTZ NOT NULL,
  report_id        BIGINT REFERENCES truck_photo_reports(id) ON DELETE SET NULL,
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT driver_group_photos_message_unique UNIQUE (chat_id, message_id),
  CONSTRAINT driver_group_photos_kind CHECK (kind IN ('photo', 'document'))
);

CREATE INDEX IF NOT EXISTS driver_group_photos_chat_sent_idx
  ON driver_group_photos (chat_id, sent_at);
