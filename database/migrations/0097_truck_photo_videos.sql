-- Migration 0097: truck photo reports — videos as links, and the count of them
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- THE OWNER, 6 November 2026: when a driver sends a VIDEO of the truck, the
-- hand-over PDF lists it with a link to the message in Telegram (the person
-- who gets the PDFs is in every driver group, so the link opens for them).
-- The video itself is never downloaded or stored — only its file id, its
-- length and the file id of the small preview Telegram makes for it, which is
-- drawn beside the link. docs/architecture/truck-photo-reports.md.
--
-- The buffer table keeps its name: it holds what was sent in a driver group
-- around a hand-over, and a video is now one kind of that.

ALTER TABLE driver_group_photos ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
ALTER TABLE driver_group_photos ADD COLUMN IF NOT EXISTS thumb_file_id TEXT;

-- Widened, not changed: every row that passed the old check passes this one.
ALTER TABLE driver_group_photos DROP CONSTRAINT IF EXISTS driver_group_photos_kind;
ALTER TABLE driver_group_photos
  ADD CONSTRAINT driver_group_photos_kind CHECK (kind IN ('photo', 'document', 'video'));

ALTER TABLE truck_photo_reports ADD COLUMN IF NOT EXISTS video_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE truck_photo_reports DROP CONSTRAINT IF EXISTS truck_photo_reports_video_count;
ALTER TABLE truck_photo_reports
  ADD CONSTRAINT truck_photo_reports_video_count CHECK (video_count >= 0);
