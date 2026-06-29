-- Telegram Driver Feedback System - Database Schema

-- TABLE: groups
CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  telegram_group_id BIGINT UNIQUE NOT NULL,
  group_name TEXT,
  language VARCHAR(5) DEFAULT 'en',
  group_type TEXT DEFAULT 'driver',
  created_at TIMESTAMP DEFAULT NOW()
);

-- TABLE: driver_profiles (future source of truth for driver identity fields)
CREATE TABLE IF NOT EXISTS driver_profiles (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  first_name TEXT,
  last_name TEXT,
  secondary_first_name TEXT,
  secondary_last_name TEXT,
  first_name_source TEXT,
  last_name_source TEXT,
  secondary_first_name_source TEXT,
  secondary_last_name_source TEXT,
  driver_type TEXT,
  driver_type_source TEXT,
  status TEXT DEFAULT 'active',
  unit_number TEXT,
  unit_number_source TEXT,
  language VARCHAR(5) DEFAULT 'en',
  date_of_birth DATE,
  date_of_start DATE,
  needs_review BOOLEAN DEFAULT FALSE,
  backfill_confidence SMALLINT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT driver_profiles_group_id_unique UNIQUE (group_id),
  CONSTRAINT driver_profiles_driver_type_check CHECK (
    driver_type IS NULL OR driver_type IN ('owner', 'company_driver')
  ),
  CONSTRAINT driver_profiles_status_check CHECK (
    status IN ('active', 'inactive')
  ),
  CONSTRAINT driver_profiles_language_check CHECK (
    language IN ('en', 'ru', 'uz')
  ),
  CONSTRAINT driver_profiles_backfill_confidence_check CHECK (
    backfill_confidence IS NULL OR (backfill_confidence >= 0 AND backfill_confidence <= 100)
  )
);

-- TABLE: drivers
CREATE TABLE IF NOT EXISTS drivers (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- TABLE: questions
CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMP DEFAULT NOW(),
  active BOOLEAN DEFAULT TRUE,
  media_position TEXT DEFAULT 'above'
);

-- TABLE: question_media (one row per uploaded file, per question)
CREATE TABLE IF NOT EXISTS question_media (
  id SERIAL PRIMARY KEY,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  media_type TEXT NOT NULL,  -- 'photo' | 'video'
  sort_order INTEGER DEFAULT 0
);

-- TABLE: question_translations
CREATE TABLE IF NOT EXISTS question_translations (
  id SERIAL PRIMARY KEY,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  language VARCHAR(5) NOT NULL,
  question_text TEXT NOT NULL,
  UNIQUE(question_id, language)
);

-- TABLE: options
CREATE TABLE IF NOT EXISTS options (
  id SERIAL PRIMARY KEY,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  option_order INTEGER NOT NULL
);

-- TABLE: option_translations
CREATE TABLE IF NOT EXISTS option_translations (
  id SERIAL PRIMARY KEY,
  option_id INTEGER REFERENCES options(id) ON DELETE CASCADE,
  language VARCHAR(5) NOT NULL,
  option_text TEXT NOT NULL,
  UNIQUE(option_id, language)
);

-- TABLE: responses
CREATE TABLE IF NOT EXISTS responses (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  option_id INTEGER REFERENCES options(id) ON DELETE CASCADE,
  answered_at TIMESTAMP DEFAULT NOW()
);

-- Prevent duplicate responses from the same driver for the same question
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_driver_question
  ON responses(driver_id, question_id);

-- TABLE: admins (for web panel authentication)
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─── Auto-migrations (safe to run every startup) ───
ALTER TABLE questions ADD COLUMN IF NOT EXISTS media_position TEXT DEFAULT 'above';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS group_type TEXT DEFAULT 'driver';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS driver_birthday DATE;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS samsara_vehicle_id TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS status_source TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP;
-- Bot visibility diagnostics: when the bot last RECEIVED any message from the
-- group (proves it can read it), and a cached snapshot of the bot's membership
-- role in the group (queried from Telegram on demand).
ALTER TABLE groups ADD COLUMN IF NOT EXISTS last_message_seen_at TIMESTAMPTZ;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS bot_member_status TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS bot_access_checked_at TIMESTAMPTZ;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS secondary_first_name TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS secondary_last_name TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS first_name_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS last_name_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS secondary_first_name_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS secondary_last_name_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS driver_type TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS driver_type_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS unit_number TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS unit_number_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS language VARCHAR(5) DEFAULT 'en';
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS date_of_start DATE;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT FALSE;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS backfill_confidence SMALLINT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'driver_profiles_driver_type_check'
      AND conrelid = 'driver_profiles'::regclass
  ) THEN
    ALTER TABLE driver_profiles
      ADD CONSTRAINT driver_profiles_driver_type_check
      CHECK (driver_type IS NULL OR driver_type IN ('owner', 'company_driver'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'driver_profiles_status_check'
      AND conrelid = 'driver_profiles'::regclass
  ) THEN
    ALTER TABLE driver_profiles
      ADD CONSTRAINT driver_profiles_status_check
      CHECK (status IN ('active', 'inactive'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'driver_profiles_language_check'
      AND conrelid = 'driver_profiles'::regclass
  ) THEN
    ALTER TABLE driver_profiles
      ADD CONSTRAINT driver_profiles_language_check
      CHECK (language IN ('en', 'ru', 'uz'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'driver_profiles_backfill_confidence_check'
      AND conrelid = 'driver_profiles'::regclass
  ) THEN
    ALTER TABLE driver_profiles
      ADD CONSTRAINT driver_profiles_backfill_confidence_check
      CHECK (backfill_confidence IS NULL OR (backfill_confidence >= 0 AND backfill_confidence <= 100));
  END IF;
END
$$;

-- ─── Employee Voting System (isolated) ───

CREATE TABLE IF NOT EXISTS employee_votes_polls (
  id SERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  telegram_message_id BIGINT,
  telegram_chat_id BIGINT,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS employee_votes_options (
  id SERIAL PRIMARY KEY,
  poll_id INTEGER REFERENCES employee_votes_polls(id) ON DELETE CASCADE,
  unit_number TEXT NOT NULL,
  driver_name TEXT,
  company_name TEXT,
  driver_type TEXT,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS employee_votes (
  id SERIAL PRIMARY KEY,
  poll_id INTEGER REFERENCES employee_votes_polls(id) ON DELETE CASCADE,
  option_id INTEGER REFERENCES employee_votes_options(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,
  telegram_username TEXT,
  telegram_first_name TEXT,
  unit_number TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(poll_id, telegram_user_id)
);

-- ─── Broadcast Tracking System ───

CREATE TABLE IF NOT EXISTS broadcasts (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'regular',
  message_text_en TEXT,
  message_text_ru TEXT,
  message_text_uz TEXT,
  media_items JSONB,
  media_position TEXT DEFAULT 'above',
  parse_mode TEXT DEFAULT 'HTML',
  buttons JSONB,
  target_type TEXT DEFAULT 'all',
  target_driver_ids INTEGER[],
  target_languages TEXT[],
  force_language TEXT,
  status TEXT DEFAULT 'sent',
  sent_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcast_deliveries (
  id SERIAL PRIMARY KEY,
  broadcast_id INTEGER REFERENCES broadcasts(id) ON DELETE CASCADE,
  group_id INTEGER,
  telegram_group_id BIGINT,
  group_name TEXT,
  status TEXT DEFAULT 'sent',
  error_message TEXT,
  sent_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcast_button_clicks (
  id SERIAL PRIMARY KEY,
  broadcast_id INTEGER REFERENCES broadcasts(id) ON DELETE CASCADE,
  button_index INTEGER NOT NULL,
  button_label TEXT,
  driver_telegram_id BIGINT NOT NULL,
  driver_username TEXT,
  driver_first_name TEXT,
  driver_last_name TEXT,
  group_telegram_id BIGINT,
  group_name TEXT,
  clicked_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(broadcast_id, button_index, driver_telegram_id)
);

-- ─── Scheduled Messaging System ───

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id SERIAL PRIMARY KEY,
  message_text_en TEXT,
  message_text_ru TEXT,
  message_text_uz TEXT,
  media_items JSONB,
  media_file_id TEXT,
  media_type TEXT,
  media_position TEXT DEFAULT 'above',
  target_type TEXT DEFAULT 'all',
  target_driver_ids INTEGER[],
  target_languages TEXT[],
  force_language TEXT,
  scheduled_at TIMESTAMP NOT NULL,
  schedule_type TEXT DEFAULT 'one_time',
  schedule_timezone TEXT DEFAULT 'America/Chicago',
  weekly_day_of_week SMALLINT,
  weekly_time_local TEXT,
  last_sent_at TIMESTAMP,
  last_run_status TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS media_items JSONB;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS schedule_type TEXT DEFAULT 'one_time';
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS schedule_timezone TEXT DEFAULT 'America/Chicago';
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS weekly_day_of_week SMALLINT;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS weekly_time_local TEXT;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMP;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS last_run_status TEXT;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS target_active_filter TEXT;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS target_active_filter TEXT;

UPDATE scheduled_messages
SET media_items = jsonb_build_array(
  jsonb_build_object(
    'file_id', media_file_id,
    'media_type', COALESCE(media_type, 'photo')
  )
)
WHERE media_items IS NULL
  AND media_file_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'scheduled_messages_status_check'
      AND table_name = 'scheduled_messages'
  ) THEN
    ALTER TABLE scheduled_messages DROP CONSTRAINT scheduled_messages_status_check;
  END IF;
END
$$;

ALTER TABLE scheduled_messages
  ADD CONSTRAINT scheduled_messages_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled'));

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

CREATE INDEX IF NOT EXISTS idx_bot_sent_messages_forward_lookup
  ON bot_sent_messages (sent_at DESC, telegram_chat_id)
  WHERE deleted_at IS NULL;

-- TABLE: group_pinned_messages
-- Stores the latest pinned-message snapshot we observed in updates for each
-- driver group, so ETA parsing can use the newest pin event reliably.
CREATE TABLE IF NOT EXISTS group_pinned_messages (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT NOT NULL,
  pinned_message_id BIGINT NOT NULL,
  pinned_message_json JSONB NOT NULL,
  source_event_message_id BIGINT,
  source_event_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Facebook Leads self-serve connect flow

CREATE TABLE IF NOT EXISTS facebook_connect_sessions (
  id SERIAL PRIMARY KEY,
  session_token TEXT NOT NULL UNIQUE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT NOT NULL,
  group_name TEXT,
  requested_by_telegram_user_id BIGINT,
  requested_by_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  oauth_state TEXT UNIQUE,
  oauth_user_access_token_encrypted TEXT,
  oauth_user_id TEXT,
  oauth_user_name TEXT,
  expires_at TIMESTAMP NOT NULL,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_facebook_connect_sessions_group
  ON facebook_connect_sessions (telegram_group_id, status);

CREATE INDEX IF NOT EXISTS idx_facebook_connect_sessions_expires
  ON facebook_connect_sessions (expires_at);

CREATE TABLE IF NOT EXISTS facebook_page_connections (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT NOT NULL,
  group_name TEXT,
  page_id TEXT NOT NULL UNIQUE,
  page_name TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  token_last4 TEXT,
  connected_by_facebook_user_id TEXT,
  connected_by_facebook_user_name TEXT,
  granted_tasks TEXT[] DEFAULT '{}',
  granted_scopes TEXT[] DEFAULT '{}',
  subscribed_fields TEXT[] DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_subscription_status TEXT,
  last_error TEXT,
  connected_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_facebook_page_connections_group
  ON facebook_page_connections (telegram_group_id, is_active);

CREATE TABLE IF NOT EXISTS facebook_webhook_events (
  id SERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  page_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_facebook_webhook_events_status_retry
  ON facebook_webhook_events (status, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS idx_facebook_webhook_events_page
  ON facebook_webhook_events (page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS facebook_seen_senders (
  page_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  first_event_key TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (page_id, sender_id)
);

-- Global Facebook lead auto-SMS templates (admin-managed)
CREATE TABLE IF NOT EXISTS facebook_lead_auto_message_settings (
  id SERIAL PRIMARY KEY,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rep_name TEXT NOT NULL DEFAULT 'Tom',
  company_name TEXT NOT NULL DEFAULT 'Wenze trucking company',
  position_label TEXT NOT NULL DEFAULT 'OTR position',
  fallback_template TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS facebook_lead_auto_message_rules (
  id SERIAL PRIMARY KEY,
  settings_id INTEGER NOT NULL REFERENCES facebook_lead_auto_message_settings(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Rule',
  days_of_week SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  start_time_local TIME NOT NULL,
  end_time_local TIME NOT NULL,
  message_template TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_facebook_lead_auto_message_rules_settings
  ON facebook_lead_auto_message_rules (settings_id, sort_order, id);

-- Outbound auto-SMS mirrors in Wenze Facebook Leads (Telegram reply → RingCentral)
CREATE TABLE IF NOT EXISTS facebook_lead_sms_mirrors (
  id SERIAL PRIMARY KEY,
  telegram_chat_id BIGINT NOT NULL,
  telegram_message_id BIGINT NOT NULL,
  driver_phone TEXT NOT NULL,
  sms_body TEXT NOT NULL,
  lead_name TEXT,
  page_id TEXT,
  rule_label TEXT,
  ringcentral_message_id TEXT,
  source_type TEXT NOT NULL DEFAULT 'outbound_auto',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (telegram_chat_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS idx_facebook_lead_sms_mirrors_lookup
  ON facebook_lead_sms_mirrors (telegram_chat_id, telegram_message_id);

ALTER TABLE facebook_lead_sms_mirrors
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'outbound_auto';

ALTER TABLE group_pinned_messages ADD COLUMN IF NOT EXISTS group_id INTEGER;
ALTER TABLE group_pinned_messages ADD COLUMN IF NOT EXISTS telegram_group_id BIGINT;
ALTER TABLE group_pinned_messages ADD COLUMN IF NOT EXISTS pinned_message_id BIGINT;
ALTER TABLE group_pinned_messages ADD COLUMN IF NOT EXISTS pinned_message_json JSONB;
ALTER TABLE group_pinned_messages ADD COLUMN IF NOT EXISTS source_event_message_id BIGINT;
ALTER TABLE group_pinned_messages ADD COLUMN IF NOT EXISTS source_event_at TIMESTAMP;
ALTER TABLE group_pinned_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE group_pinned_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_pinned_messages_group_id
  ON group_pinned_messages(group_id);
CREATE INDEX IF NOT EXISTS idx_group_pinned_messages_updated_at
  ON group_pinned_messages(updated_at DESC);

-- ─── AI Reports (Human-in-the-Loop) ───
CREATE TABLE IF NOT EXISTS ai_reports (
  id SERIAL PRIMARY KEY,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  report_text TEXT NOT NULL,
  report_type VARCHAR(50) NOT NULL DEFAULT 'driver',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMP NULL,
  CONSTRAINT ai_reports_status_check CHECK (status IN ('draft', 'sent', 'discarded')),
  CONSTRAINT ai_reports_type_check CHECK (report_type IN ('driver', 'company'))
);

ALTER TABLE ai_reports ADD COLUMN IF NOT EXISTS report_type VARCHAR(50) NOT NULL DEFAULT 'driver';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'ai_reports_type_check'
      AND table_name = 'ai_reports'
  ) THEN
    ALTER TABLE ai_reports DROP CONSTRAINT ai_reports_type_check;
  END IF;
END
$$;

ALTER TABLE ai_reports
  ADD CONSTRAINT ai_reports_type_check CHECK (report_type IN ('driver', 'company'));

CREATE INDEX IF NOT EXISTS idx_ai_reports_status_generated_at
  ON ai_reports(status, generated_at DESC);

CREATE TABLE IF NOT EXISTS employee_birthdays (
  id SERIAL PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  birthday DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(first_name, last_name)
);

-- Single-row settings for employee birthday wish schedule and AI message tone.
CREATE TABLE IF NOT EXISTS employee_birthday_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tashkent',
  send_hour INTEGER NOT NULL DEFAULT 0,
  send_minute INTEGER NOT NULL DEFAULT 0,
  ai_instructions TEXT NOT NULL DEFAULT 'Write a warm, professional birthday message for office staff at Wenze. Be sincere and appreciative. Use different wording each time.',
  fallback_template TEXT NOT NULL DEFAULT '🎉 <b>Happy Birthday!</b> 🎂

Today we celebrate: <b>{names}</b>!

Wishing you a fantastic day and a great year ahead!

— <i>Wenze Management</i>',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (send_hour BETWEEN 0 AND 23),
  CHECK (send_minute BETWEEN 0 AND 59)
);

INSERT INTO employee_birthday_settings (id, timezone, send_hour, send_minute)
VALUES (1, 'Asia/Tashkent', 0, 0)
ON CONFLICT (id) DO NOTHING;

-- ─── service_runs ────────────────────────────────────────────────
-- Tracks one-shot daily/weekly job runs (birthday wishes, weekly reports)
-- so they are guaranteed to fire at most once per logical run key, even
-- across process restarts or multiple instances. Use INSERT ... ON CONFLICT
-- DO NOTHING with a run key like "birthday:driver:2026-05-04" to claim a run.
CREATE TABLE IF NOT EXISTS service_runs (
  id SERIAL PRIMARY KEY,
  service_name TEXT NOT NULL,
  run_key TEXT NOT NULL,
  ran_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(service_name, run_key)
);

CREATE INDEX IF NOT EXISTS idx_service_runs_ran_at
  ON service_runs(ran_at DESC);

-- ─── Dispatch ETA Testing Feature ─────────────────────────────────────────────
-- Per-group settings/state for automated ETA updates derived from pinned load
-- context + live telematics location.
CREATE TABLE IF NOT EXISTS dispatch_eta_updates (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  target_mode TEXT NOT NULL DEFAULT 'driver',
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  next_run_at TIMESTAMP NULL,
  processing BOOLEAN NOT NULL DEFAULT FALSE,
  processing_started_at TIMESTAMP NULL,
  last_run_at TIMESTAMP NULL,
  last_status TEXT NULL,
  last_error TEXT NULL,
  last_pinned_signature TEXT NULL,
  cached_pickup TEXT NULL,
  cached_delivery TEXT NULL,
  cached_destination_query TEXT NULL,
  cached_context_json JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT dispatch_eta_interval_check CHECK (interval_minutes BETWEEN 1 AND 1440)
);

ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS target_mode TEXT NOT NULL DEFAULT 'driver';
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS interval_minutes INTEGER NOT NULL DEFAULT 60;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMP NULL;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS processing BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP NULL;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMP NULL;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS last_status TEXT NULL;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS last_error TEXT NULL;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS last_pinned_signature TEXT NULL;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS cached_pickup TEXT NULL;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS cached_delivery TEXT NULL;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS cached_destination_query TEXT NULL;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS cached_context_json JSONB NULL;
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE dispatch_eta_updates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'dispatch_eta_interval_check'
      AND table_name = 'dispatch_eta_updates'
  ) THEN
    ALTER TABLE dispatch_eta_updates DROP CONSTRAINT dispatch_eta_interval_check;
  END IF;
END
$$;

ALTER TABLE dispatch_eta_updates
  ADD CONSTRAINT dispatch_eta_interval_check
  CHECK (interval_minutes BETWEEN 1 AND 1440);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'dispatch_eta_target_mode_check'
      AND table_name = 'dispatch_eta_updates'
  ) THEN
    ALTER TABLE dispatch_eta_updates DROP CONSTRAINT dispatch_eta_target_mode_check;
  END IF;
END
$$;

ALTER TABLE dispatch_eta_updates
  ADD CONSTRAINT dispatch_eta_target_mode_check
  CHECK (target_mode IN ('driver', 'test'));

-- Single-row defaults for dispatch ETA intervals (admin-editable; applied to all rows by target_mode).
CREATE TABLE IF NOT EXISTS dispatch_eta_global_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  driver_interval_minutes INTEGER NOT NULL DEFAULT 60,
  test_interval_minutes INTEGER NOT NULL DEFAULT 60,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT dispatch_eta_global_intervals_check CHECK (
    driver_interval_minutes BETWEEN 1 AND 1440
    AND test_interval_minutes BETWEEN 1 AND 1440
  )
);

INSERT INTO dispatch_eta_global_settings (id, driver_interval_minutes, test_interval_minutes)
VALUES (1, 60, 60)
ON CONFLICT (id) DO NOTHING;

-- Last two AI-extracted loads per driver group (text + window fields only; files stay on Telegram).
CREATE TABLE IF NOT EXISTS group_recent_loads (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_message_id BIGINT NOT NULL,
  source_message_at TIMESTAMPTZ NULL,
  context_signature TEXT NOT NULL,
  pickup_summary TEXT NOT NULL DEFAULT '',
  delivery_summary TEXT NOT NULL DEFAULT '',
  destination_query TEXT NOT NULL DEFAULT '',
  pickup_window_start TIMESTAMPTZ NULL,
  pickup_window_end TIMESTAMPTZ NULL,
  delivery_window_start TIMESTAMPTZ NULL,
  delivery_window_end TIMESTAMPTZ NULL,
  load_identifier TEXT NULL,
  caption_preview TEXT NULL,
  extracted_raw_json JSONB NULL,
  ai_model TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS idx_group_recent_loads_group_created
  ON group_recent_loads (group_id, created_at DESC);

-- ─── Performance indexes for growing tables ───────────────────────
-- responses: primary lookup is by question, which already has a unique
-- composite index. Add a driver-centric index for "my answers" style
-- queries and ordering-by-recency.
CREATE INDEX IF NOT EXISTS idx_responses_answered_at
  ON responses(answered_at DESC);
CREATE INDEX IF NOT EXISTS idx_responses_group_id_answered_at
  ON responses(group_id, answered_at DESC);

-- chat_logs: retention deletes by created_at and reads are scoped by
-- group_id + date range. These two indexes support both access patterns.
CREATE INDEX IF NOT EXISTS idx_chat_logs_created_at
  ON chat_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_logs_group_id_created_at
  ON chat_logs(group_id, created_at DESC);

-- broadcast_deliveries: UI loads "deliveries for broadcast N".
CREATE INDEX IF NOT EXISTS idx_broadcast_deliveries_broadcast_id
  ON broadcast_deliveries(broadcast_id);

-- broadcast_button_clicks: UI loads "clicks for broadcast N".
CREATE INDEX IF NOT EXISTS idx_broadcast_button_clicks_broadcast_id
  ON broadcast_button_clicks(broadcast_id);

-- scheduled_messages: scheduler scans pending messages due now. The
-- partial index keeps the cost constant regardless of total row count.
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_pending_due
  ON scheduled_messages(scheduled_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_dispatch_eta_due
  ON dispatch_eta_updates(next_run_at)
  WHERE enabled = TRUE;

-- groups: samsara lookups by samsara_vehicle_id and active driver filters.
CREATE INDEX IF NOT EXISTS idx_groups_samsara_vehicle_id
  ON groups(samsara_vehicle_id)
  WHERE samsara_vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_groups_type_active
  ON groups(group_type, active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_profiles_group_id
  ON driver_profiles(group_id);
CREATE INDEX IF NOT EXISTS idx_driver_profiles_unit_number
  ON driver_profiles(unit_number);
CREATE INDEX IF NOT EXISTS idx_driver_profiles_status
  ON driver_profiles(status);
CREATE INDEX IF NOT EXISTS idx_driver_profiles_language
  ON driver_profiles(language);
CREATE INDEX IF NOT EXISTS idx_driver_profiles_needs_review
  ON driver_profiles(needs_review)
  WHERE needs_review = TRUE;

-- ─── AI Insights Pipeline v2 ─────────────────────────────────────────
-- Per-message annotations produced by Groq classifier. One row per
-- chat_logs row, populated asynchronously (and incrementally) by the
-- aiAnnotationService. All fields are nullable so a partially-annotated
-- row is still usable; the pipeline tops up missing annotations on demand.
CREATE TABLE IF NOT EXISTS chat_message_annotations (
  chat_log_id        INTEGER PRIMARY KEY REFERENCES chat_logs(id) ON DELETE CASCADE,
  language           VARCHAR(8),
  intent             VARCHAR(32),
  sentiment          SMALLINT,
  urgency            SMALLINT,
  role_guess         VARCHAR(16),
  role_confidence    SMALLINT,
  is_acknowledgement BOOLEAN,
  toxic              BOOLEAN,
  entities_json      JSONB,
  model_version      TEXT,
  annotated_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_annotations_intent
  ON chat_message_annotations(intent);
CREATE INDEX IF NOT EXISTS idx_annotations_role
  ON chat_message_annotations(role_guess);
CREATE INDEX IF NOT EXISTS idx_annotations_annotated_at
  ON chat_message_annotations(annotated_at DESC);

-- Consensus role per (group, sender). Refreshed by aiInsightsService
-- before each report generation using a 30-day window of annotations.
CREATE TABLE IF NOT EXISTS sender_role_consensus (
  group_id           INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_user_id   BIGINT NOT NULL,
  sender_name        TEXT,
  role               VARCHAR(16),
  confidence         SMALLINT,
  message_count      INTEGER,
  last_updated       TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (group_id, telegram_user_id)
);

-- Insight cards — one row per actionable card inside a report. Reports
-- (ai_reports) remain the owning envelope; cards give per-item
-- approve/dismiss/edit with feedback we can learn from.
CREATE TABLE IF NOT EXISTS ai_insights (
  id                 SERIAL PRIMARY KEY,
  report_id          INTEGER REFERENCES ai_reports(id) ON DELETE CASCADE,
  kind               VARCHAR(32) NOT NULL,
  severity           SMALLINT DEFAULT 1,
  rank               INTEGER DEFAULT 0,
  title              TEXT NOT NULL,
  narrative_html     TEXT,
  suggested_action   TEXT,
  evidence_json      JSONB,
  metrics_json       JSONB,
  driver_name        TEXT,
  driver_telegram_id BIGINT,
  group_id           INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  status             VARCHAR(16) DEFAULT 'pending',
  admin_feedback     TEXT,
  created_at         TIMESTAMP DEFAULT NOW(),
  updated_at         TIMESTAMP DEFAULT NOW(),
  CONSTRAINT ai_insights_status_check CHECK (status IN ('pending', 'approved', 'dismissed', 'edited', 'sent'))
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_report_id
  ON ai_insights(report_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_kind_severity
  ON ai_insights(kind, severity DESC);
CREATE INDEX IF NOT EXISTS idx_ai_insights_status
  ON ai_insights(status);

-- View used by the "Ask the Data" endpoint. Joining here means the
-- whitelisted SQL compiler only ever sees a single, safe surface.
CREATE OR REPLACE VIEW v_annotated_messages AS
SELECT
  cl.id                        AS chat_log_id,
  cl.group_id                  AS group_id,
  g.group_name                 AS group_name,
  g.telegram_group_id          AS telegram_group_id,
  cl.telegram_user_id          AS telegram_user_id,
  cl.telegram_message_id       AS telegram_message_id,
  cl.sender_name               AS sender_name,
  cl.message_text              AS message_text,
  cl.created_at                AS created_at,
  a.language                   AS language,
  a.intent                     AS intent,
  a.sentiment                  AS sentiment,
  a.urgency                    AS urgency,
  a.role_guess                 AS msg_role_guess,
  a.role_confidence            AS msg_role_confidence,
  a.is_acknowledgement         AS is_acknowledgement,
  a.toxic                      AS toxic,
  a.entities_json              AS entities_json,
  COALESCE(src.role, a.role_guess, 'unknown') AS role,
  src.confidence               AS role_confidence
FROM chat_logs cl
JOIN groups g ON g.id = cl.group_id
LEFT JOIN chat_message_annotations a ON a.chat_log_id = cl.id
LEFT JOIN sender_role_consensus src
  ON src.group_id = cl.group_id AND src.telegram_user_id = cl.telegram_user_id;

-- ─── Mileage Bonus (company drivers) ──────────────────────────────────────
-- Cumulative-mileage milestone bonuses for COMPANY DRIVERS ONLY. Source of
-- truth for driver identity/mileage is the Datatruck OpenAPI; these tables
-- record what we computed and which milestone notifications have been sent so
-- the (free-tier, sleep-prone) service never double-notifies a driver/tier.

-- Latest computed progress snapshot per company driver (one row per driver).
-- Powers the admin "who is close to a milestone" view without re-hitting the
-- Datatruck API on every page load.
CREATE TABLE IF NOT EXISTS mileage_bonus_progress (
  id SERIAL PRIMARY KEY,
  driver_external_id TEXT,
  driver_normalized_name TEXT UNIQUE NOT NULL,
  driver_name TEXT NOT NULL,
  driver_type TEXT,
  hire_date DATE,
  period_start DATE,
  period_end DATE,
  total_miles NUMERIC(12,2) NOT NULL DEFAULT 0,
  trips INTEGER NOT NULL DEFAULT 0,
  highest_tier_reached INTEGER,
  next_tier INTEGER,
  miles_to_next_tier NUMERIC(12,2),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  activation_updated_at TIMESTAMPTZ,
  activation_updated_by TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE mileage_bonus_progress ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE mileage_bonus_progress ADD COLUMN IF NOT EXISTS activation_updated_at TIMESTAMPTZ;
ALTER TABLE mileage_bonus_progress ADD COLUMN IF NOT EXISTS activation_updated_by TEXT;

CREATE INDEX IF NOT EXISTS idx_mileage_bonus_progress_total
  ON mileage_bonus_progress(total_miles DESC);

-- One row per (driver, milestone) ever awarded. The UNIQUE constraint is the
-- idempotency guard: a milestone notification is sent at most once for a
-- driver, no matter how many times the check runs.
CREATE TABLE IF NOT EXISTS mileage_bonus_notifications (
  id SERIAL PRIMARY KEY,
  driver_external_id TEXT,
  driver_normalized_name TEXT NOT NULL,
  driver_name TEXT NOT NULL,
  threshold_miles INTEGER NOT NULL,
  bonus_amount INTEGER NOT NULL,
  miles_at_notification NUMERIC(12,2) NOT NULL,
  period_start DATE,
  period_end DATE,
  trigger TEXT NOT NULL DEFAULT 'scheduled',
  status TEXT NOT NULL DEFAULT 'pending',
  telegram_chat_id BIGINT,
  telegram_message_id BIGINT,
  telegram_followup_message_id BIGINT,
  decided_by_username TEXT,
  decided_by_user_id BIGINT,
  decided_at TIMESTAMP,
  disregarded_by_username TEXT,
  disregarded_at TIMESTAMPTZ,
  resend_count INTEGER NOT NULL DEFAULT 0,
  last_resent_at TIMESTAMPTZ,
  last_resent_by_username TEXT,
  delivery_state TEXT NOT NULL DEFAULT 'pending',
  delivery_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action_state TEXT NOT NULL DEFAULT 'idle',
  action_started_at TIMESTAMPTZ,
  last_action_error TEXT,
  telegram_deleted_at TIMESTAMPTZ,
  telegram_delete_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT mileage_bonus_notifications_unique UNIQUE (driver_normalized_name, threshold_miles),
  CONSTRAINT mileage_bonus_notifications_status_check CHECK (
    status IN ('pending', 'paid', 'rejected', 'disregarded')
  ),
  CONSTRAINT mileage_bonus_notifications_action_check CHECK (
    action_state IN ('idle', 'resending', 'disregarding')
  ),
  CONSTRAINT mileage_bonus_notifications_delivery_check CHECK (
    delivery_state IN ('pending', 'sent', 'failed')
  )
);

ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS disregarded_by_username TEXT;
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS telegram_followup_message_id BIGINT;
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS disregarded_at TIMESTAMPTZ;
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS resend_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS last_resent_at TIMESTAMPTZ;
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS last_resent_by_username TEXT;
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS delivery_state TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS delivery_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS action_state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS action_started_at TIMESTAMPTZ;
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS last_action_error TEXT;
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS telegram_deleted_at TIMESTAMPTZ;
ALTER TABLE mileage_bonus_notifications ADD COLUMN IF NOT EXISTS telegram_delete_error TEXT;

ALTER TABLE mileage_bonus_notifications
  DROP CONSTRAINT IF EXISTS mileage_bonus_notifications_status_check;
ALTER TABLE mileage_bonus_notifications
  ADD CONSTRAINT mileage_bonus_notifications_status_check
  CHECK (status IN ('pending', 'paid', 'rejected', 'disregarded'));
ALTER TABLE mileage_bonus_notifications
  DROP CONSTRAINT IF EXISTS mileage_bonus_notifications_action_check;
ALTER TABLE mileage_bonus_notifications
  ADD CONSTRAINT mileage_bonus_notifications_action_check
  CHECK (action_state IN ('idle', 'resending', 'disregarding'));
ALTER TABLE mileage_bonus_notifications
  DROP CONSTRAINT IF EXISTS mileage_bonus_notifications_delivery_check;
ALTER TABLE mileage_bonus_notifications
  ADD CONSTRAINT mileage_bonus_notifications_delivery_check
  CHECK (delivery_state IN ('pending', 'sent', 'failed'));

CREATE INDEX IF NOT EXISTS idx_mileage_bonus_notifications_status
  ON mileage_bonus_notifications(status);
CREATE INDEX IF NOT EXISTS idx_mileage_bonus_notifications_created
  ON mileage_bonus_notifications(created_at DESC);

-- Durable run ledger. Failed weekly runs remain retryable; running leases make
-- abandoned work recoverable after process crashes or deploys.
CREATE TABLE IF NOT EXISTS mileage_bonus_runs (
  id BIGSERIAL PRIMARY KEY,
  run_key TEXT UNIQUE NOT NULL,
  trigger TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  attempt_count INTEGER NOT NULL DEFAULT 1,
  requested_by TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  next_retry_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  summary JSONB,
  CONSTRAINT mileage_bonus_runs_mode_check CHECK (mode IN ('notify', 'refresh')),
  CONSTRAINT mileage_bonus_runs_status_check CHECK (status IN ('running', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_mileage_bonus_runs_started
  ON mileage_bonus_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mileage_bonus_runs_status
  ON mileage_bonus_runs(status, lease_expires_at, next_retry_at);

-- Unified inbound leads (Facebook + Indeed) shown in the admin "Leads" tab.
-- Each source dedupes on its own external id (Facebook leadgen id / Gmail
-- message id) so retries never create duplicates.
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,                 -- 'facebook' | 'indeed'
  external_id TEXT,                     -- leadgen id / gmail message id
  full_name TEXT,
  email TEXT,
  phone TEXT,
  job_title TEXT,
  message TEXT,
  bitrix_id TEXT,
  bitrix_status TEXT DEFAULT 'pending', -- pending|created|skipped|disabled|failed
  raw JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_source_created ON leads(source, created_at DESC);

-- ─── 75¢/mile Driver Raise Approval ──────────────────────────────────────────
-- Dispatch teams (groups of dispatch specialists). Each team is linked to a set
-- of active company drivers it is responsible for.
CREATE TABLE IF NOT EXISTS dispatch_teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Company drivers assigned to a dispatch team. Drivers come from the Datatruck
-- OpenAPI (driver_type = 'company_driver'); matched by normalized full name.
CREATE TABLE IF NOT EXISTS dispatch_team_drivers (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES dispatch_teams(id) ON DELETE CASCADE,
  driver_external_id TEXT,
  driver_normalized_name TEXT NOT NULL,
  driver_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, driver_normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_team_drivers_team
  ON dispatch_team_drivers(team_id);

-- Single-row settings for the raise-approval service.
CREATE TABLE IF NOT EXISTS raise_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  otp_channel TEXT NOT NULL DEFAULT 'gmail' CHECK (otp_channel IN ('gmail', 'ringcentral')),
  schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  weekly_day_of_week INTEGER NOT NULL DEFAULT 1 CHECK (weekly_day_of_week BETWEEN 1 AND 7),
  weekly_time_local TEXT NOT NULL DEFAULT '09:00',
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

CREATE TABLE IF NOT EXISTS home_time_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  road_allowance_weeks INTEGER NOT NULL DEFAULT 4 CHECK (road_allowance_weeks BETWEEN 1 AND 52),
  home_allowance_days INTEGER NOT NULL DEFAULT 4 CHECK (home_allowance_days BETWEEN 1 AND 60),
  bonus_per_week NUMERIC(10,2) NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO home_time_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Current home/road state for each driver group (one row per group).
CREATE TABLE IF NOT EXISTS driver_home_status (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT,
  state TEXT NOT NULL CHECK (state IN ('home', 'road')),
  state_since TIMESTAMPTZ NOT NULL,
  last_status_text TEXT,
  last_status_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per completed road trip (closed when the driver goes home).
CREATE TABLE IF NOT EXISTS driver_road_history (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  driver_name TEXT,
  unit_number TEXT,
  road_started_at TIMESTAMPTZ NOT NULL,
  home_arrived_at TIMESTAMPTZ NOT NULL,
  days_on_road INTEGER NOT NULL,
  exceeded_weeks INTEGER NOT NULL DEFAULT 0,
  bonus_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_road_history_group
  ON driver_road_history(group_id, home_arrived_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_road_history_bonus
  ON driver_road_history(home_arrived_at DESC) WHERE bonus_usd > 0;

-- Home-time REQUESTS: every time a driver asks for home time (via the bot when a
-- rep tags an approver, or entered manually in the admin panel). Keeping all of
-- them lets us spot drivers who violate the policy (4 weeks on the road / 4 days
-- home).
CREATE TABLE IF NOT EXISTS home_time_requests (
  id SERIAL PRIMARY KEY,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  telegram_group_id BIGINT,
  driver_name TEXT,
  unit_number TEXT,
  requested_by_user_id BIGINT,
  requested_by_username TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  road_started_at TIMESTAMPTZ,
  days_on_road INTEGER,
  policy_met BOOLEAN,
  home_from DATE,
  home_to DATE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  source TEXT NOT NULL DEFAULT 'telegram'
    CHECK (source IN ('telegram', 'manual')),
  ai_reasoning TEXT,
  telegram_chat_id BIGINT,
  telegram_message_id BIGINT,
  decided_by_username TEXT,
  decided_by_user_id BIGINT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 'awaiting_dates': the bot detected a home-time request but the driver did not
-- give the dates, so it asked in the group and is waiting for the reply before
-- posting the approval card.
ALTER TABLE home_time_requests
  DROP CONSTRAINT IF EXISTS home_time_requests_status_check;
ALTER TABLE home_time_requests
  ADD CONSTRAINT home_time_requests_status_check
  CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'awaiting_dates'));

CREATE INDEX IF NOT EXISTS idx_home_time_requests_group
  ON home_time_requests(group_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_home_time_requests_status
  ON home_time_requests(status, requested_at DESC);

-- Single-row settings for the "Bot Group Access" feature: the super admin whose
-- Telegram account receives the "add me as admin" deep links.
CREATE TABLE IF NOT EXISTS bot_access_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  super_admin_telegram_id BIGINT,
  super_admin_label TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO bot_access_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─── Datatruck BOL/POD Document Delivery ──────────────────────────────────────
-- When a driver uploads a Bill of Lading or Proof of Delivery to Datatruck, the
-- bot forwards the file to that driver's Telegram group. One row per delivered
-- (order, document) pair — the UNIQUE signature is the idempotency guard so a
-- document is forwarded at most once no matter how often the poller scans it.
-- `status` records what happened: sent, failed (retryable), suppressed_backfill
-- (existed before the feature was activated — recorded, never sent), or
-- skipped_no_group (no matching active driver group).
CREATE TABLE IF NOT EXISTS datatruck_document_deliveries (
  id BIGSERIAL PRIMARY KEY,
  signature TEXT UNIQUE NOT NULL,
  order_id TEXT,
  load_reference TEXT,
  file_type TEXT NOT NULL,
  file_link TEXT,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ,
  driver_name TEXT,
  unit_number TEXT,
  matched_by TEXT,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  telegram_group_id BIGINT,
  status TEXT NOT NULL DEFAULT 'pending',
  telegram_message_id BIGINT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT datatruck_document_deliveries_status_check CHECK (
    status IN ('pending', 'sent', 'failed', 'suppressed_backfill', 'skipped_no_group')
  )
);

CREATE INDEX IF NOT EXISTS idx_datatruck_document_deliveries_status
  ON datatruck_document_deliveries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_datatruck_document_deliveries_group
  ON datatruck_document_deliveries(group_id, created_at DESC);
