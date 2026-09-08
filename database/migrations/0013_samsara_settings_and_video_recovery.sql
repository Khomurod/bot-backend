-- Migration 0013: Samsara operational settings + durable missing-video recovery
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: the Samsara integration is configured in two unrelated ways. Its safety
-- event music lives in the admin panel (safety_event_video_settings), but the
-- API key, whether missing dashcam video is recovered at all, and how long to
-- wait before looking again are environment variables on a Render service the
-- operator would have to redeploy to change. Worse, the recovery itself was an
-- in-memory setTimeout in samsara-integration: a redeploy during the wait
-- silently dropped every pending video.
--
-- These two tables give Samsara the same home every other integration has —
-- one settings row the admin panel writes, and a durable job table the poller
-- works through — over the SHARED database the two services already use. No
-- new Render environment variable is required, and the environment stays a
-- fallback so the currently working key keeps working untouched.
--
-- ─────────────────────────────────────────────────────────────────────────
-- ABOUT api_key_encrypted. It is read by BOTH processes, and only one of them
-- has FACEBOOK_TOKEN_ENCRYPTION_KEY, so it cannot use lib/security/
-- facebookCrypto's key. It uses the same AES-256-GCM envelope with a key
-- derived from a secret both services already hold — see
-- lib/security/sharedIntegrationCrypto.js for exactly what and why.
-- api_key_fingerprint records WHICH derived key wrote the value, so a reader
-- that would fail to decrypt can say so and fall back to its environment
-- variable instead of losing Samsara. api_key_last4 exists so the admin panel
-- can mask a key it cannot decrypt rather than claiming none is set.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS samsara_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),

  -- ── Connection ──
  -- The one column with no environment counterpart, so a real default is safe:
  -- Samsara has always been on, and TRUE preserves that.
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  api_key_encrypted TEXT NULL,
  api_key_fingerprint TEXT NULL,
  api_key_last4 TEXT NULL,
  -- NULL inherits SAMSARA_API_BASE / the built-in default.
  api_base TEXT NULL,

  -- ─────────────────────────────────────────────────────────────────────
  -- EVERY OPERATIONAL COLUMN BELOW IS NULLABLE, AND NULL IS MEANINGFUL:
  -- "nothing saved in the panel — inherit the environment variable". The
  -- seeded row (below) therefore leaves them all NULL.
  --
  -- They must NOT carry SQL defaults. A seeded row full of defaults is
  -- indistinguishable from a row an administrator saved, so a database-wins
  -- reader could never honour the environment again — and this migration would
  -- silently overwrite a deployed SAMSARA_MAX_VIDEO_BYTES or
  -- SAMSARA_VIDEO_RETRY_DELAY_MS the moment it ran, before anyone opened the
  -- panel. The shipped defaults live in code instead
  -- (database/samsaraSettings.js DEFAULTS, mirrored in the poller's
  -- src/samsaraSettings.js), which is also the only place they can be kept in
  -- step between the two services.
  --
  -- Each CHECK admits NULL for the same reason.
  -- ─────────────────────────────────────────────────────────────────────

  -- ── Safety events ──
  -- NULL inherits SAMSARA_SPEEDING_ENABLED.
  speeding_events_enabled BOOLEAN NULL,
  -- Largest dashcam clip the poller will download before giving up on it.
  -- NULL inherits SAMSARA_MAX_VIDEO_BYTES.
  max_video_megabytes INTEGER NULL
    CHECK (max_video_megabytes IS NULL
       OR (max_video_megabytes >= 1 AND max_video_megabytes <= 200)),

  -- ── Missing-video recovery ──
  -- The master switch. FALSE means text-only alerts, never enriched.
  -- NULL inherits SAMSARA_VIDEO_RETRY_ENABLED.
  video_recovery_enabled BOOLEAN NULL,
  -- How long after the alert to re-read the event. The shipped default is 5
  -- minutes: the clip normally finishes uploading inside that window, and
  -- re-reading the event is far cheaper than asking the camera to produce one.
  -- NULL inherits SAMSARA_VIDEO_RETRY_DELAY_MS.
  video_recovery_initial_delay_seconds INTEGER NULL
    CHECK (video_recovery_initial_delay_seconds IS NULL
       OR (video_recovery_initial_delay_seconds >= 30
       AND video_recovery_initial_delay_seconds <= 86400)),
  -- Ask Samsara to RETRIEVE footage when the re-read still has none.
  video_retrieval_enabled BOOLEAN NULL,
  -- Spacing between subsequent checks, and how many of them before giving up.
  -- 12 × 5 minutes ≈ an hour of patience, spread wide enough to be gentle on
  -- the API.
  video_recovery_retry_interval_seconds INTEGER NULL
    CHECK (video_recovery_retry_interval_seconds IS NULL
       OR (video_recovery_retry_interval_seconds >= 30
       AND video_recovery_retry_interval_seconds <= 86400)),
  video_recovery_max_attempts INTEGER NULL
    CHECK (video_recovery_max_attempts IS NULL
       OR (video_recovery_max_attempts >= 1 AND video_recovery_max_attempts <= 200)),
  -- The window requested around the event. Samsara rejects a zero-length
  -- interval, and asking for minutes of footage per event is wasteful, so both
  -- ends are bounded and the pair must never collapse to a point.
  video_retrieval_window_before_seconds INTEGER NULL
    CHECK (video_retrieval_window_before_seconds IS NULL
       OR (video_retrieval_window_before_seconds >= 0
       AND video_retrieval_window_before_seconds <= 300)),
  video_retrieval_window_after_seconds INTEGER NULL
    CHECK (video_retrieval_window_after_seconds IS NULL
       OR (video_retrieval_window_after_seconds >= 5
       AND video_retrieval_window_after_seconds <= 300)),

  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seeded with EVERY operational column NULL, so the row's existence changes
-- nothing about a running deployment: each value still comes from the
-- environment until an administrator saves one.
INSERT INTO samsara_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE samsara_settings IS
  'Admin-managed Samsara operational settings, read by BOTH bot-backend and the samsara-integration poller over the shared database. A NULL column means "nothing saved — inherit the environment variable"; the shipped defaults live in code, not in SQL defaults.';

-- ─────────────────────────────────────────────────────────────────────────
-- DURABLE MISSING-VIDEO RECOVERY
--
-- One row per safety event that was alerted WITHOUT video. The poller works
-- the rows whose next_check_at has passed; a restart or redeploy loses
-- nothing, which is the whole point of the table.
--
-- `targets` is the list of Telegram messages that already carry this event's
-- text — {botKind, chatId, messageId, caption} — so the recovered video can be
-- folded into each one with its own original caption. It holds no signed media
-- URL and no credential, and neither does last_error.
--
-- `retrieval_id` is what stops a retry becoming a second retrieval request for
-- the same footage: once Samsara accepts one, later checks poll THAT request
-- instead of creating another.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS samsara_video_recovery_jobs (
  id BIGSERIAL PRIMARY KEY,
  -- One recovery per event, ever. The unique constraint is what makes
  -- "enqueue" idempotent for a re-delivered or re-driven event.
  samsara_event_id TEXT NOT NULL UNIQUE,
  vehicle_id TEXT NULL,
  event_time TIMESTAMPTZ NULL,
  is_speeding BOOLEAN NOT NULL DEFAULT FALSE,
  -- Enough of the raw event to resume without re-reading Samsara's list.
  raw_event JSONB NULL,
  targets JSONB NOT NULL DEFAULT '[]'::jsonb,

  status TEXT NOT NULL DEFAULT 'pending_recheck'
    CHECK (status IN (
      'pending_recheck',    -- waiting for the initial re-read of the event
      'pending_retrieval',  -- Samsara was asked for footage; waiting on it
      'video_available',    -- footage resolved; the Telegram fold-in is running,
                            -- or reached some destinations and not others
      'completed',          -- every target updated
      'no_video',           -- gave up: Samsara never produced a clip
      'failed'              -- gave up: repeated errors, see last_error
    )),
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,

  retrieval_id TEXT NULL,
  retrieval_requested_at TIMESTAMPTZ NULL,
  retrieval_start_time TIMESTAMPTZ NULL,
  retrieval_end_time TIMESTAMPTZ NULL,

  last_error TEXT NULL,
  -- Claim marker: a row a worker is currently processing. Cleared on release;
  -- a stale claim expires so a killed process cannot strand a job forever.
  locked_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL
);

-- The worker's only hot query: "what is due now?"
CREATE INDEX IF NOT EXISTS idx_samsara_video_recovery_due
  ON samsara_video_recovery_jobs (next_check_at)
  WHERE status IN ('pending_recheck', 'pending_retrieval', 'video_available');

CREATE INDEX IF NOT EXISTS idx_samsara_video_recovery_status_created
  ON samsara_video_recovery_jobs (status, created_at DESC);

COMMENT ON COLUMN samsara_video_recovery_jobs.targets IS
  'Telegram messages already carrying this event''s text: {botKind, chatId, messageId, caption}. Never a signed media URL.';
COMMENT ON COLUMN samsara_video_recovery_jobs.retrieval_id IS
  'The Samsara camera media retrieval this job is waiting on. Present means DO NOT create another for this event.';
