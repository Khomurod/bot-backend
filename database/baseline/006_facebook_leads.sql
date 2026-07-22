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
