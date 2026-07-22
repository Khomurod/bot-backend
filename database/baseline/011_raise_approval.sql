-- Single-row settings for the raise-approval service.
CREATE TABLE IF NOT EXISTS raise_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  otp_channel TEXT NOT NULL DEFAULT 'gmail' CHECK (otp_channel IN ('gmail', 'ringcentral')),
  schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Default automatic schedule: Sunday (luxon weekday 7) 14:00 Central. The pay
  -- period reviewed is the Monday→Sunday week ending on that same Sunday.
  weekly_day_of_week INTEGER NOT NULL DEFAULT 7 CHECK (weekly_day_of_week BETWEEN 1 AND 7),
  weekly_time_local TEXT NOT NULL DEFAULT '14:00',
  schedule_timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  rate_low NUMERIC(5,3) NOT NULL DEFAULT 0.720,
  rate_high NUMERIC(5,3) NOT NULL DEFAULT 0.750,
  link_ttl_hours INTEGER NOT NULL DEFAULT 48 CHECK (link_ttl_hours BETWEEN 1 AND 720),
  -- Gmail App Password channel, entered in the admin panel. The address is
  -- stored as-is; the App Password is stored encrypted (same scheme as
  -- Facebook tokens — FACEBOOK_TOKEN_ENCRYPTION_KEY).
  gmail_user TEXT NULL,
  gmail_app_password_encrypted TEXT NULL,
  next_run_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE raise_settings ADD COLUMN IF NOT EXISTS gmail_user TEXT NULL;
ALTER TABLE raise_settings ADD COLUMN IF NOT EXISTS gmail_app_password_encrypted TEXT NULL;

INSERT INTO raise_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Move deployments that still hold the OLD seed default (Monday 09:00) to the
-- new default schedule of Sunday 14:00 Central. Guarded so an admin who has
-- deliberately picked a different day/time is never overwritten.
UPDATE raise_settings
   SET weekly_day_of_week = 7, weekly_time_local = '14:00'
 WHERE id = 1 AND weekly_day_of_week = 1 AND weekly_time_local = '09:00';

-- One approval round per pay period. The access_token backs the public
-- temporary link the dispatch team uses (modeled on facebook_connect_sessions).
CREATE TABLE IF NOT EXISTS raise_rounds (
  id SERIAL PRIMARY KEY,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  access_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  rate_low NUMERIC(5,3) NOT NULL DEFAULT 0.720,
  rate_high NUMERIC(5,3) NOT NULL DEFAULT 0.750,
  expires_at TIMESTAMPTZ NOT NULL,
  employee_chat_id TEXT NULL,
  employee_message_id BIGINT NULL,
  created_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_raise_rounds_status ON raise_rounds(status, created_at DESC);

-- One submission per team per round (the dispatcher's verified response).
CREATE TABLE IF NOT EXISTS raise_round_submissions (
  id SERIAL PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES raise_rounds(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES dispatch_teams(id) ON DELETE CASCADE,
  dispatcher_name TEXT NOT NULL,
  dispatcher_contact TEXT NOT NULL,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('email', 'phone')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, team_id)
);

-- Per-driver qualify / not-qualify decision within a submission.
CREATE TABLE IF NOT EXISTS raise_round_picks (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES raise_round_submissions(id) ON DELETE CASCADE,
  round_id INTEGER NOT NULL REFERENCES raise_rounds(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES dispatch_teams(id) ON DELETE CASCADE,
  driver_normalized_name TEXT NOT NULL,
  driver_name TEXT NOT NULL,
  qualified BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raise_round_picks_round ON raise_round_picks(round_id);

-- One-time passcodes for verifying a dispatcher before they submit. Codes are
-- stored hashed; never in plaintext.
CREATE TABLE IF NOT EXISTS raise_otp (
  id SERIAL PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES raise_rounds(id) ON DELETE CASCADE,
  team_id INTEGER NULL REFERENCES dispatch_teams(id) ON DELETE SET NULL,
  contact TEXT NOT NULL,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('email', 'phone')),
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raise_otp_lookup
  ON raise_otp(round_id, contact, created_at DESC);

-- ───────────────────────── Driver Home-Time Tracking ─────────────────────────
-- The bot reads each driver group's messages. The update specialist posts
-- "Status: Home" while a driver is home and "Status: Ready"/"Status: Rolling"
-- when they leave. Drivers get a set number of weeks on the road for free; each
-- FULL extra week earns a fixed bonus. The clock resets every time a driver goes
-- home. State is tracked per driver group; completed road trips are kept as a
-- history with the computed bonus.
