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
