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
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (telegram_chat_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS idx_facebook_lead_sms_mirrors_lookup
  ON facebook_lead_sms_mirrors (telegram_chat_id, telegram_message_id);

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
