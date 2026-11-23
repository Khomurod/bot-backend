-- Migration 0109: truck photo corrections — a person replies to the PDF, Wenze rebuilds it
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- THE OWNER, 23 November 2026: the person who gets the hand-over PDFs (and the
-- people the owner lists in Settings → Truck Photos) may answer a PDF in their
-- own words — "the truck number is 027", "leave only the truck", "this is the
-- inbound" — and Wenze rebuilds it and sends it again, at once. Only a change
-- to the driver's PROFILE (its truck number) asks Yes / No first.
-- docs/architecture/truck-photo-reports.md, "Correcting a PDF".
--
-- Nothing here stores a PDF or a photo: the photos stay Telegram file ids in
-- `driver_group_photos` (deleted after 30 days), and a rebuild downloads them
-- again. What is new is what each version held, which message in the
-- recipient's chat is which PDF, and the corrections a person asked for.

-- Who besides the recipient may correct a PDF: Telegram USER ids, set by a
-- person in Settings → Truck Photos.
ALTER TABLE truck_photo_settings
  ADD COLUMN IF NOT EXISTS editor_telegram_ids BIGINT[] NOT NULL DEFAULT '{}';

-- A report's corrections: its version (1 = as first sent), what a person asked
-- for (`edits`: the truck number, the photos removed or put back, the time
-- window, the senders — never message text), and who asked last.
ALTER TABLE truck_photo_reports ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE truck_photo_reports ADD COLUMN IF NOT EXISTS edits JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE truck_photo_reports ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ;
ALTER TABLE truck_photo_reports ADD COLUMN IF NOT EXISTS corrected_by_name TEXT;
-- The time the photos were chosen from when the word was first read, so a
-- report with no PDF yet ("could not tell", nothing downloaded) can be rebuilt.
ALTER TABLE truck_photo_reports ADD COLUMN IF NOT EXISTS photos_from TIMESTAMPTZ;
ALTER TABLE truck_photo_reports ADD COLUMN IF NOT EXISTS photos_until TIMESTAMPTZ;

-- `cancelled`: a person said this word was not a hand-over at all. Widened, not
-- changed: every row that passed the old check passes this one.
ALTER TABLE truck_photo_reports DROP CONSTRAINT IF EXISTS truck_photo_reports_status;
ALTER TABLE truck_photo_reports
  ADD CONSTRAINT truck_photo_reports_status CHECK (
    status IN ('pending', 'sent', 'failed', 'no_photos', 'not_a_handover', 'unclear', 'cancelled')
  );
ALTER TABLE truck_photo_reports DROP CONSTRAINT IF EXISTS truck_photo_reports_version;
ALTER TABLE truck_photo_reports ADD CONSTRAINT truck_photo_reports_version CHECK (version >= 1);

-- Which message in the recipient's (or a corrector's) chat is which PDF — or
-- Wenze's question about one (`part` 0) — so a reply to it finds its report.
CREATE TABLE IF NOT EXISTS truck_photo_report_messages (
  chat_id     BIGINT NOT NULL,
  message_id  BIGINT NOT NULL,
  report_id   BIGINT NOT NULL REFERENCES truck_photo_reports(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  part        INTEGER NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, message_id),
  CONSTRAINT truck_photo_report_messages_part CHECK (part >= 0 AND version >= 1)
);

CREATE INDEX IF NOT EXISTS truck_photo_report_messages_report_idx
  ON truck_photo_report_messages (report_id, version DESC, part);

-- What each version of a report held: every photo or video considered, where
-- it went (the truck pages, the hand-over form, left out, the videos page), its
-- number in the PDF, and how the model sorted it — so "remove photos 11 to 38"
-- means the photos the person saw as 11 to 38, and a rebuild need not ask the
-- model again. Goes with the photo after 30 days (the buffer's retention).
CREATE TABLE IF NOT EXISTS truck_photo_report_items (
  report_id   BIGINT NOT NULL REFERENCES truck_photo_reports(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  photo_id    BIGINT NOT NULL REFERENCES driver_group_photos(id) ON DELETE CASCADE,
  place       TEXT NOT NULL,
  position    INTEGER,
  kind        TEXT,
  confidence  SMALLINT,
  PRIMARY KEY (report_id, version, photo_id),
  CONSTRAINT truck_photo_report_items_place CHECK (place IN ('truck', 'form', 'left_out', 'video'))
);

CREATE INDEX IF NOT EXISTS truck_photo_report_items_photo_idx
  ON truck_photo_report_items (photo_id);
