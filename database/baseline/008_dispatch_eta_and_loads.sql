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
