-- =============================================================================
-- GENERATED FILE — DO NOT EDIT BY HAND.
--
-- Assembled from database/baseline/*.sql by scripts/build-schema.js.
-- Edit the per-domain segment files there, then run: npm run build:schema
--
-- This is the BASELINE: the accumulated, additive, idempotent schema applied
-- verbatim on every boot. NEW schema/seed/backfill changes are versioned,
-- run-once forward migrations in database/migrations/ — see that folder's
-- README and docs/database/migration-notes.md.
-- =============================================================================

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
  -- Three fleets, three tokens. `lease` was added by migration 0047; it is here
  -- too so a FRESH database gets the wide form rather than being narrowed at
  -- create time and widened again a moment later. See lib/drivers/fleetType.js
  -- for the one place this vocabulary meets the Dispatcher Board's.
  CONSTRAINT driver_profiles_driver_type_check CHECK (
    driver_type IS NULL OR driver_type IN ('owner', 'company_driver', 'lease')
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
      CHECK (driver_type IS NULL OR driver_type IN ('owner', 'company_driver', 'lease'));
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

-- ─── Employee Voting Polls — RETIRED, and no longer created here ─────
-- The employee voting feature (employee_votes_polls, employee_votes_options,
-- employee_votes) was retired long before the trailer/QBQ removal, and its
-- three tables sat in this baseline so a fresh init-db matched production.
--
-- They are no longer created, because Settings → Retired Leftovers can now DROP
-- them: a baseline that recreates a droppable table makes that operation
-- non-durable — the data is destroyed, then the empty tables reappear on the
-- next boot and the inventory reports them as leftovers all over again.
-- Removing the CREATE is not itself destructive: an existing deployment keeps
-- its tables and rows until an operator deliberately drops them.
--
-- tests/retiredLeftovers.test.js asserts no droppable table is recreated here.

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

-- group_pinned_messages (the latest pinned-message snapshot per driver group)
-- is no longer created: its only reader, the pinned-load reading behind the
-- ETA updates, /load and /status, was removed in October 2026
-- (docs/architecture/retired-dispatch-eta.md). A deployed database keeps the
-- table until an administrator drops it from Settings → Retired feature
-- leftovers. See 008_dispatch_eta_and_loads.sql.

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


ALTER TABLE facebook_lead_sms_mirrors
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'outbound_auto';

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

-- ─── Retired: dispatcher ETA updates and the stored recent loads ──────────────
-- This segment used to create dispatch_eta_updates, dispatch_eta_global_settings
-- and group_recent_loads (and 005 created group_pinned_messages).
-- The dispatcher ETA updates, /update, /status, /load and the pinned-load
-- reading were removed (October 2026, see docs/architecture/retired-dispatch-eta.md).
-- The baseline no longer creates them: it is applied on EVERY boot, so a table
-- it created could never be dropped for good. A deployed database keeps its
-- tables and rows until an administrator drops them from Settings → Retired
-- feature leftovers, after a backup. No forward migration alters them, so no
-- fresh-database stub is needed.
--
-- The rest of this segment — indexes on surviving tables and the AI insights
-- pipeline — is live and stays.

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

-- groups: samsara lookups by samsara_vehicle_id and active driver filters.
CREATE INDEX IF NOT EXISTS idx_groups_samsara_vehicle_id
  ON groups(samsara_vehicle_id)
  WHERE samsara_vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_groups_type_active
  ON groups(group_type, active);
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

-- ─── Retired: dispatch teams ──────────────────────────────────────────────
-- This segment used to create dispatch_teams, dispatch_team_drivers and dispatch_team_members.
-- They belonged to the driver-raise review, which was removed (October 2026, see docs/architecture/retired-driver-raise.md). The baseline no longer creates them:
-- it is applied on EVERY boot, so a table it created could never be dropped for
-- good. A deployed database keeps its tables and rows until an administrator
-- drops them from Settings → Retired feature leftovers, after a backup.
--
-- The segment file stays, empty of tables, because segments are numbered
-- contiguously (tests/schemaBaselineBuild.test.js).
--
-- ONE STUB, ON A BRAND-NEW DATABASE ONLY. Migrations 0026, 0058 and 0062 still
-- alter and update `dispatch_team_drivers`, and migrations are immutable once
-- applied. On a new database they run right after this baseline, so the table
-- has to exist for them — with just the columns they touch. Once the ledger
-- exists (every deployed database) this never runs again, so a drop stays done.
DO $$
BEGIN
  -- FRESH DATABASE ONLY: the migration ledger does not exist until the first
  -- boot's migrations run, so this never fires on a deployed database.
  IF to_regclass('public.schema_migrations') IS NULL THEN
    CREATE TABLE IF NOT EXISTS dispatch_team_drivers (
      id SERIAL PRIMARY KEY,
      group_id INTEGER,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

-- ─── Retired: driver raise approval ──────────────────────────────────────────────
-- This segment used to create raise_settings, raise_rounds, raise_round_submissions, raise_round_picks
-- and raise_otp.
-- The driver-raise review was removed (October 2026, see docs/architecture/retired-driver-raise.md). The baseline no longer creates them:
-- it is applied on EVERY boot, so a table it created could never be dropped for
-- good. A deployed database keeps its tables and rows until an administrator
-- drops them from Settings → Retired feature leftovers, after a backup.
--
-- The segment file stays, empty of tables, because segments are numbered
-- contiguously (tests/schemaBaselineBuild.test.js).

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

-- Telegram chat id (stored as text to keep full precision on large negative
-- supergroup ids) that receives COMPLETED home-time request cards. When NULL the
-- completed card is not posted at all — it is NEVER sent to the driver's own
-- group. Date-clarification asks and the <allowance policy reminder still go to
-- the driver group (see services/homeTimeRequestService.js).
ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS completed_notify_group_id TEXT;

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

-- A one-time backfill stood here: "mark every existing completed leg as
-- already posted". Its comment said it ran once; it did not. The baseline is
-- re-applied verbatim on EVERY boot, so every restart stamped every
-- not-yet-posted leg as posted — silently, whenever Telegram had been down at
-- the transition or the bonus group was not yet configured. Since 2026-10-06 a
-- leg waits days for its home stay before its bonus is decided (migration
-- 0064), and a deploy in between would have lost every one of them. Removed:
-- the historical rows it was written for were stamped long ago.

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
--   pending               — dates complete, the managers have been told, no
--                           decision is awaited (the approval buttons are retired).
--   recorded              — the stay is complete and its dates are stored. This
--                           is the terminal state of the CURRENT flow; the
--                           approval states below are history, kept legal so
--                           the efficiency report can still read them.
--   approved / denied / cancelled — historical human decisions. No new request
--                           is ever written in these states.
--   clarification_unanswered — two reminders sent, no answer → manual follow-up.
--   expired               — flow abandoned (driver returned to road, etc.).
ALTER TABLE home_time_requests
  DROP CONSTRAINT IF EXISTS home_time_requests_status_check;
ALTER TABLE home_time_requests
  ADD CONSTRAINT home_time_requests_status_check
  CHECK (status IN ('pending', 'recorded', 'approved', 'denied', 'cancelled',
    'awaiting_dates', 'awaiting_home_start', 'awaiting_return_to_road',
    'clarification_unanswered', 'expired', 'closed'));

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

-- ─── Retired: Datatruck BOL/POD document delivery ─────────────────────────────
-- `datatruck_document_deliveries` was created here until BOL/POD forwarding was
-- removed (October 2026, docs/architecture/retired-bol-pod.md). A deployed
-- database keeps the table until it is dropped from Settings → Retired feature
-- leftovers; see 021_bol_pod_forwarding.sql for why the baseline stops here.

-- ── Retired: Smart BOL/POD intake + silent BOL/POD test monitor ──
-- The Telegram→Datatruck BOL/POD intake pipeline and the admin "BOL/POD
-- Monitor" test monitor were removed. Their tables are no longer created here.
-- Retired BOL/POD monitor tables retained for historical safety; no runtime
-- code uses them. Existing databases may still contain:
--   telegram_document_batches, telegram_document_files,
--   datatruck_upload_attempts, bol_pod_monitor_settings
-- They are harmless. `bol_pod_monitor_settings` is listed in Settings →
-- Retired feature leftovers; no automatic DROP is performed.

-- ─── Retired: fuel monitoring ──────────────────────────────────────────────
-- This segment used to create fuel_stop_alerts and fuel_monitor_inbox (truck_fuel_readings came from
-- migration 0038, which runs once).
-- Every fuel feature was removed (October 2026, see docs/architecture/retired-fuel.md). The baseline no longer creates them:
-- it is applied on EVERY boot, so a table it created could never be dropped for
-- good. A deployed database keeps its tables and rows until an administrator
-- drops them from Settings → Retired feature leftovers, after a backup.
--
-- The segment file stays, empty of tables, because segments are numbered
-- contiguously (tests/schemaBaselineBuild.test.js).
--
-- ONE STUB, ON A BRAND-NEW DATABASE ONLY: migration 0026 adds and fills
-- `fuel_stop_alerts.person_id` by `group_id`. See 010_dispatch_teams.sql.
DO $$
BEGIN
  -- FRESH DATABASE ONLY: the migration ledger does not exist until the first
  -- boot's migrations run, so this never fires on a deployed database.
  IF to_regclass('public.schema_migrations') IS NULL THEN
    CREATE TABLE IF NOT EXISTS fuel_stop_alerts (
      id SERIAL PRIMARY KEY,
      group_id INTEGER
    );
  END IF;
END $$;

-- ─── Driver Location Monitoring — RETIRED, and no longer created here ────
-- The pickup/delivery "Checked In / Checked Out" location-monitor feature was
-- retired 2026-07 (poller, callback handlers, admin API/UI and DB module all
-- removed; see docs/architecture/retired-checkin-checkout-feature.md). Its two
-- tables — driver_location_monitors and driver_location_checkins, with their
-- indexes and constraints — used to be created here so a fresh init-db matched
-- production, and the note said they should be "dropped manually AFTER a backup
-- if the data is no longer needed".
--
-- That manual drop now has a home: Settings → Retired Leftovers. Which is
-- exactly why the CREATEs are gone. A baseline that recreates a droppable table
-- makes the drop non-durable: schema.sql runs verbatim on EVERY boot, so the
-- operator's confirmed deletion destroys the rows and then the empty tables
-- reappear at the next restart and are reported as leftovers again.
--
-- Removing a CREATE TABLE IF NOT EXISTS is not destructive. An existing
-- deployment keeps both tables and every row until an operator deliberately
-- drops them; a fresh install simply never creates them, which is correct
-- because no application code has referenced them since 2026-07.
--
-- This file stays (rather than being deleted) so the baseline segments remain
-- contiguously numbered — tests/schemaBaselineBuild.test.js asserts that — and
-- so the decision is recorded where the next person looks for it.
--
-- tests/retiredLeftovers.test.js asserts no droppable table is recreated here.

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
-- TABLE: auto_reaction_rules — the bot automatically reacts to every message
-- posted by a chosen user with a chosen emoji. A rule identifies its target by
-- a stable telegram_user_id (when the admin picked from the seen-users list)
-- and/or a telegram_username (when typed by hand); at least one is required. A
-- user-id match wins over a username match at send time. emoji must be one of
-- the Bot-API-supported reactions (validated in the API layer).
CREATE TABLE IF NOT EXISTS auto_reaction_rules (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT NULL,
  telegram_username TEXT NULL,
  emoji TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  note TEXT NULL,
  created_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auto_reaction_rules_identity_check
    CHECK (telegram_user_id IS NOT NULL OR telegram_username IS NOT NULL)
);

-- One rule per target identity: re-adding the same user updates their emoji
-- rather than stacking duplicate reactions. Partial uniques so a username-only
-- rule and an id-only rule never conflict on a shared NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_auto_reaction_user_id
  ON auto_reaction_rules(telegram_user_id) WHERE telegram_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_auto_reaction_username
  ON auto_reaction_rules(LOWER(telegram_username)) WHERE telegram_username IS NOT NULL;

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
-- the same ID in several fields to deliberately share a group — no category is
-- ever an automatic fallback for another. When a *_group_id is NULL the
-- app falls back to the matching optional environment variable, and when neither
-- is set the message is NOT sent and a clear configuration error is logged.
CREATE TABLE IF NOT EXISTS message_group_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Extra Mile / Mileage Bonus milestone cards (services/mileageBonusService).
  mileage_bonus_group_id TEXT NULL,
  -- Extra Week / Road Bonus summary posted when a driver comes home over the
  -- road allowance (services/roadBonusNotifierService).
  road_bonus_group_id TEXT NULL,
  -- RETIRED (October 2026) with the driver-raise review, and read by nothing:
  -- it held the group asked to fill in the weekly 72–75 CPM review. Kept until
  -- the retired-feature cleanup drops it (docs/architecture/retired-driver-raise.md).
  dispatch_review_group_id TEXT NULL,
  -- The submitted RESULT of that review (who qualifies for the higher rate, who
  -- stays at the lower one) goes to accounting, NOT back to dispatch. Column
  -- raise_results_group_id is added by database/migrations/0006 — an
  -- independent setting that is never a fallback for dispatch_review_group_id.
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

-- ─── Retired: Google Maps settings and Route Control ──────────────────────────────────────────────
-- This segment used to create gmaps_settings, route_assignments, route_assignment_attachments and
-- route_monitor_events.
-- Route Control and its Settings → GMaps tab were removed (October 2026, see docs/architecture/retired-route-control.md). The baseline no longer creates them:
-- it is applied on EVERY boot, so a table it created could never be dropped for
-- good. A deployed database keeps its tables and rows until an administrator
-- drops them from Settings → Retired feature leftovers, after a backup.
--
-- `duplicate_unit_reports`, at the end of this segment, belongs to the
-- duplicate-unit scan, which is still running; it stays exactly as it was.
--
-- ONE STUB, ON A BRAND-NEW DATABASE ONLY: migration 0026 adds and fills
-- `route_assignments.person_id` by `group_id`. See 010_dispatch_teams.sql.
DO $$
BEGIN
  -- FRESH DATABASE ONLY: the migration ledger does not exist until the first
  -- boot's migrations run, so this never fires on a deployed database.
  IF to_regclass('public.schema_migrations') IS NULL THEN
    CREATE TABLE IF NOT EXISTS route_assignments (
      id SERIAL PRIMARY KEY,
      group_id INTEGER
    );
  END IF;
END $$;

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

-- ─── Retired: BOL/POD forwarding settings ──────────────────────────────────────────────
-- This segment used to create bol_pod_forwarding_settings.
-- BOL/POD document forwarding was removed (October 2026, see docs/architecture/retired-bol-pod.md). The baseline no longer creates them:
-- it is applied on EVERY boot, so a table it created could never be dropped for
-- good. A deployed database keeps its tables and rows until an administrator
-- drops them from Settings → Retired feature leftovers, after a backup.
--
-- The segment file stays, empty of tables, because segments are numbered
-- contiguously (tests/schemaBaselineBuild.test.js).

-- ══════════════════════════════════════════════════════════════════════════
-- ADMIN ACCOUNTS AND ROLE-BASED ACCESS CONTROL
-- ══════════════════════════════════════════════════════════════════════════
-- Additive/idempotent. The admin account lifecycle plus the database-backed
-- permission model every authenticated request reloads from
-- (server/middleware/auth.js → database/rbac.js).
--
-- HISTORY: this substrate shipped inside the Trailer Department's baseline
-- segment, which is why the audit table it writes to was once called
-- trailer_audit_log. The department is gone; the RBAC model, its super_admin
-- role, its three company-wide permission keys and its audit trail are not.
-- The trailer roles, their permission keys and their grants are no
-- longer seeded here; the rows an existing database already has are removed by
-- Settings → Retired feature leftovers.

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
  ('super_admin', 'Super Administrator', 'All application permissions')
ON CONFLICT (system_key) DO NOTHING;

INSERT INTO permissions (permission_key, description) VALUES
  ('admin.full_access', 'Access legacy and company-wide administration'),
  ('users.manage', 'Manage administrator accounts'),
  ('roles.manage', 'Manage roles and permissions')
ON CONFLICT (permission_key) DO NOTHING;

-- Super administrators receive every permission. Existing admins retain their
-- former full access. System role display names remain editable; system_key is
-- the stable authorization identifier.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'super_admin'
ON CONFLICT DO NOTHING;

-- BOOTSTRAP ONLY. A role-less account becomes super administrator only while
-- there is NO active super administrator at all: the admins that existed when
-- roles arrived, or a database with none. Until October 2026 this ran on every
-- boot for ANY role-less account, so stripping an account's roles to lock it
-- out made it super administrator at the next deploy. `seed-admin` now gives
-- the first admin its role itself, and the API refuses a role-less account
-- (server/routes/adminUserGuards.js); this is the backstop.
INSERT INTO admin_user_roles (admin_id, role_id)
SELECT a.id, r.id FROM admins a JOIN roles r ON r.system_key = 'super_admin'
WHERE NOT EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.admin_id = a.id)
  AND NOT EXISTS (
    SELECT 1 FROM admin_user_roles sur
      JOIN roles sr ON sr.id = sur.role_id AND sr.system_key = 'super_admin'
      JOIN admins sa ON sa.id = sur.admin_id AND sa.active
  )
ON CONFLICT DO NOTHING;

-- Optimistic locking for roles: a custom-role edit that sends a stale version
-- gets a 409 instead of silently clobbering a concurrent change. Additive.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Administrative audit log: who created or changed an admin account, a role, or
-- a role's permissions, with redacted before/after images (database/rbac.js →
-- database/adminAudit.js). These rows used to live in trailer_audit_log because
-- the RBAC schema shipped inside the Trailer Department's baseline segment;
-- migration 0010 copies them across so the trail is continuous.
CREATE TABLE IF NOT EXISTS admin_audit_log (
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
CREATE INDEX IF NOT EXISTS idx_admin_audit_entity ON admin_audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON admin_audit_log(admin_id, created_at DESC);
