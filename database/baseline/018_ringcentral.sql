-- Single-row settings for the RingCentral integration + KPI targets/thresholds.
CREATE TABLE IF NOT EXISTS ringcentral_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  api_base TEXT NOT NULL DEFAULT 'https://platform.ringcentral.com',
  client_id_encrypted TEXT NULL,
  client_secret_encrypted TEXT NULL,
  jwt_token_encrypted TEXT NULL,
  -- How often the poller pulls the call log (minutes) and the day-boundary tz.
  poll_minutes INTEGER NOT NULL DEFAULT 10 CHECK (poll_minutes BETWEEN 1 AND 1440),
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  -- Conversation-quality thresholds (seconds). non_valuable_max_seconds is the
  -- minimum call duration counted toward real talk time: calls shorter than
  -- this do NOT count toward the main talk-time KPI (default 30s).
  non_valuable_max_seconds INTEGER NOT NULL DEFAULT 30,
  real_conversation_min_seconds INTEGER NOT NULL DEFAULT 60,
  strong_conversation_min_seconds INTEGER NOT NULL DEFAULT 180,
  -- Daily recruiter targets. Main KPI: 2h30m (9000s) of real call duration per
  -- day; secondary KPI: 150 outbound calls per day.
  target_talk_seconds INTEGER NOT NULL DEFAULT 9000,
  target_outbound INTEGER NOT NULL DEFAULT 150,
  target_real_conversations INTEGER NOT NULL DEFAULT 35,
  last_synced_at TIMESTAMPTZ NULL,
  last_sync_error TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ringcentral_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE ringcentral_settings
  ADD COLUMN IF NOT EXISTS target_talk_seconds INTEGER NOT NULL DEFAULT 9000;

-- One row per recruiter, with the single dedicated RingCentral direct number
-- (E.164) whose inbound/outbound calls roll up to them. Number is unique.
--
-- Credentials model: each number has its OWN RingCentral JWT token (JWTs are
-- per-user). The Client ID / Client Secret are usually shared across numbers
-- (one RC app) and come from ringcentral_settings; a recruiter row may override
-- them with its own pair when a number lives under a different RC app. All
-- three are stored encrypted (AES-256-GCM, same scheme as the other secrets).
-- When a recruiter has a JWT, the sync reads that user's OWN extension call
-- log (direct attribution); without one it falls back to company-log matching.
CREATE TABLE IF NOT EXISTS recruiters (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  -- Digits-only form of phone_number for tolerant matching against call legs.
  phone_number_normalized TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  jwt_token_encrypted TEXT NULL,
  client_id_encrypted TEXT NULL,
  client_secret_encrypted TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS jwt_token_encrypted TEXT NULL;
ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS client_id_encrypted TEXT NULL;
ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS client_secret_encrypted TEXT NULL;

-- Raw call-log records, deduped by the RingCentral record id. Kept so KPIs are
-- always recomputable; each poll upserts (a call's duration/result may finalize
-- after it first appears). recruiter_id is nulled if the recruiter is removed.
CREATE TABLE IF NOT EXISTS ringcentral_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NULL,
  recruiter_id INTEGER NULL REFERENCES recruiters(id) ON DELETE SET NULL,
  recruiter_number_normalized TEXT NULL,
  direction TEXT NULL,               -- Inbound | Outbound
  result TEXT NULL,                  -- Accepted | Missed | Voicemail | ...
  from_number TEXT NULL,
  to_number TEXT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  call_time TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ringcentral_calls_recruiter_time
  ON ringcentral_calls(recruiter_id, call_time DESC);
CREATE INDEX IF NOT EXISTS idx_ringcentral_calls_time
  ON ringcentral_calls(call_time DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Route Control + Google Maps Platform.
--
-- A dispatcher assigns a Google Maps directions link to a driver group; the bot
-- computes/stores the route geometry (Google Routes API) and periodically checks
-- the driver's live GPS against it, warning the driver group when they drift off
-- the planned route. All Google API calls are server-side; the API key is stored
-- encrypted (AES-256-GCM, same scheme as the other credentials) and never
-- returned to the frontend. The feature is OFF until an admin enables it and
-- enters a key in Settings → GMaps.
