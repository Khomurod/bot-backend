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
  media_file_id TEXT,
  media_type TEXT,
  media_position TEXT DEFAULT 'above',
  target_type TEXT DEFAULT 'all',
  target_driver_ids INTEGER[],
  target_languages TEXT[],
  force_language TEXT,
  scheduled_at TIMESTAMP NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

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
