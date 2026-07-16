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

-- TABLE: group_members — which Telegram users the bot has SEEN in each group.
-- The Bot API cannot enumerate a group's full member list (only getChatMember
-- for one known user, getChatAdministrators, and getChatMemberCount), so this
-- table is populated opportunistically from every update the bot receives
-- (senders, added/removed members, reply authors). Silent members who never
-- interact will NOT appear here. It powers the "Driver Username" dropdown in
-- the admin Driver Groups popup.
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, telegram_user_id)
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
-- Driver's Telegram @username, used to tag the driver in gas-station proximity
-- and check-in reminders. Stored without the leading '@'.
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS telegram_username TEXT;
-- Driver's numeric Telegram user id — the single source of truth for tagging,
-- selected in the admin Driver Groups popup from the group_members the bot has
-- captured. Lets buildMention() ping a driver WITHOUT an @username via an
-- inline <a href="tg://user?id=ID"> mention. Note the Telegram limitation:
-- such an inline mention only reliably notifies a user the bot has already
-- "seen" interact, which is why ids are captured broadly in bot/bot.js.
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS telegram_user_id BIGINT;

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

-- ─── Employee Voting System — RETIRED ───
-- The "Driver of the Week" employee voting feature was removed from the
-- application code (bot handlers, API routes, and admin page all deleted).
-- These tables are INTENTIONALLY RETAINED so existing historical vote data is
-- preserved and a fresh `init-db` run does not error. No application code
-- references them any more. They can be dropped manually AFTER a database
-- backup if the historical data is no longer needed; do not add an automatic
-- destructive migration.

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

-- Keeps the admin-supplied replacement text distinct from message_text so we
-- can show what the last edit set the message to, even if content_kind changes.
ALTER TABLE bot_sent_messages ADD COLUMN IF NOT EXISTS last_edit_text TEXT;

CREATE INDEX IF NOT EXISTS idx_bot_sent_messages_forward_lookup
  ON bot_sent_messages (sent_at DESC, telegram_chat_id)
  WHERE deleted_at IS NULL;

-- Newest-first admin listing / pagination of the whole registry.
CREATE INDEX IF NOT EXISTS idx_bot_sent_messages_recent
  ON bot_sent_messages (sent_at DESC NULLS LAST, id DESC);

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

-- Company drivers assigned to a dispatch team.
--
-- Source of truth is now Driver Groups / driver_profiles (linked by
-- driver_profile_id + group_id). The driver_name / driver_normalized_name
-- columns are kept as a SNAPSHOT so the public raise-review form and
-- raise_round_picks stay historically stable even if a profile later changes,
-- and so legacy Datatruck-name rows (driver_external_id, no profile link)
-- keep working. driver_normalized_name uses normalizeDriverName() (UPPERCASE).
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

-- Driver Groups as the source of truth: link each assignment to a driver
-- profile / group, keep a unit snapshot, and let assignments be soft-disabled.
-- needs_review flags legacy name-only rows that could not be linked to a profile.
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS driver_profile_id INTEGER
  REFERENCES driver_profiles(id) ON DELETE SET NULL;
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS group_id INTEGER
  REFERENCES groups(id) ON DELETE SET NULL;
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS unit_number TEXT;
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- A driver normally belongs to ONE active dispatch team at a time. Enforce it at
-- the DB level per driver profile and per group (partial unique — only over
-- active, linked rows; legacy name-only rows with NULL links are unaffected).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dispatch_active_driver_profile
  ON dispatch_team_drivers(driver_profile_id)
  WHERE active AND driver_profile_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dispatch_active_driver_group
  ON dispatch_team_drivers(group_id)
  WHERE active AND group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_team_drivers_profile
  ON dispatch_team_drivers(driver_profile_id) WHERE driver_profile_id IS NOT NULL;

-- Dispatch team MEMBERS (dispatchers). Their Telegram username authorizes them
-- to assign routes from Telegram (Route Control, see routeControlService).
-- telegram_username is stored WITHOUT a leading '@' and lowercased; compared
-- case-insensitively. telegram_user_id is the stable numeric id when known.
CREATE TABLE IF NOT EXISTS dispatch_team_members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES dispatch_teams(id) ON DELETE CASCADE,
  name TEXT NULL,
  telegram_username TEXT NULL,
  telegram_user_id BIGINT NULL,
  role TEXT NULL CHECK (role IS NULL OR role IN ('dispatcher', 'lead_dispatcher', 'manager')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_team_members_team
  ON dispatch_team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_team_members_username
  ON dispatch_team_members(telegram_username) WHERE telegram_username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_team_members_user_id
  ON dispatch_team_members(telegram_user_id) WHERE telegram_user_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS home_time_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  road_allowance_weeks INTEGER NOT NULL DEFAULT 4 CHECK (road_allowance_weeks BETWEEN 1 AND 52),
  home_allowance_days INTEGER NOT NULL DEFAULT 4 CHECK (home_allowance_days BETWEEN 1 AND 60),
  bonus_per_week NUMERIC(10,2) NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO home_time_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Conversational clarification reminders: how long to wait before the first and
-- second (and final) reminder when a driver has not supplied a missing home-time
-- date. Configurable so the cadence can be tuned without a code change. Defaults
-- to 12h + 12h. See services/homeTimeReminderService.js.
ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS reminder_first_hours INTEGER NOT NULL DEFAULT 12
    CHECK (reminder_first_hours BETWEEN 1 AND 168);
ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS reminder_second_hours INTEGER NOT NULL DEFAULT 12
    CHECK (reminder_second_hours BETWEEN 1 AND 168);

-- Current home/road state for each driver group (one row per group).
CREATE TABLE IF NOT EXISTS driver_home_status (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT,
  state TEXT NOT NULL CHECK (state IN ('home', 'road')),
  state_since TIMESTAMPTZ NOT NULL,
  last_status_text TEXT,
  last_status_at TIMESTAMPTZ NOT NULL,
  -- Watermark: how many FULL extra-week milestones (beyond the road allowance)
  -- have already been posted to the Bonus Penalty group for the CURRENT road
  -- leg. Reset to 0 whenever a new road leg begins so the same week is never
  -- double-posted. See services/roadBonusNotifierService.js.
  road_bonus_weeks_notified INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Older deployments created driver_home_status before the watermark existed.
ALTER TABLE driver_home_status
  ADD COLUMN IF NOT EXISTS road_bonus_weeks_notified INTEGER NOT NULL DEFAULT 0;

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
  -- When the single "extra-week bonus" summary for this completed road leg was
  -- posted to the configured Extra Week / Road Bonus group. NULL = not yet
  -- posted. This is the DB-side idempotency key: the summary is posted at most
  -- once per completed leg, surviving restarts, repeated syncs and repeated
  -- status updates. See services/roadBonusNotifierService.js.
  bonus_posted_at TIMESTAMPTZ NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Older deployments created driver_road_history before per-leg bonus posting.
ALTER TABLE driver_road_history
  ADD COLUMN IF NOT EXISTS bonus_posted_at TIMESTAMPTZ NULL;

-- Home-Time Efficiency needs BOTH sides of a cycle: time on the road (already
-- captured by road_started_at → home_arrived_at) AND the home stay that follows.
-- These columns close the home stay when the driver goes back on the road:
--   return_to_road_at — actual home→road transition time (NULL while still home);
--   home_days         — whole days spent home (return_to_road_at − home_arrived_at);
--   linked_request_id — the decided home-time request this cycle maps to, so an
--                       APPROVED longer-than-policy stay counts as an approved
--                       exception rather than an ordinary violation.
-- A cycle is "complete" (usable for strict efficiency) once return_to_road_at is
-- set. Additive + idempotent: existing rows keep NULLs and are simply treated as
-- incomplete home-side data until a future home→road transition fills them.
ALTER TABLE driver_road_history
  ADD COLUMN IF NOT EXISTS return_to_road_at TIMESTAMPTZ NULL;
ALTER TABLE driver_road_history
  ADD COLUMN IF NOT EXISTS home_days INTEGER NULL;
ALTER TABLE driver_road_history
  ADD COLUMN IF NOT EXISTS linked_request_id INTEGER NULL;

-- Backfill: mark every EXISTING completed leg as already-posted so switching to
-- the road→home summary flow does not re-announce historical trips. Only legs
-- completed AFTER this migration (bonus_posted_at left NULL by default) will be
-- posted once. Runs once — subsequent rows are inserted with NULL and posted.
UPDATE driver_road_history
   SET bonus_posted_at = COALESCE(recorded_at, NOW())
 WHERE bonus_posted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_driver_road_history_group
  ON driver_road_history(group_id, home_arrived_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_road_history_bonus
  ON driver_road_history(home_arrived_at DESC) WHERE bonus_usd > 0;
-- Fast lookup of completed legs still awaiting their bonus summary.
CREATE INDEX IF NOT EXISTS idx_driver_road_history_unposted
  ON driver_road_history(home_arrived_at ASC) WHERE bonus_usd > 0 AND bonus_posted_at IS NULL;
-- The still-open home stay for a group (home_arrived_at set, not yet back on road)
-- is the row a home→road transition closes.
CREATE INDEX IF NOT EXISTS idx_driver_road_history_open_home
  ON driver_road_history(group_id, home_arrived_at DESC) WHERE return_to_road_at IS NULL;

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

-- ── Conversational home-time flow (AI clarification, partial dates, reminders) ──
-- DATE MODEL (normalized — do not mix these up):
--   home_from            = HOME START DATE  (day the driver arrives home)
--   return_to_road_date  = day the driver leaves home to go back on the road
--   home_to              = LAST DAY HOME    (= return_to_road_date − 1), kept for
--                          back-compat/display. homeDays = return_to_road − home_from.
-- A single supplied date is NEVER copied into both ends: the unknown end stays NULL
-- and the flow asks for it.
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS return_to_road_date DATE;
-- Driver went home with no earlier complete request — an "unplanned home arrival"
-- clarification (we know the start from the Status: Home date, still need the
-- return-to-road date).
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS is_unplanned_arrival BOOLEAN NOT NULL DEFAULT FALSE;
-- AI audit: what the model decided, how sure, the driver's language, and which
-- date fields were still missing when the row was last touched.
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS detected_intent TEXT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS ai_confidence INTEGER;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS missing_fields TEXT;
-- Telegram reply threading. root_* = the message that STARTED this flow (the
-- original request / Status: Home / incomplete-date message) — clarifications and
-- reminders reply to it. clarification_* = the bot's own question message.
-- last_driver_message_id = the most recent driver message we acted on (final ack
-- replies to it).
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS root_chat_id BIGINT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS root_message_id BIGINT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS clarification_chat_id BIGINT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS clarification_message_id BIGINT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS last_driver_message_id BIGINT;
-- Restart-safe reminder scheduling. next_reminder_at drives the worker (NULL =
-- nothing scheduled); reminder_count caps at 2. See homeTimeReminderService.js.
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS next_reminder_at TIMESTAMPTZ;
-- The conversational acknowledgment / policy reminder is sent at most once per
-- request (idempotency guard); policy_result records the evaluation outcome.
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS policy_result TEXT;

-- Status lifecycle:
--   awaiting_dates        — need BOTH home-start and return-to-road (generic).
--   awaiting_home_start   — have return-to-road, need the home-start date.
--   awaiting_return_to_road — have home-start (or Status: Home), need return date.
--   pending               — dates complete, approval card posted, awaiting a human.
--   approved / denied / cancelled — human decision (approval stays authoritative).
--   clarification_unanswered — two reminders sent, no answer → manual follow-up.
--   expired               — flow abandoned (driver returned to road, etc.).
ALTER TABLE home_time_requests
  DROP CONSTRAINT IF EXISTS home_time_requests_status_check;
ALTER TABLE home_time_requests
  ADD CONSTRAINT home_time_requests_status_check
  CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'awaiting_dates',
    'awaiting_home_start', 'awaiting_return_to_road', 'clarification_unanswered', 'expired'));

CREATE INDEX IF NOT EXISTS idx_home_time_requests_group
  ON home_time_requests(group_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_home_time_requests_status
  ON home_time_requests(status, requested_at DESC);
-- Drives the restart-safe reminder sweep: due, still-open clarifications only.
CREATE INDEX IF NOT EXISTS idx_home_time_requests_reminder_due
  ON home_time_requests(next_reminder_at ASC)
  WHERE next_reminder_at IS NOT NULL
    AND status IN ('awaiting_dates', 'awaiting_home_start', 'awaiting_return_to_road');

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
    status IN ('pending', 'sent', 'failed', 'suppressed_backfill', 'skipped_no_group', 'suppressed_bot_upload')
  )
);

-- Additive: the admin-controlled BOL/POD forwarding feature tracks TWO
-- destinations per document (the driver group and a central group). The columns
-- above serve the DRIVER destination; these central_* columns track the CENTRAL
-- destination independently, so a partial failure retries only the failed side.
-- doc_classification/classification_source record how BOL vs POD was decided.
-- All ADD COLUMN IF NOT EXISTS — safe to run on every boot.
ALTER TABLE datatruck_document_deliveries
  ADD COLUMN IF NOT EXISTS central_status TEXT NOT NULL DEFAULT 'skipped_not_applicable';
ALTER TABLE datatruck_document_deliveries
  ADD COLUMN IF NOT EXISTS central_telegram_group_id BIGINT NULL;
ALTER TABLE datatruck_document_deliveries
  ADD COLUMN IF NOT EXISTS central_telegram_message_id BIGINT NULL;
ALTER TABLE datatruck_document_deliveries
  ADD COLUMN IF NOT EXISTS central_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE datatruck_document_deliveries
  ADD COLUMN IF NOT EXISTS central_last_error TEXT NULL;
ALTER TABLE datatruck_document_deliveries
  ADD COLUMN IF NOT EXISTS doc_classification TEXT NULL;
ALTER TABLE datatruck_document_deliveries
  ADD COLUMN IF NOT EXISTS classification_source TEXT NULL;

-- Additive migration for existing databases. Widens the driver-destination
-- status allow-list (adds 'processing' and the routing skip states while
-- keeping the legacy 'suppressed_bot_upload' historical value) and adds the
-- central-destination status allow-list. Drop + re-add is idempotent; existing
-- rows only carry values in the old (narrower) set. The central_status
-- constraint is added AFTER its column exists (columns are altered above).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'datatruck_document_deliveries_status_check'
      AND conrelid = 'datatruck_document_deliveries'::regclass
  ) THEN
    ALTER TABLE datatruck_document_deliveries
      DROP CONSTRAINT datatruck_document_deliveries_status_check;
  END IF;
  ALTER TABLE datatruck_document_deliveries
    ADD CONSTRAINT datatruck_document_deliveries_status_check
    CHECK (status IN (
      'pending', 'processing', 'sent', 'failed',
      'suppressed_backfill', 'skipped_no_group', 'suppressed_bot_upload',
      'skipped_not_applicable', 'skipped_same_group', 'skipped_unclear',
      'skipped_duplicate'
    ));

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'datatruck_document_deliveries_central_status_check'
      AND conrelid = 'datatruck_document_deliveries'::regclass
  ) THEN
    ALTER TABLE datatruck_document_deliveries
      DROP CONSTRAINT datatruck_document_deliveries_central_status_check;
  END IF;
  ALTER TABLE datatruck_document_deliveries
    ADD CONSTRAINT datatruck_document_deliveries_central_status_check
    CHECK (central_status IN (
      'pending', 'processing', 'sent', 'failed',
      'skipped_not_applicable', 'skipped_same_group', 'skipped_unclear',
      'skipped_duplicate'
    ));
END
$$;

CREATE INDEX IF NOT EXISTS idx_datatruck_document_deliveries_status
  ON datatruck_document_deliveries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_datatruck_document_deliveries_group
  ON datatruck_document_deliveries(group_id, created_at DESC);
-- Supports the per-destination central retry scan (claim due central rows).
CREATE INDEX IF NOT EXISTS idx_datatruck_document_deliveries_central_status
  ON datatruck_document_deliveries(central_status, updated_at DESC);

-- ── Retired: Smart BOL/POD intake + silent BOL/POD test monitor ──
-- The Telegram→Datatruck BOL/POD intake pipeline and the admin "BOL/POD
-- Monitor" test monitor were removed. Their tables are no longer created here.
-- Retired BOL/POD monitor tables retained for historical safety; no runtime
-- code uses them. Existing databases may still contain:
--   telegram_document_batches, telegram_document_files,
--   datatruck_upload_attempts, bol_pod_monitor_settings
-- They are harmless and may be dropped manually once their history is no
-- longer needed (no automatic DROP is performed).

-- ── Fuel Monitor: gas-station proximity reminders ──
-- When the Fuel Monitoring team posts a gas-station location into a driver
-- group, we create one "watching" row here. A background poller checks each
-- watching row against the truck's live GPS and, when the truck is within
-- radius_miles of the station, replies to the original message tagging the
-- driver, then flips the row to 'notified' (fires once). Mirrors the
-- watch/poll/claim shape of dispatch_eta_updates.
CREATE TABLE IF NOT EXISTS fuel_stop_alerts (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  station_name TEXT NULL,
  station_address TEXT NULL,
  station_lat DOUBLE PRECISION NOT NULL,
  station_lng DOUBLE PRECISION NOT NULL,
  radius_miles DOUBLE PRECISION NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'watching',
  processing BOOLEAN NOT NULL DEFAULT FALSE,
  processing_started_at TIMESTAMP NULL,
  last_distance_miles DOUBLE PRECISION NULL,
  last_checked_at TIMESTAMP NULL,
  notified_at TIMESTAMP NULL,
  last_error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NULL,
  -- ETA-based scheduling: instead of polling every watch row constantly, each
  -- row stores when it should next be evaluated (next_check_at) and the latest
  -- estimate of when the truck will reach the 10-mile boundary.
  next_check_at TIMESTAMP NULL,
  eta_minutes DOUBLE PRECISION NULL,
  eta_boundary_at TIMESTAMP NULL,
  CONSTRAINT fuel_stop_alerts_status_check CHECK (
    status IN ('watching', 'notified', 'expired', 'error')
  )
);

ALTER TABLE fuel_stop_alerts ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMP NULL;
ALTER TABLE fuel_stop_alerts ADD COLUMN IF NOT EXISTS eta_minutes DOUBLE PRECISION NULL;
ALTER TABLE fuel_stop_alerts ADD COLUMN IF NOT EXISTS eta_boundary_at TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_fuel_stop_alerts_due
  ON fuel_stop_alerts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_fuel_stop_alerts_next_check
  ON fuel_stop_alerts(status, next_check_at);
CREATE INDEX IF NOT EXISTS idx_fuel_stop_alerts_group
  ON fuel_stop_alerts(group_id, created_at DESC);

-- ── Fuel Monitor: inbox of fuel-header messages seen by the bot ──
-- Every time the bot sees a "⛽FUEL MONITORING DEPARTMENT⛽" message in a
-- company-driver group, we record it here. The detection/geocode pipeline runs
-- immediately; if it fails (transient geocode error, AI quota) the row stays
-- 'pending' and the admin "Refresh" button can retry it later. Rows that were
-- successfully turned into fuel_stop_alerts are marked 'picked_up'.
-- Note: the Telegram Bot API cannot retrieve past history, so this table is the
-- only durable record of messages the bot has observed.
CREATE TABLE IF NOT EXISTS fuel_monitor_inbox (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  message_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | picked_up
  alert_id INTEGER REFERENCES fuel_stop_alerts(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP NULL,
  UNIQUE (group_id, message_id),
  CONSTRAINT fuel_monitor_inbox_status_check CHECK (status IN ('pending', 'picked_up'))
);

CREATE INDEX IF NOT EXISTS idx_fuel_monitor_inbox_status_created
  ON fuel_monitor_inbox(status, created_at DESC);

-- ─── Driver Location Monitoring — RETIRED ────────────────────────────
-- The pickup/delivery "Checked In / Checked Out" location-monitor feature was
-- RETIRED (2026-07). The poller, callback handlers, admin API/UI, and DB helper
-- module were removed; see docs/architecture/retired-checkin-checkout-feature.md.
-- These two tables (driver_location_monitors, driver_location_checkins) are
-- INTENTIONALLY RETAINED so historical check-in/dwell data is preserved and a
-- fresh init-db still succeeds. No application code references them any more.
-- They may be dropped manually AFTER a backup if the data is no longer needed;
-- do not add an automatic destructive migration.
--
-- (Original description) Per-driver-group toggle + scheduler state: a poller
-- resolved the driver's active load (Datatruck, with AI-parsed load context as
-- fallback), decided shipper (pickup) vs receiver (delivery), tracked the live
-- ETA, and — when the truck entered the check-in radius — sent the check-in
-- prompt to the driver group. Mirrored the claim/poll/reschedule shape of
-- dispatch_eta_updates + fuel_stop_alerts.
CREATE TABLE IF NOT EXISTS driver_location_monitors (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Re-poll cadence floor (minutes). The poller schedules adaptively based on
  -- ETA but never sleeps longer than this between checks.
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  -- Distance (miles) at which the check-in prompt fires (the "10–5 miles" band;
  -- prompt sends as soon as the truck is within this radius).
  checkin_radius_miles NUMERIC NOT NULL DEFAULT 8,
  -- Scheduler bookkeeping.
  next_run_at TIMESTAMP NULL,
  processing BOOLEAN NOT NULL DEFAULT FALSE,
  processing_started_at TIMESTAMP NULL,
  last_run_at TIMESTAMP NULL,
  last_status TEXT NULL,
  last_error TEXT NULL,
  -- Current load + target stop snapshot (so each tick is cheap and the admin
  -- panel can show live state without recomputing).
  current_order_id TEXT NULL,
  load_phase TEXT NULL,            -- heading_pickup | heading_delivery | unknown
  target_stop_type TEXT NULL,      -- shipper | receiver
  target_address TEXT NULL,
  target_lat DOUBLE PRECISION NULL,
  target_lng DOUBLE PRECISION NULL,
  target_appointment_at TIMESTAMPTZ NULL,
  last_eta_minutes INTEGER NULL,
  last_eta_at TIMESTAMPTZ NULL,
  last_distance_miles NUMERIC NULL,
  -- The check-in row currently awaiting a driver answer (NULL when none open).
  active_checkin_id INTEGER NULL,
  cached_context_json JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT driver_location_interval_check CHECK (interval_minutes BETWEEN 1 AND 1440),
  CONSTRAINT driver_location_radius_check CHECK (checkin_radius_miles BETWEEN 1 AND 100),
  CONSTRAINT driver_location_phase_check CHECK (
    load_phase IS NULL OR load_phase IN ('heading_pickup', 'heading_delivery', 'unknown')
  ),
  CONSTRAINT driver_location_stop_type_check CHECK (
    target_stop_type IS NULL OR target_stop_type IN ('shipper', 'receiver')
  )
);

-- Idempotent column adds (mirrors the dispatch_eta_updates migration style so
-- pre-existing deployments pick up new columns without a manual migration).
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS checkin_radius_miles NUMERIC NOT NULL DEFAULT 8;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS current_order_id TEXT NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS load_phase TEXT NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS target_stop_type TEXT NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS target_address TEXT NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS target_lat DOUBLE PRECISION NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS target_lng DOUBLE PRECISION NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS target_appointment_at TIMESTAMPTZ NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS last_eta_minutes INTEGER NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS last_eta_at TIMESTAMPTZ NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS last_distance_miles NUMERIC NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS active_checkin_id INTEGER NULL;
ALTER TABLE driver_location_monitors ADD COLUMN IF NOT EXISTS cached_context_json JSONB NULL;

CREATE INDEX IF NOT EXISTS idx_driver_location_due
  ON driver_location_monitors(next_run_at)
  WHERE enabled = TRUE;

-- One row per check-in prompt sent to a driver. Records the driver's Yes/No
-- answer and whether they were on time for that stop, building the shipper/
-- receiver on-time performance history the operator asked for.
CREATE TABLE IF NOT EXISTS driver_location_checkins (
  id SERIAL PRIMARY KEY,
  monitor_id INTEGER NOT NULL REFERENCES driver_location_monitors(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT NOT NULL,
  order_id TEXT NULL,
  stop_type TEXT NOT NULL,         -- shipper | receiver
  location_address TEXT NULL,
  appointment_at TIMESTAMPTZ NULL,
  eta_at TIMESTAMPTZ NULL,
  distance_miles_at_prompt NUMERIC NULL,
  prompt_message_id BIGINT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_response',  -- awaiting_response | answered | expired
  driver_response TEXT NULL,       -- yes | no
  responded_by_username TEXT NULL,
  responded_by_user_id BIGINT NULL,
  responded_at TIMESTAMPTZ NULL,
  on_time BOOLEAN NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT driver_location_checkin_stop_type_check CHECK (stop_type IN ('shipper', 'receiver')),
  CONSTRAINT driver_location_checkin_status_check CHECK (status IN ('awaiting_response', 'answered', 'expired')),
  CONSTRAINT driver_location_checkin_response_check CHECK (
    driver_response IS NULL OR driver_response IN ('yes', 'no', 'checked_in', 'checked_out')
  )
);

-- One-prompt-per-stop idempotency key. Stable per (group, order|address, stop_type)
-- so a given order's shipper stop (and its receiver stop) is prompted at most once,
-- and null-order fallback loads dedupe on the target address instead. The UNIQUE
-- partial index below makes a concurrent double-claim insert fail (23505) rather
-- than send a second prompt.
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS dedupe_key TEXT NULL;

-- Two-phase check-in flow: the driver taps "Checked In" on arrival (that button
-- disappears, "Checked Out" stays) and "Checked Out" on departure. Both moments
-- are stamped so checked_out_at - checked_in_at gives the facility dwell time,
-- building the dataset that will later predict how long drivers stay at a given
-- facility (grouped by location_address). Who tapped is stored per phase.
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ NULL;
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMPTZ NULL;
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_in_by_username TEXT NULL;
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_in_by_user_id BIGINT NULL;
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_out_by_username TEXT NULL;
ALTER TABLE driver_location_checkins ADD COLUMN IF NOT EXISTS checked_out_by_user_id BIGINT NULL;

-- Status now walks awaiting_response → checked_in (at the facility) → completed.
-- 'answered' and 'expired' remain for legacy rows / stale prompts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'driver_location_checkin_status_check'
      AND table_name = 'driver_location_checkins'
  ) THEN
    ALTER TABLE driver_location_checkins DROP CONSTRAINT driver_location_checkin_status_check;
  END IF;
END
$$;

ALTER TABLE driver_location_checkins
  ADD CONSTRAINT driver_location_checkin_status_check
  CHECK (status IN ('awaiting_response', 'answered', 'checked_in', 'completed', 'expired'));

-- The buttons became "Checked In"/"Checked Out" (was Yes/No); widen the allowed
-- responses on pre-existing deployments without dropping historic 'yes'/'no' rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'driver_location_checkin_response_check'
      AND table_name = 'driver_location_checkins'
  ) THEN
    ALTER TABLE driver_location_checkins DROP CONSTRAINT driver_location_checkin_response_check;
  END IF;
END
$$;

ALTER TABLE driver_location_checkins
  ADD CONSTRAINT driver_location_checkin_response_check
  CHECK (driver_response IS NULL OR driver_response IN ('yes', 'no', 'checked_in', 'checked_out'));

CREATE INDEX IF NOT EXISTS idx_driver_location_checkins_group_created
  ON driver_location_checkins(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_location_checkins_monitor
  ON driver_location_checkins(monitor_id, created_at DESC);

-- At-most-once prompt per stop signature. Concurrent claims racing to prompt the
-- same stop collide on this index; the loser catches the unique violation and
-- treats the stop as already prompted (no duplicate message).
CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_location_checkins_stop_once
  ON driver_location_checkins(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- TABLE: bot_users — every Telegram user the bot sees, keyed by stable
-- telegram_user_id. Originally only inline-button tappers (interactions); now
-- ALSO everyone who texts in a group the bot is in (message_count), so the
-- admin Users tab shows anyone the bot has observed. Distinct from
-- group_members (per-group membership snapshots).
CREATE TABLE IF NOT EXISTS bot_users (
  telegram_user_id BIGINT PRIMARY KEY,
  username TEXT NULL,
  first_name TEXT NULL,
  last_name TEXT NULL,
  interactions INTEGER NOT NULL DEFAULT 0,
  last_action TEXT NULL,
  last_group_id INTEGER NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enrichment columns (safe, additive migrations). last_seen_chat_id is the raw
-- Telegram chat id; last_group_name a nullable snapshot of the group title;
-- message_count counts messages seen (interactions still counts button taps);
-- source is a coarse role guess (driver|dispatcher|admin|unknown). NO message
-- text is ever stored.
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS last_seen_chat_id BIGINT;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS last_group_name TEXT;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS language_code TEXT;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS source TEXT;

CREATE INDEX IF NOT EXISTS idx_bot_users_last_interaction
  ON bot_users(last_interaction_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- TABLE: eld_settings — single-row store for the live truck-location provider
-- credentials, editable from the admin panel's Settings tab. Samsara stays the
-- primary source; Factor ELD and Leader ELD (both on the shared Drive HoS
-- platform, api.drivehos.app) are the fallbacks, replacing the retired TT/EVO
-- integrations.
--
-- Drive HoS auth needs two keys per request: one shared X-API-Provider-Key
-- (identifies our integration / "AlgoService") and a per-carrier
-- X-API-Company-Key (one for the Factor fleet, one for the Leader fleet). All
-- secrets are stored encrypted with the same AES-256-GCM scheme as Facebook
-- tokens (FACEBOOK_TOKEN_ENCRYPTION_KEY). When a *_encrypted column is NULL the
-- app falls back to the matching environment variable.
CREATE TABLE IF NOT EXISTS eld_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Samsara (primary). API key overrides SAMSARA_API_KEY / SAMSARA_API_KEYS.
  samsara_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  samsara_api_key_encrypted TEXT NULL,
  -- Drive HoS shared provider key (X-API-Provider-Key). Same for both fleets.
  drivehos_provider_key_encrypted TEXT NULL,
  drivehos_api_base TEXT NOT NULL DEFAULT 'https://api.drivehos.app',
  -- Factor ELD carrier company key (X-API-Company-Key).
  factor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  factor_company_key_encrypted TEXT NULL,
  -- Leader ELD carrier company key (X-API-Company-Key).
  leader_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  leader_company_key_encrypted TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO eld_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- TABLE: message_group_settings — single-row store for the Telegram group each
-- bonus / review message category is sent to. These IDs used to be hardcoded
-- constants / default env values (BONUS_GROUP_CHAT_ID, EMPLOYEE_GROUP_ID); they
-- are now edited in the admin panel's Settings → Telegram Groups tab.
--
-- Telegram group IDs are NOT secrets — they are stored and shown in plaintext so
-- an admin can read and edit them. Each category has its OWN destination; enter
-- the same ID in several fields to share a group. When a *_group_id is NULL the
-- app falls back to the matching optional environment variable, and when neither
-- is set the message is NOT sent and a clear configuration error is logged.
CREATE TABLE IF NOT EXISTS message_group_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Extra Mile / Mileage Bonus milestone cards (services/mileageBonusService).
  mileage_bonus_group_id TEXT NULL,
  -- Extra Week / Road Bonus summary posted when a driver comes home over the
  -- road allowance (services/roadBonusNotifierService).
  road_bonus_group_id TEXT NULL,
  -- 72–75 CPM / Dispatch Rate Review request + result summary
  -- (services/raiseApprovalService).
  dispatch_review_group_id TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO message_group_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- RingCentral recruiter-call KPIs.
--
-- The bot polls the RingCentral company Call Log, attributes each call to a
-- recruiter by matching the recruiter's dedicated direct number, and rolls the
-- calls up into per-recruiter daily KPIs (outbound volume + conversation
-- quality by duration) against the recruiter targets. Credentials are entered
-- in the admin Settings tab and stored encrypted (AES-256-GCM, same scheme as
-- Facebook tokens / ELD keys).

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

-- Single-row Google Maps Platform settings + monitoring tunables.
CREATE TABLE IF NOT EXISTS gmaps_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Google Maps Platform server key (encrypted). Overrides GOOGLE_MAPS_API_KEY.
  server_api_key_encrypted TEXT NULL,
  routes_api_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  roads_api_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Optional separate Geocoding key; when empty the server key is used.
  geocoding_api_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  geocoding_api_key_encrypted TEXT NULL,
  -- Monitoring tunables.
  deviation_threshold_meters INTEGER NOT NULL DEFAULT 250
    CHECK (deviation_threshold_meters BETWEEN 10 AND 20000),
  check_interval_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (check_interval_seconds BETWEEN 30 AND 3600),
  off_route_grace_checks INTEGER NOT NULL DEFAULT 3
    CHECK (off_route_grace_checks BETWEEN 1 AND 20),
  warning_cooldown_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (warning_cooldown_minutes BETWEEN 1 AND 1440),
  stale_gps_minutes INTEGER NOT NULL DEFAULT 15
    CHECK (stale_gps_minutes BETWEEN 1 AND 240),
  parked_speed_mph INTEGER NOT NULL DEFAULT 5
    CHECK (parked_speed_mph BETWEEN 0 AND 60),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO gmaps_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Auto-complete a route when the driver's fresh GPS is within this many miles of
-- the FINAL destination. Additive/idempotent; default 50 mi (see
-- services/routeControlConstants.js), recommended range 1–100. The CHECK stays
-- 0.5–100 for backward compatibility with any legacy sub-1-mile value.
ALTER TABLE gmaps_settings ADD COLUMN IF NOT EXISTS route_completion_radius_miles DOUBLE PRECISION NOT NULL DEFAULT 10
  CHECK (route_completion_radius_miles BETWEEN 0.5 AND 100);
ALTER TABLE gmaps_settings ALTER COLUMN route_completion_radius_miles SET DEFAULT 50;

-- One-shot 10 → 35 completion-radius migration. The marker column makes it run
-- exactly once even though this file executes on every boot: an untouched old
-- default of 10 becomes the new default of 35; any other (customized) value is
-- left alone. NOTE: a value of exactly 10 cannot be distinguished from a
-- deliberate choice of 10 — treating it as the old default is the documented
-- decision here (an admin can set it back to 10 afterwards and it will stick).
ALTER TABLE gmaps_settings ADD COLUMN IF NOT EXISTS completion_radius_35_migrated BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE gmaps_settings
   SET route_completion_radius_miles = 35, completion_radius_35_migrated = TRUE
 WHERE id = 1 AND completion_radius_35_migrated = FALSE AND route_completion_radius_miles = 10;
UPDATE gmaps_settings
   SET completion_radius_35_migrated = TRUE
 WHERE id = 1 AND completion_radius_35_migrated = FALSE;

-- One-shot 35 → 50 completion-radius migration (same one-run-only marker
-- pattern). The intended production radius is now 50 mi. A row still sitting on
-- the previous default of 35 is bumped to 50; any other (customized) value —
-- including a deliberate 35 the admin later re-selects — is left untouched.
-- Additive/idempotent: safe to re-run on every boot.
ALTER TABLE gmaps_settings ADD COLUMN IF NOT EXISTS completion_radius_50_migrated BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE gmaps_settings
   SET route_completion_radius_miles = 50, completion_radius_50_migrated = TRUE
 WHERE id = 1 AND completion_radius_50_migrated = FALSE AND route_completion_radius_miles = 35;
UPDATE gmaps_settings
   SET completion_radius_50_migrated = TRUE
 WHERE id = 1 AND completion_radius_50_migrated = FALSE;

-- One assigned route per row. group_id ties it to a driver group so the monitor
-- can resolve that driver's live GPS (via the same resolver as /location).
CREATE TABLE IF NOT EXISTS route_assignments (
  id SERIAL PRIMARY KEY,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  driver_profile_id INTEGER NULL,
  driver_label TEXT NULL,
  unit_number TEXT NULL,
  original_url TEXT NOT NULL,
  origin_text TEXT NULL,
  destination_text TEXT NULL,
  waypoints JSONB NOT NULL DEFAULT '[]'::jsonb,
  origin_lat DOUBLE PRECISION NULL,
  origin_lng DOUBLE PRECISION NULL,
  destination_lat DOUBLE PRECISION NULL,
  destination_lng DOUBLE PRECISION NULL,
  -- Google encoded polyline for the computed route (NULL until computed).
  encoded_polyline TEXT NULL,
  distance_meters DOUBLE PRECISION NULL,
  duration_seconds DOUBLE PRECISION NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled')),
  assigned_by TEXT NULL,
  -- Live monitoring state.
  last_checked_at TIMESTAMPTZ NULL,
  last_latitude DOUBLE PRECISION NULL,
  last_longitude DOUBLE PRECISION NULL,
  last_deviation_meters DOUBLE PRECISION NULL,
  last_check_result TEXT NULL,
  consecutive_off_route INTEGER NOT NULL DEFAULT 0,
  last_notification_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Where the assignment came from: 'admin' (Route Control page) or 'telegram'
-- (a dispatcher sent a Google Maps route link in the driver group). The
-- Telegram origin also records the sender's numeric id and the triggering
-- message id — the (chat, message) pair is a restart-safe dedupe key so the
-- same route message is never processed twice.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS assigned_by_user_id BIGINT NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT NULL;
-- Admin → "Send route message to driver group" delivery tracking. sent_at is the
-- last successful send; message_id the Telegram message id (for a link/edit);
-- sent_by the admin username/name that triggered it.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_sent_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_id BIGINT NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_sent_by TEXT NULL;

-- Tracking start controls. `status` stays the route LIFECYCLE (active/completed/
-- cancelled); `tracking_status` is the MONITORING state layered on top:
--   pending → the start condition has not been met yet (mode decides which)
--   active  → the monitor compares live GPS against the route
-- Existing rows default to active/immediate so the migration changes nothing
-- for routes that are already being monitored. tracking_hold_reason is a short
-- machine-readable reason shown in the admin UI while pending
-- (waiting_for_message | waiting_for_time | waiting_for_location).
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_mode TEXT NOT NULL DEFAULT 'immediate';
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_started_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_lat DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_lng DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_location_text TEXT NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_radius_miles DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_hold_reason TEXT NULL;

-- Auto-completion. When the driver's fresh GPS enters the completion radius
-- around the FINAL destination (destination_lat/destination_lng), the monitor
-- flips status to 'completed', records where/when/how far, and stops monitoring
-- permanently. These columns are additive/idempotent; NULL on every existing row.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completion_latitude DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completion_longitude DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completion_distance_meters DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completion_reason TEXT NULL;

-- Completion diagnostics (why a route is / is not completing) + screenshot send
-- reporting. Written by the monitor on every completion check so the Admin
-- panel can show the live distance to the final destination and a
-- machine-readable blocked reason (e.g. DESTINATION_COORDINATES_MISSING,
-- LIVE_GPS_STALE, OUTSIDE_COMPLETION_RADIUS). All additive/idempotent.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS last_completion_check_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS last_destination_distance_meters DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completion_blocked_reason TEXT NULL;
-- Bounded destination-coordinate repair bookkeeping (never retried every tick).
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS destination_repair_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS destination_repair_last_at TIMESTAMPTZ NULL;
-- How the last driver-group route message went out (photo | photo+text | text)
-- and the last screenshot delivery error (NULL when the screenshot was sent or
-- there was none) — lets the Admin panel say "Sent as text only" truthfully.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_via TEXT NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS screenshot_send_error TEXT NULL;

-- One route delivery can be MORE than one Telegram message (a photo plus a
-- separate long-text message). To later EDIT every part in place (replace the
-- screenshot / edit the text) without posting new messages, store the ordered
-- list of Telegram messages that make up the delivery:
--   [{ "message_id": 71, "kind": "photo" }, { "message_id": 72, "kind": "text" }]
-- driver_group_messages is the authoritative record used for in-place editing;
-- it survives restart/redeploy/logout because it lives in the DB, not memory.
-- Legacy rows (NULL here) are reconstructed from driver_group_message_id +
-- driver_group_message_via. driver_group_message_edited_at / _edit_error record
-- the last in-place edit outcome so the admin panel can report it truthfully.
-- All additive/idempotent; NULL on every existing row.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_messages JSONB NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_edited_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_edit_error TEXT NULL;

-- Route screenshots (admin-attached images sent with the driver-group route
-- message). A SEPARATE table so no existing `SELECT r.*` query ever drags image
-- bytes into list views; bytes are only read by the dedicated fetch used for
-- Telegram sends and the auth-gated preview endpoint. One screenshot per
-- assignment (replaced on re-upload).
CREATE TABLE IF NOT EXISTS route_assignment_attachments (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES route_assignments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'route_screenshot',
  mime_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  file_data BYTEA NOT NULL,
  uploaded_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_route_assignment_attachments_assignment
  ON route_assignment_attachments(assignment_id, kind);

-- Enforce ONE screenshot per (assignment, kind) so replacement can be a single
-- atomic UPSERT (a failed replacement can never destroy the stored screenshot,
-- and two concurrent uploads can never leave duplicates). The DELETE below
-- clears any pre-constraint duplicates (keeps the newest row) and is a no-op on
-- every later boot.
DELETE FROM route_assignment_attachments a
 USING route_assignment_attachments b
 WHERE a.assignment_id = b.assignment_id AND a.kind = b.kind AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_route_assignment_attachment
  ON route_assignment_attachments(assignment_id, kind);

CREATE INDEX IF NOT EXISTS idx_route_assignments_active
  ON route_assignments(status, updated_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_route_assignments_group
  ON route_assignments(group_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_route_assignments_telegram_message
  ON route_assignments(telegram_chat_id, telegram_message_id)
  WHERE telegram_chat_id IS NOT NULL AND telegram_message_id IS NOT NULL;

-- Audit trail of monitoring checks + notifications for one assignment.
CREATE TABLE IF NOT EXISTS route_monitor_events (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES route_assignments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  result TEXT NULL,
  latitude DOUBLE PRECISION NULL,
  longitude DOUBLE PRECISION NULL,
  deviation_meters DOUBLE PRECISION NULL,
  detail TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_monitor_events_assignment
  ON route_monitor_events(assignment_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Duplicate unit-number reports (Samsara / provider ↔ driver-group mismatches).
--
-- When two active driver groups carry the same truck/unit number, or a provider
-- vehicle label lists a different driver than the group it is matched to, the bot
-- can pick the wrong truck in /location and live tracking. A 15-minute sanity
-- check records these situations here for admin review instead of guessing. Rows
-- are keyed by (unit_number, report_type) and reopened/refreshed each run; issues
-- that disappear are auto-resolved.
CREATE TABLE IF NOT EXISTS duplicate_unit_reports (
  id SERIAL PRIMARY KEY,
  unit_number TEXT NOT NULL,
  -- duplicate_unit  = same unit across >1 active driver group
  -- name_mismatch   = provider vehicle label's driver ≠ the group's driver
  -- ambiguous_match = duplicate unit AND no confident driver-name winner
  report_type TEXT NOT NULL CHECK (report_type IN ('duplicate_unit', 'name_mismatch', 'ambiguous_match')),
  group_ids INTEGER[] NOT NULL DEFAULT '{}',
  group_names TEXT[] NOT NULL DEFAULT '{}',
  group_driver_name TEXT,
  provider TEXT,
  provider_driver_name TEXT,
  detail TEXT,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'serious')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  UNIQUE (unit_number, report_type)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_unit_reports_open
  ON duplicate_unit_reports(status, last_seen_at DESC) WHERE status = 'open';

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

-- Master list of trailers (one row per unit number).
CREATE TABLE IF NOT EXISTS trailers (
  id SERIAL PRIMARY KEY,
  unit_number TEXT UNIQUE NOT NULL,
  make TEXT NULL,
  model TEXT NULL,
  mc_number TEXT NULL,
  plate_number TEXT NULL,
  type TEXT NULL,
  vin TEXT NULL,
  year TEXT NULL,
  ownership_status TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'admin_manual' | 'screenshot_import' | 'telegram_detected'
  source TEXT NOT NULL DEFAULT 'admin_manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailers_unit_number ON trailers(unit_number);
CREATE INDEX IF NOT EXISTS idx_trailers_plate ON trailers(plate_number);
CREATE INDEX IF NOT EXISTS idx_trailers_vin ON trailers(vin);

-- Immutable event ledger — one row per detected/registered pickup, drop-off,
-- mention, or unidentified command. The (telegram_group_id, telegram_message_id)
-- pair is the dedupe guard: the same Telegram message can never create two rows.
CREATE TABLE IF NOT EXISTS trailer_events (
  id BIGSERIAL PRIMARY KEY,
  trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE SET NULL,
  trailer_unit_number TEXT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('pickup', 'dropoff', 'mention_only', 'unidentified')),
  -- Two-dimension status: possession (who holds it) + cargo (loaded/empty).
  possession_status TEXT NOT NULL DEFAULT 'unknown',   -- with_driver | dropped | unknown
  cargo_status TEXT NOT NULL DEFAULT 'unknown',         -- empty | loaded | unknown
  confidence SMALLINT NULL,
  driver_group_id INTEGER NULL REFERENCES groups(id) ON DELETE SET NULL,
  telegram_group_id BIGINT NULL,
  telegram_group_name TEXT NULL,
  driver_profile_id INTEGER NULL REFERENCES driver_profiles(id) ON DELETE SET NULL,
  driver_name TEXT NULL,
  reported_by_telegram_user_id BIGINT NULL,
  reported_by_username TEXT NULL,
  reported_by_name TEXT NULL,
  reported_driver_name_from_message TEXT NULL,
  location_text TEXT NULL,
  location_lat DOUBLE PRECISION NULL,
  location_lng DOUBLE PRECISION NULL,
  location_missing BOOLEAN NOT NULL DEFAULT FALSE,
  condition_text TEXT NULL,
  event_date_text TEXT NULL,
  event_time TIMESTAMPTZ NULL,
  telegram_message_id BIGINT NULL,
  telegram_media_group_id TEXT NULL,
  -- Photo/file evidence and any structured extras (Telegram file_ids, etc.).
  evidence JSONB NULL,
  raw_message_text TEXT NULL,
  ai_summary TEXT NULL,
  unidentified_reason TEXT NULL,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  reported_to_test_group BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'telegram',   -- 'telegram' | 'admin_manual'
  beta_mode BOOLEAN NOT NULL DEFAULT TRUE,
  -- Multi-event support: one Telegram message may name several trailers, so the
  -- dedupe key is (group, message, event_index) rather than (group, message).
  -- Existing rows default to 0 (they were always the single event per message).
  event_index INTEGER NOT NULL DEFAULT 0,
  -- Review workflow (accept / decline / edit). Historical rows are treated as
  -- already-accepted; only NEW auto-detected pickup/dropoff events start pending.
  review_status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (review_status IN ('pending', 'accepted', 'declined', 'edited')),
  reviewed_by TEXT NULL,
  reviewed_at TIMESTAMPTZ NULL,
  review_note TEXT NULL,
  corrected_by TEXT NULL,
  corrected_at TIMESTAMPTZ NULL,
  correction_note TEXT NULL,
  superseded_by_event_id BIGINT NULL,
  original_event_snapshot JSONB NULL,
  -- Location precision provenance: exact | geocoded | approximate_state |
  -- derived_from_driver | text_only | manual (see services/trailerGeocodeService).
  location_source TEXT NULL,
  location_confidence SMALLINT NULL,
  geocoded_at TIMESTAMPTZ NULL,
  geocode_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_events_trailer ON trailer_events(trailer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trailer_events_type ON trailer_events(event_type, created_at DESC);
-- Additive migration for databases created before the review/multi-event
-- columns existed (CREATE TABLE IF NOT EXISTS above is a no-op on them). Every
-- statement is idempotent (ADD COLUMN IF NOT EXISTS) so re-running is safe and
-- can never fail boot.
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS event_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'accepted';
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS reviewed_by TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS review_note TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS corrected_by TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS correction_note TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS superseded_by_event_id BIGINT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS original_event_snapshot JSONB NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS location_source TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS location_confidence SMALLINT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS geocode_error TEXT NULL;
-- Two-dimension status model (unified trailer state service). Possession is who
-- holds the trailer; cargo is whether it carries a load. Plain TEXT (validated
-- in app code) so re-running these ALTERs can never fail on a named CHECK.
-- Values: possession_status ∈ with_driver | dropped | unknown
--         cargo_status      ∈ empty | loaded | unknown
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS possession_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS cargo_status TEXT NOT NULL DEFAULT 'unknown';
-- Semantic AI verification audit (mandatory verification layer). Every
-- Telegram-registered pickup/drop-off records WHY it was allowed: the verified
-- intent, per-event completion + confidence, how the unit was grounded
-- (current/replied text/caption or image), the exact evidence quotes, and the
-- verification status (approved | review | rejected | unavailable |
-- invalid_response). raw_ai_result stores the sanitized normalized AI JSON —
-- never full prompts or conversation history.
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS semantic_intent TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS semantic_completed BOOLEAN NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS semantic_confidence SMALLINT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS semantic_reason TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS unit_grounded BOOLEAN NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS unit_source TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS unit_evidence TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS action_evidence TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS ai_model TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS ai_verified_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS ai_verification_status TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS raw_ai_result JSONB NULL;
-- Dedupe guard (multi-event): at most one event per (group, message, event_index).
-- Partial so admin_manual rows (message_id NULL) are never blocked.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trailer_events_tg_message_event
  ON trailer_events(telegram_group_id, telegram_message_id, event_index)
  WHERE telegram_group_id IS NOT NULL AND telegram_message_id IS NOT NULL;
-- Retire the old 2-column dedupe index (superseded by the 3-column one above).
-- IF EXISTS keeps this safe on both fresh installs and already-migrated DBs.
DROP INDEX IF EXISTS uniq_trailer_events_tg_message;

-- Fast "where is each trailer now" snapshot, maintained from the latest
-- pickup/dropoff event. One row per trailer.
CREATE TABLE IF NOT EXISTS trailer_current_status (
  trailer_id INTEGER PRIMARY KEY REFERENCES trailers(id) ON DELETE CASCADE,
  unit_number TEXT NOT NULL,
  current_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (current_status IN ('with_driver', 'dropped', 'unknown')),
  -- Unified state model. possession_status mirrors current_status (kept in sync
  -- for clarity); cargo_status + display_status are the new two-dimension view.
  possession_status TEXT NOT NULL DEFAULT 'unknown',   -- with_driver | dropped | unknown
  cargo_status TEXT NOT NULL DEFAULT 'unknown',         -- empty | loaded | unknown
  display_status TEXT NULL,                             -- e.g. 'Dropped / Empty'
  current_driver_group_id INTEGER NULL REFERENCES groups(id) ON DELETE SET NULL,
  current_driver_profile_id INTEGER NULL REFERENCES driver_profiles(id) ON DELETE SET NULL,
  current_driver_name TEXT NULL,
  current_location_text TEXT NULL,
  current_lat DOUBLE PRECISION NULL,
  current_lng DOUBLE PRECISION NULL,
  current_condition TEXT NULL,
  last_reporter_name TEXT NULL,
  last_event_id BIGINT NULL REFERENCES trailer_events(id) ON DELETE SET NULL,
  last_event_type TEXT NULL,
  last_event_at TIMESTAMPTZ NULL,
  -- Set when the latest pickup/dropoff event is still pending human review.
  -- Drives the "• review" badge and the drawer review panel.
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  pending_event_id BIGINT NULL,
  -- Precision of current_lat/current_lng (mirrors trailer_events.location_source).
  location_source TEXT NULL,
  location_confidence SMALLINT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_current_status_unit ON trailer_current_status(unit_number);
CREATE INDEX IF NOT EXISTS idx_trailer_current_status_state ON trailer_current_status(current_status);
-- Additive migration for pre-review databases (idempotent).
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS pending_event_id BIGINT NULL;
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS location_source TEXT NULL;
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS location_confidence SMALLINT NULL;
-- Two-dimension status (unified state service). Backfill possession_status from
-- the legacy current_status once; cargo defaults to unknown until the next event.
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS possession_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS cargo_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS display_status TEXT NULL;
UPDATE trailer_current_status
   SET possession_status = current_status
 WHERE possession_status = 'unknown' AND current_status IN ('with_driver', 'dropped');

-- Admin screenshot-import batches (one per uploaded image set).
CREATE TABLE IF NOT EXISTS trailer_import_batches (
  id SERIAL PRIMARY KEY,
  uploaded_by TEXT NULL,
  file_name TEXT NULL,
  status TEXT NOT NULL DEFAULT 'parsed'
    CHECK (status IN ('parsed', 'committed', 'failed')),
  parsed_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  raw_ai_result JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extracted rows for a batch (admin reviews/edits before commit).
CREATE TABLE IF NOT EXISTS trailer_import_rows (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES trailer_import_batches(id) ON DELETE CASCADE,
  unit_number TEXT NULL,
  make TEXT NULL,
  model TEXT NULL,
  mc_number TEXT NULL,
  plate_number TEXT NULL,
  type TEXT NULL,
  vin TEXT NULL,
  year TEXT NULL,
  ownership_status TEXT NULL,
  confidence SMALLINT NULL,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  raw_row JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_import_rows_batch ON trailer_import_rows(batch_id);

-- Single-row runtime settings for the Trailer feature (Beta). Admin-editable.
CREATE TABLE IF NOT EXISTS trailer_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  beta_mode BOOLEAN NOT NULL DEFAULT TRUE,
  -- NULL → fall back to config.trailerTestGroupId (env).
  automatic_update_test_group_id TEXT NULL,
  send_driver_group_confirmation BOOLEAN NOT NULL DEFAULT TRUE,
  send_reaction BOOLEAN NOT NULL DEFAULT TRUE,
  ai_fallback_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  geocoding_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO trailer_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
-- Semantic-verification settings (additive, idempotent).
--   semantic_ai_required: when TRUE (default) no Telegram trailer message may
--     change status without passing AI semantic verification — if the AI is
--     unavailable the candidate FAILS CLOSED to review.
--   auto_register_confidence: minimum per-event AI confidence for automatic
--     registration (default 92).
--   review_confidence: minimum confidence for a review item (default 75);
--     below this, candidates are ignored.
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS semantic_ai_required BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS auto_register_confidence SMALLINT NOT NULL DEFAULT 92;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS review_confidence SMALLINT NOT NULL DEFAULT 75;
-- Silent driver-group monitoring (default TRUE): trailer messages are analyzed
-- and registered WITHOUT any reply or reaction in the driver group. When TRUE it
-- overrides send_driver_group_confirmation and send_reaction (kept for the
-- explicit opt-out where an admin turns silent mode off). The internal Automatic
-- Updating (Test) group still receives review alerts either way.
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS silent_driver_group_monitoring BOOLEAN NOT NULL DEFAULT TRUE;

-- Pending trailer INSTRUCTIONS (planned/assigned pickup or drop-off) — a small
-- additive structure that keeps INSTRUCTIONS separate from COMPLETED events.
--
-- Root-cause fix: a message like "Trailer DROP OFF address / trl # VM709984 /
-- 1375 Jersey Ave …" is an assignment, NOT a completed drop-off. It must never
-- change trailer_current_status. Instead we record the planned action + planned
-- location here and wait for a later message that CONFIRMS the physical action.
-- No fake completed trailer_event is ever created just to hold an instruction.
--
-- instruction_status: pending → waiting for a completed-action confirmation;
--   confirmed → a later completed event fulfilled it (confirmed_event_id set);
--   superseded → a newer instruction/correction replaced it; cancelled → admin.
CREATE TABLE IF NOT EXISTS trailer_pending_instructions (
  id BIGSERIAL PRIMARY KEY,
  trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE SET NULL,
  trailer_unit_number TEXT NOT NULL,
  planned_action TEXT NOT NULL CHECK (planned_action IN ('pickup', 'dropoff')),
  planned_location TEXT NULL,
  planned_lat DOUBLE PRECISION NULL,
  planned_lng DOUBLE PRECISION NULL,
  driver_group_id INTEGER NULL REFERENCES groups(id) ON DELETE SET NULL,
  telegram_group_id BIGINT NULL,
  telegram_group_name TEXT NULL,
  instruction_source_message_id BIGINT NULL,
  reported_by_telegram_user_id BIGINT NULL,
  reported_by_username TEXT NULL,
  reported_by_name TEXT NULL,
  semantic_intent TEXT NULL,
  semantic_confidence SMALLINT NULL,
  ai_reason TEXT NULL,
  raw_message_text TEXT NULL,
  instruction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (instruction_status IN ('pending', 'confirmed', 'superseded', 'cancelled')),
  confirmed_event_id BIGINT NULL,
  instruction_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_pending_instructions_unit
  ON trailer_pending_instructions(trailer_unit_number, instruction_status);
CREATE INDEX IF NOT EXISTS idx_trailer_pending_instructions_status
  ON trailer_pending_instructions(instruction_status, instruction_created_at DESC);
-- One instruction per (group, source message, unit, action): a re-delivered
-- Telegram message never creates a duplicate. Partial so admin/manual rows
-- (no source message) are not blocked.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trailer_pending_instructions_msg
  ON trailer_pending_instructions(telegram_group_id, instruction_source_message_id, trailer_unit_number, planned_action)
  WHERE telegram_group_id IS NOT NULL AND instruction_source_message_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- BOL / POD document forwarding (admin-controlled) — Settings → BOL / POD
-- ══════════════════════════════════════════════════════════════════════════
-- Runtime-editable routing for forwarding DataTruck BOL/POD documents to
-- Telegram groups. Single-row (id = 1). OFF by default: after deploy NO document
-- is forwarded to ANY group until an administrator enables the feature in the
-- admin panel. This is a NEW table — the retired bol_pod_monitor_settings table
-- (a different, removed feature) is left untouched for historical safety and is
-- NOT reused. No secrets are stored here (the bot token stays server-side).
CREATE TABLE IF NOT EXISTS bol_pod_forwarding_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_mode TEXT NOT NULL DEFAULT 'driver_group'
    CHECK (delivery_mode IN ('driver_group', 'central_group', 'both')),
  central_group_id BIGINT NULL,
  central_group_title TEXT NULL,
  central_group_validated_at TIMESTAMPTZ NULL,
  document_type_mode TEXT NOT NULL DEFAULT 'both'
    CHECK (document_type_mode IN ('bol', 'pod', 'both')),
  uncertain_document_policy TEXT NOT NULL DEFAULT 'do_not_send'
    CHECK (uncertain_document_policy IN ('do_not_send', 'central_review')),
  last_tested_at TIMESTAMPTZ NULL,
  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO bol_pod_forwarding_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- TRAILER DEPARTMENT: RENTAL + ASSET MANAGEMENT
-- Additive/idempotent. Existing trailer tracking/event history is preserved.
-- =============================================================================

-- Admin account lifecycle and database-backed RBAC.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE admins ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  permission_key TEXT UNIQUE NOT NULL,
  description TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  system_key TEXT UNIQUE NULL,
  display_name TEXT UNIQUE NOT NULL,
  description TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_user_roles (
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (admin_id, role_id)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

INSERT INTO roles (system_key, display_name, description) VALUES
  ('super_admin', 'Super Administrator', 'All application permissions'),
  ('trailer_manager', 'Trailer Manager', 'Full Trailer Department management'),
  ('trailer_employee', 'Trailer Employee', 'Daily trailer rental operations'),
  ('trailer_accounting', 'Trailer Accounting', 'Trailer invoices, payments and reports'),
  ('trailer_viewer', 'Trailer Viewer', 'Read-only Trailer Department access')
ON CONFLICT (system_key) DO NOTHING;

INSERT INTO permissions (permission_key, description) VALUES
  ('admin.full_access', 'Access legacy and company-wide administration'),
  ('users.manage', 'Manage administrator accounts'),
  ('roles.manage', 'Manage roles and permissions'),
  ('trailers.view', 'View trailer records'),
  ('trailers.create', 'Create trailer records'),
  ('trailers.edit', 'Edit trailer records'),
  ('trailers.delete_or_archive', 'Archive trailer records'),
  ('trailer_rentals.view', 'View trailer rentals'),
  ('trailer_rentals.create', 'Create trailer rentals'),
  ('trailer_rentals.edit', 'Edit trailer rentals'),
  ('trailer_rentals.close', 'Return and close trailer rentals'),
  ('trailer_companies.manage', 'Manage renter companies'),
  ('trailer_inspections.manage', 'Manage inspections and condition media'),
  ('trailer_payments.view', 'View trailer invoices and payments'),
  ('trailer_payments.record', 'Record trailer payments'),
  ('trailer_payments.record_without_receipt', 'Record a payment without a receipt and with a reason'),
  ('trailer_payments.reverse', 'Reverse trailer payments'),
  ('trailer_receipts.view', 'View payment receipts'),
  ('trailer_reports.view', 'View and export trailer reports'),
  ('trailer_settings.manage', 'Manage trailer settings and Telegram delivery'),
  ('trailer_users.manage', 'Manage Trailer Department users'),
  ('trailer_map.view', 'View the trailer-only map')
ON CONFLICT (permission_key) DO NOTHING;

-- Super administrators receive every permission. Existing admins retain their
-- former full access. System role display names remain editable; system_key is
-- the stable authorization identifier.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'trailer_manager'
  AND (p.permission_key LIKE 'trailer%' OR p.permission_key LIKE 'trailers.%')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'trailer_employee'
  AND p.permission_key IN (
    'trailers.view','trailers.create','trailers.edit','trailer_rentals.view',
    'trailer_rentals.create','trailer_rentals.edit','trailer_rentals.close',
    'trailer_companies.manage','trailer_inspections.manage','trailer_payments.view',
    'trailer_payments.record','trailer_receipts.view','trailer_map.view'
  )
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'trailer_accounting'
  AND p.permission_key IN (
    'trailers.view','trailer_rentals.view','trailer_payments.view',
    'trailer_payments.record','trailer_payments.reverse',
    'trailer_payments.record_without_receipt','trailer_receipts.view',
    'trailer_reports.view'
  )
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'trailer_viewer'
  AND p.permission_key IN (
    'trailers.view','trailer_rentals.view','trailer_payments.view',
    'trailer_receipts.view','trailer_reports.view','trailer_map.view'
  )
ON CONFLICT DO NOTHING;

INSERT INTO admin_user_roles (admin_id, role_id)
SELECT a.id, r.id FROM admins a JOIN roles r ON r.system_key = 'super_admin'
WHERE NOT EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.admin_id = a.id)
ON CONFLICT DO NOTHING;

-- Required operator login. This is a salted bcrypt cost-12 hash only; the seed
-- never updates an existing account and therefore never resets a changed password.
INSERT INTO admins (username, password_hash, active)
VALUES ('Trailer', '$2a$12$GuO8j3DGuDzHA7oo9d2IiO8F.3KEAjyRh0OA7CIPZk/wxxQS1nTdu', TRUE)
ON CONFLICT (username) DO NOTHING;
INSERT INTO admin_user_roles (admin_id, role_id)
SELECT a.id, r.id FROM admins a JOIN roles r ON r.system_key = 'trailer_manager'
WHERE a.username = 'Trailer'
ON CONFLICT DO NOTHING;

-- Trailer master additions. Existing records remain unknown/unreviewed until an
-- employee verifies physical availability; Telegram possession/cargo is separate.
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS physical_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS tracking_reference TEXT NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
UPDATE trailers SET needs_review = TRUE WHERE physical_status = 'unknown';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailers_physical_status_check') THEN
    ALTER TABLE trailers ADD CONSTRAINT trailers_physical_status_check CHECK (
      physical_status IN ('unknown','available','rented','under_inspection','maintenance','out_of_service','held_damage')
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS trailer_renter_companies (
  id BIGSERIAL PRIMARY KEY,
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mc_number TEXT NULL,
  dot_number TEXT NULL,
  billing_address TEXT NULL,
  contact_name TEXT NULL,
  phone TEXT NULL,
  email TEXT NULL,
  telegram_username TEXT NULL,
  telegram_user_id TEXT NULL,
  payment_terms TEXT NULL,
  default_currency TEXT NOT NULL DEFAULT 'USD' CHECK (default_currency = 'USD'),
  default_daily_rate NUMERIC(14,2) NULL,
  tax_reference TEXT NULL,
  notes TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_companies_active_name ON trailer_renter_companies(active, display_name);

CREATE TABLE IF NOT EXISTS trailer_rentals (
  id BIGSERIAL PRIMARY KEY,
  agreement_number TEXT UNIQUE NOT NULL,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  company_id BIGINT NOT NULL REFERENCES trailer_renter_companies(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','returned','closed','cancelled','disputed')),
  start_at TIMESTAMPTZ NULL,
  expected_return_at TIMESTAMPTZ NULL,
  actual_return_at TIMESTAMPTZ NULL,
  billing_method TEXT NOT NULL DEFAULT 'calendar_day' CHECK (billing_method IN ('calendar_day','twenty_four_hour','manual_days','flat_rate')),
  daily_rate NUMERIC(14,2) NULL,
  flat_rate NUMERIC(14,2) NULL,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  deposit_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  late_fee_rule JSONB NULL,
  grace_period_days INTEGER NOT NULL DEFAULT 0,
  payment_due_at TIMESTAMPTZ NULL,
  payment_terms TEXT NULL,
  pickup_location TEXT NULL,
  pickup_lat DOUBLE PRECISION NULL,
  pickup_lng DOUBLE PRECISION NULL,
  return_location TEXT NULL,
  return_lat DOUBLE PRECISION NULL,
  return_lng DOUBLE PRECISION NULL,
  current_reported_location TEXT NULL,
  manual_billable_days INTEGER NULL,
  manual_days_reason TEXT NULL,
  manual_days_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  manual_days_recorded_at TIMESTAMPTZ NULL,
  billable_days INTEGER NULL,
  elapsed_days NUMERIC(12,4) NULL,
  notes TEXT NULL,
  agreement_media_id BIGINT NULL,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  closed_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ NULL,
  CHECK (status NOT IN ('scheduled','active') OR (start_at IS NOT NULL AND expected_return_at IS NOT NULL AND expected_return_at > start_at)),
  CHECK (billing_method <> 'manual_days' OR status = 'draft' OR (manual_billable_days > 0 AND manual_days_reason IS NOT NULL)),
  CHECK (billing_method <> 'flat_rate' OR flat_rate IS NOT NULL),
  CHECK (billing_method IN ('flat_rate') OR daily_rate IS NOT NULL OR status = 'draft')
);
CREATE INDEX IF NOT EXISTS idx_trailer_rentals_trailer_status ON trailer_rentals(trailer_id, status);
CREATE INDEX IF NOT EXISTS idx_trailer_rentals_company_status ON trailer_rentals(company_id, status);
CREATE INDEX IF NOT EXISTS idx_trailer_rentals_dates ON trailer_rentals(start_at, expected_return_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trailer_one_active_rental ON trailer_rentals(trailer_id) WHERE status = 'active';

CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailer_rentals_no_scheduled_overlap') THEN
    ALTER TABLE trailer_rentals ADD CONSTRAINT trailer_rentals_no_scheduled_overlap
      EXCLUDE USING gist (
        trailer_id WITH =,
        tstzrange(start_at, expected_return_at, '[)') WITH &&
      ) WHERE (status IN ('scheduled','active'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS trailer_inspections (
  id BIGSERIAL PRIMARY KEY,
  rental_id BIGINT NOT NULL REFERENCES trailer_rentals(id) ON DELETE RESTRICT,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  inspection_type TEXT NOT NULL CHECK (inspection_type IN ('pickup','return','damage','maintenance')),
  overall_condition TEXT NULL,
  tires TEXT NULL, lights TEXT NULL, doors TEXT NULL, roof TEXT NULL,
  floor TEXT NULL, exterior TEXT NULL, interior TEXT NULL,
  landing_gear TEXT NULL, brakes TEXT NULL, existing_damage TEXT NULL,
  new_damage TEXT NULL, missing_equipment TEXT NULL, notes TEXT NULL,
  inspector_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rental_id, inspection_type)
);

CREATE TABLE IF NOT EXISTS trailer_rental_movements (
  id BIGSERIAL PRIMARY KEY,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  rental_id BIGINT NULL REFERENCES trailer_rentals(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('rental_pickup','rental_return','relocation','company_transfer','maintenance_move','manual_correction')),
  from_location TEXT NULL, to_location TEXT NULL,
  from_lat DOUBLE PRECISION NULL, from_lng DOUBLE PRECISION NULL,
  to_lat DOUBLE PRECISION NULL, to_lng DOUBLE PRECISION NULL,
  event_at TIMESTAMPTZ NOT NULL,
  employee_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'rental_manual',
  notes TEXT NULL,
  inspection_id BIGINT NULL REFERENCES trailer_inspections(id) ON DELETE SET NULL,
  trailer_event_id BIGINT NULL REFERENCES trailer_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_movements_trailer_time ON trailer_rental_movements(trailer_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_trailer_movements_rental ON trailer_rental_movements(rental_id);

CREATE TABLE IF NOT EXISTS trailer_media (
  id BIGSERIAL PRIMARY KEY,
  media_type TEXT NOT NULL CHECK (media_type IN ('pickup_condition_photo','return_condition_photo','damage_photo','payment_receipt','agreement_document','invoice_document','other_rental_document')),
  trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  rental_id BIGINT NULL REFERENCES trailer_rentals(id) ON DELETE RESTRICT,
  inspection_id BIGINT NULL REFERENCES trailer_inspections(id) ON DELETE RESTRICT,
  invoice_id BIGINT NULL,
  payment_id BIGINT NULL,
  bucket TEXT NOT NULL,
  object_path TEXT NOT NULL,
  preview_object_path TEXT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_size_bytes BIGINT NOT NULL,
  compressed_size_bytes BIGINT NULL,
  checksum_sha256 TEXT NOT NULL,
  uploaded_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  notes TEXT NULL,
  superseded_by_media_id BIGINT NULL REFERENCES trailer_media(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bucket, object_path)
);
CREATE INDEX IF NOT EXISTS idx_trailer_media_rental ON trailer_media(rental_id, media_type);

CREATE TABLE IF NOT EXISTS trailer_invoices (
  id BIGSERIAL PRIMARY KEY,
  invoice_number TEXT UNIQUE NOT NULL,
  rental_id BIGINT NOT NULL REFERENCES trailer_rentals(id) ON DELETE RESTRICT,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  company_id BIGINT NOT NULL REFERENCES trailer_renter_companies(id) ON DELETE RESTRICT,
  billing_period_start TIMESTAMPTZ NOT NULL,
  billing_period_end TIMESTAMPTZ NOT NULL,
  billing_method TEXT NOT NULL,
  billable_days INTEGER NULL,
  daily_rate NUMERIC(14,2) NULL,
  flat_rate NUMERIC(14,2) NULL,
  base_amount NUMERIC(14,2) NOT NULL,
  deposit_credit NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  damage_charge NUMERIC(14,2) NOT NULL DEFAULT 0,
  cleaning_charge NUMERIC(14,2) NOT NULL DEFAULT 0,
  late_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_charges NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(14,2) NOT NULL,
  late_fee_rule JSONB NULL,
  grace_period_days INTEGER NOT NULL DEFAULT 0,
  calculation_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  due_at TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid','overdue','disputed','voided')),
  reminder_state TEXT NOT NULL DEFAULT 'active' CHECK (reminder_state IN ('active','paused','snoozed','waived')),
  snoozed_until TIMESTAMPTZ NULL,
  notes TEXT NULL,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  finalized_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_invoices_due_status ON trailer_invoices(due_at, status);
CREATE INDEX IF NOT EXISTS idx_trailer_invoices_company ON trailer_invoices(company_id, created_at DESC);

-- Idempotent additions for databases where these tables predate this section.
ALTER TABLE trailer_rentals ADD COLUMN IF NOT EXISTS manual_days_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE trailer_rentals ADD COLUMN IF NOT EXISTS manual_days_recorded_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_invoices ADD COLUMN IF NOT EXISTS late_fee_rule JSONB NULL;
ALTER TABLE trailer_invoices ADD COLUMN IF NOT EXISTS grace_period_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trailer_invoices ADD COLUMN IF NOT EXISTS calculation_inputs JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS trailer_invoice_adjustments (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES trailer_invoices(id) ON DELETE RESTRICT,
  adjustment_type TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  reason TEXT NOT NULL,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trailer_payments (
  id BIGSERIAL PRIMARY KEY,
  receipt_number TEXT UNIQUE NOT NULL,
  invoice_id BIGINT NOT NULL REFERENCES trailer_invoices(id) ON DELETE RESTRICT,
  rental_id BIGINT NOT NULL REFERENCES trailer_rentals(id) ON DELETE RESTRICT,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  company_id BIGINT NOT NULL REFERENCES trailer_renter_companies(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  payment_at TIMESTAMPTZ NOT NULL,
  payment_method TEXT NOT NULL,
  reference_number TEXT NULL,
  notes TEXT NULL,
  receipt_media_id BIGINT NULL REFERENCES trailer_media(id) ON DELETE RESTRICT,
  receipt_bypass_reason TEXT NULL,
  idempotency_key TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'recorded' CHECK (verification_status IN ('recorded','verified','rejected','reversed')),
  recorded_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  verified_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_id, idempotency_key),
  CHECK (receipt_media_id IS NOT NULL OR receipt_bypass_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_trailer_payments_invoice ON trailer_payments(invoice_id, verification_status);

CREATE TABLE IF NOT EXISTS trailer_payment_reversals (
  id BIGSERIAL PRIMARY KEY,
  payment_id BIGINT UNIQUE NOT NULL REFERENCES trailer_payments(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  reversed_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trailer_notification_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('payment_confirmation','overdue_reminder','manual_test')),
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  telegram_chat_id TEXT NULL,
  telegram_message_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_notification_ready ON trailer_notification_jobs(status, available_at);

CREATE TABLE IF NOT EXISTS trailer_reminder_history (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES trailer_invoices(id) ON DELETE RESTRICT,
  notification_job_id BIGINT NULL REFERENCES trailer_notification_jobs(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  note TEXT NULL,
  action_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  action_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NULL
);
CREATE INDEX IF NOT EXISTS idx_trailer_reminder_history_invoice ON trailer_reminder_history(invoice_id, action_at DESC);

CREATE TABLE IF NOT EXISTS trailer_audit_log (
  id BIGSERIAL PRIMARY KEY,
  admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  role_keys TEXT[] NOT NULL DEFAULT '{}',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  old_values JSONB NULL,
  new_values JSONB NULL,
  reason TEXT NULL,
  ip_address TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_audit_entity ON trailer_audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trailer_audit_admin ON trailer_audit_log(admin_id, created_at DESC);

-- Resolve deferred media references now that invoice/payment tables exist.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailer_media_invoice_fk') THEN
    ALTER TABLE trailer_media ADD CONSTRAINT trailer_media_invoice_fk FOREIGN KEY (invoice_id) REFERENCES trailer_invoices(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailer_media_payment_fk') THEN
    ALTER TABLE trailer_media ADD CONSTRAINT trailer_media_payment_fk FOREIGN KEY (payment_id) REFERENCES trailer_payments(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailer_rentals_agreement_media_fk') THEN
    ALTER TABLE trailer_rentals ADD CONSTRAINT trailer_rentals_agreement_media_fk FOREIGN KEY (agreement_media_id) REFERENCES trailer_media(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Rental-generated events link back through the movement table; old events stay
-- untouched and continue to satisfy their original event-source contracts.
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS rental_movement_id BIGINT NULL REFERENCES trailer_rental_movements(id) ON DELETE SET NULL;

-- Extend the existing single-row Trailer settings record.
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS payment_confirmation_group_id TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS overdue_reminder_group_id TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS responsible_telegram_username TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS responsible_telegram_user_id TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS escalation_telegram_username TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS escalation_telegram_user_id TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminder_timezone TEXT NOT NULL DEFAULT 'America/Chicago';
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS payment_grace_period_days INTEGER NOT NULL DEFAULT 3;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminder_hour INTEGER NOT NULL DEFAULT 9;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminder_repeat_days INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminder_escalation_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminder_weekend_behavior TEXT NOT NULL DEFAULT 'skip';
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminders_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS payment_group_tested_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS overdue_group_tested_at TIMESTAMPTZ NULL;
