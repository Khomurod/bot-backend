-- ─────────────────────────────────────────────────────────────────────────
-- SAFETY-EVENT VIDEO MUSIC OVERLAY (driver-group speeding videos)
--
-- Context: the standalone samsara-integration poller sends speeding/safety-event
-- dashcam clips to TWO destinations:
--   (A) the fixed "Samsara Notifications" group + subscribers — MUST stay
--       immediate and UNCHANGED (original video, no processing);
--   (B) the matched driver Telegram group — the ONLY copy that may have
--       background music embedded.
-- These tables configure that behaviour and durably store the music.
--
-- Why BYTEA (not a Telegram file_id or object storage): the admin/hub
-- (bot-backend) and the samsara-integration poller are SEPARATE processes that
-- send as DIFFERENT Telegram bots, and Telegram file_ids are bot-scoped (not
-- portable across bots). This app has no object-storage backend. The shared
-- Postgres DB is the one durable artifact both processes can read, and the music
-- is a single short clip (a few MB), so BYTEA is safe and simple here. The table
-- also carries storage_kind/storage_path so a future move to filesystem/object
-- storage needs no schema change.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS safety_event_music_assets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes >= 0),
  -- Playback length in seconds; NULL when it could not be probed at upload time
  -- (the samsara side re-probes with ffprobe before use when NULL).
  duration_seconds NUMERIC(10,3) NULL
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  storage_kind TEXT NOT NULL DEFAULT 'db_bytea'
    CHECK (storage_kind IN ('db_bytea', 'filesystem', 'object_storage')),
  file_data BYTEA NULL,          -- populated only when storage_kind = 'db_bytea'
  storage_path TEXT NULL,        -- populated for filesystem / object_storage
  checksum_sha256 TEXT NULL,     -- integrity + dedupe hint
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_by TEXT NULL,         -- admin username that uploaded it
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Guardrail: at most one active music asset at any time. Application logic
-- deactivates the previous asset in the same transaction before activating a new
-- one, so this partial unique index simply enforces that invariant in the DB.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_safety_event_music_active
  ON safety_event_music_assets (is_active) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_safety_event_music_created
  ON safety_event_music_assets(created_at DESC);

-- Single-row settings for the driver-group music overlay.
CREATE TABLE IF NOT EXISTS safety_event_video_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Master switch: does the DRIVER group receive music-overlaid videos at all?
  driver_group_music_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Apply music specifically to SPEEDING-event driver videos (the current scope).
  speeding_music_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Which music asset to embed. NULL => overlay disabled (nothing to embed).
  active_music_asset_id INTEGER NULL
    REFERENCES safety_event_music_assets(id) ON DELETE SET NULL,
  -- Documents intent: the Samsara notifications group ALWAYS gets the original,
  -- unprocessed video. Kept TRUE; the code never overlays the notifications
  -- group regardless of this value (it exists so the invariant is visible/audit-
  -- able in the settings row).
  samsara_notification_group_original_video_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Background-music volume multiplier (0.0 silent .. 2.0 boost).
  music_volume NUMERIC(4,2) NOT NULL DEFAULT 0.35
    CHECK (music_volume >= 0 AND music_volume <= 2),
  -- When TRUE and the source video has its own audio, MIX music under the
  -- original audio; when FALSE, REPLACE the original audio with music.
  preserve_original_audio BOOLEAN NOT NULL DEFAULT TRUE,
  -- Fades applied to the music track (seconds).
  fade_in_seconds NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (fade_in_seconds >= 0 AND fade_in_seconds <= 60),
  fade_out_seconds NUMERIC(5,2) NOT NULL DEFAULT 1.50
    CHECK (fade_out_seconds >= 0 AND fade_out_seconds <= 60),
  -- When the video is LONGER than the music: loop the music to fill (TRUE) or
  -- play it once and leave the tail silent (FALSE).
  loop_music_when_video_longer BOOLEAN NOT NULL DEFAULT TRUE,
  -- Safety cap: never process a video longer than this many seconds (fall back
  -- to the original instead). 0 disables the cap.
  max_video_seconds INTEGER NOT NULL DEFAULT 120
    CHECK (max_video_seconds >= 0 AND max_video_seconds <= 3600),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO safety_event_video_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Optional observability ledger for driver-group music-overlay jobs. Written by
-- the samsara-integration poller (best-effort; never blocks delivery). Rows track
-- one overlay attempt per driver-group send. NEVER store signed media URLs here —
-- only an opaque/masked reference.
CREATE TABLE IF NOT EXISTS safety_event_video_jobs (
  id BIGSERIAL PRIMARY KEY,
  samsara_event_id TEXT NULL,
  telegram_group_id BIGINT NULL,        -- driver group chat id
  music_asset_id INTEGER NULL
    REFERENCES safety_event_music_assets(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','sent','compressed_sent','failed','fallback_sent','skipped','failed_too_large')),
  video_source TEXT NULL
    CHECK (video_source IS NULL OR video_source IN ('immediate','backfill')),
  video_reference TEXT NULL,            -- MASKED/opaque ref (never a signed URL)
  video_duration_seconds NUMERIC(10,3) NULL,
  music_trim_mode TEXT NULL
    CHECK (music_trim_mode IS NULL OR music_trim_mode IN ('trim','loop','once')),
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_safety_event_video_jobs_event
  ON safety_event_video_jobs(samsara_event_id);
CREATE INDEX IF NOT EXISTS idx_safety_event_video_jobs_status_created
  ON safety_event_video_jobs(status, created_at DESC);

-- Additive migration for DBs created before the telegram-size compression
-- statuses existed: widen the status CHECK to allow 'compressed_sent' (overlay
-- output was re-encoded under Telegram's 50MB cap) and 'failed_too_large'
-- (even the original exceeds the cap — delivery falls back to text).
ALTER TABLE safety_event_video_jobs
  DROP CONSTRAINT IF EXISTS safety_event_video_jobs_status_check;
ALTER TABLE safety_event_video_jobs
  ADD CONSTRAINT safety_event_video_jobs_status_check
  CHECK (status IN ('pending','processing','sent','compressed_sent','failed','fallback_sent','skipped','failed_too_large'));

-- ═══════════════════════════════════════════════════════════════════════════
-- TRAILER TRACKING (Beta)
-- ═══════════════════════════════════════════════════════════════════════════
-- Additive-only. The bot watches driver Telegram groups for trailer pickup /
-- drop-off messages, registers an immutable event per Telegram message, and
-- keeps a per-trailer "current status" row so map/list APIs stay fast. Admins
-- can also import a trailer master list from a screenshot (OCR/vision) and edit
-- records by hand. Nothing here references or revives BOL/POD monitoring.
