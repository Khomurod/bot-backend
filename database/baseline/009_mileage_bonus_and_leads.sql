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
