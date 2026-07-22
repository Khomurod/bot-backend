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
