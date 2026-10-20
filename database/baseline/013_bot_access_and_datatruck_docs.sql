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
