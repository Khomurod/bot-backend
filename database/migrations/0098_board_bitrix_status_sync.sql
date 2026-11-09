-- Migration 0098: guarded Dispatcher Board -> Bitrix status sync
-- migrate:kind: schema
--
-- Live writes remain OFF after deploy. `dry_run` records the exact transitions
-- without touching Bitrix; `live` is an explicit administrator choice.

ALTER TABLE board_bitrix_settings
  ADD COLUMN IF NOT EXISTS sync_mode TEXT NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS max_updates_per_pass SMALLINT NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS schema_mapping JSONB NULL,
  ADD COLUMN IF NOT EXISTS schema_fingerprint TEXT NULL,
  ADD COLUMN IF NOT EXISTS schema_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS schema_confidence SMALLINT NULL,
  ADD COLUMN IF NOT EXISTS schema_checked_at TIMESTAMPTZ NULL;

DO $$ BEGIN
  ALTER TABLE board_bitrix_settings
    ADD CONSTRAINT board_bitrix_sync_mode_check
    CHECK (sync_mode IN ('off', 'dry_run', 'live'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE board_bitrix_settings
    ADD CONSTRAINT board_bitrix_max_updates_check
    CHECK (max_updates_per_pass BETWEEN 1 AND 25);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE board_bitrix_settings
    ADD CONSTRAINT board_bitrix_schema_confidence_check
    CHECK (schema_confidence IS NULL OR schema_confidence BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS board_bitrix_stage_sync_actions (
  id BIGSERIAL PRIMARY KEY,
  action_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'live')),
  deal_id BIGINT NOT NULL,
  board_status TEXT NOT NULL,
  before_stage_id TEXT NULL,
  target_stage_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'planned', 'applied', 'already_done', 'failed')),
  schema_fingerprint TEXT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  claimed_until TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_board_bitrix_stage_sync_recent
  ON board_bitrix_stage_sync_actions (updated_at DESC);

COMMENT ON TABLE board_bitrix_stage_sync_actions IS
  'Idempotency lease and audit log for guarded Dispatcher Board -> Bitrix STAGE_ID updates.';
