-- optional-index-improvements.sql
--
-- OPT-IN, operator-reviewed database improvements from docs/database/audit-report.md.
-- NOT applied automatically (not part of schema.sql / initializeDatabase). Review
-- each table's read/write volume and real index usage first, then run manually:
--
--   psql "$DATABASE_URL" -f database/optional-index-improvements.sql
--
-- All statements are idempotent and non-destructive EXCEPT the clearly-marked
-- DROP INDEX section at the bottom (reversible — just recreate the index).
-- Take a backup before running anything in a production database.

-- ── Finding #3: add indexes on foreign-key columns that lack one ─────────────
-- Speeds up parent-row deletes/updates and joins on the FK. Additive + safe.
CREATE INDEX IF NOT EXISTS idx_ai_insights_group_id            ON ai_insights(group_id);
CREATE INDEX IF NOT EXISTS idx_ai_reports_group_id             ON ai_reports(group_id);
CREATE INDEX IF NOT EXISTS idx_facebook_connect_sessions_group ON facebook_connect_sessions(group_id);
CREATE INDEX IF NOT EXISTS idx_facebook_page_connections_group ON facebook_page_connections(group_id);
CREATE INDEX IF NOT EXISTS idx_fuel_monitor_inbox_alert_id     ON fuel_monitor_inbox(alert_id);
CREATE INDEX IF NOT EXISTS idx_employee_votes_option_id        ON employee_votes(option_id);
CREATE INDEX IF NOT EXISTS idx_employee_votes_options_group    ON employee_votes_options(group_id);
CREATE INDEX IF NOT EXISTS idx_employee_votes_options_poll     ON employee_votes_options(poll_id);
CREATE INDEX IF NOT EXISTS idx_options_question_id             ON options(question_id);
CREATE INDEX IF NOT EXISTS idx_responses_option_id             ON responses(option_id);
CREATE INDEX IF NOT EXISTS idx_responses_question_id           ON responses(question_id);
CREATE INDEX IF NOT EXISTS idx_question_media_question_id      ON question_media(question_id);
CREATE INDEX IF NOT EXISTS idx_raise_round_submissions_team    ON raise_round_submissions(team_id);
CREATE INDEX IF NOT EXISTS idx_raise_round_picks_submission    ON raise_round_picks(submission_id);
CREATE INDEX IF NOT EXISTS idx_raise_round_picks_team          ON raise_round_picks(team_id);
CREATE INDEX IF NOT EXISTS idx_raise_otp_team_id               ON raise_otp(team_id);

-- ── Finding #2: drop redundant duplicate indexes ─────────────────────────────
-- REVERSIBLE but a real change — CONFIRM real index usage with
--   SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE relname = '<table>';
-- before dropping. Uncomment to apply.
-- DROP INDEX IF EXISTS idx_driver_profiles_group_id;          -- covered by driver_profiles_group_id_unique
-- DROP INDEX IF EXISTS idx_group_pinned_messages_group_id;    -- covered by group_pinned_messages_group_id_key
-- DROP INDEX IF EXISTS idx_dispatch_team_drivers_profile;     -- covered by uniq_dispatch_active_driver_profile
-- DROP INDEX IF EXISTS idx_facebook_lead_sms_mirrors_lookup;  -- covered by the unique (chat_id,message_id) index
