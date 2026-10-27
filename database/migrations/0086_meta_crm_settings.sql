-- Migration 0086: meta crm settings
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: the Bitrix-stages → Meta Conversions API for CRM pass (migration 0085,
-- services/metaCrm/stageSync.js) was configured only by META_CRM_DATASET_ID and
-- META_CRM_CAPI_TOKEN on the host. The owner (27 October 2026) enters, tests and
-- saves them himself in Settings → Facebook ↔ Bitrix instead. Same shape as
-- bitrix_settings (0009): one row, DB over env, the secret encrypted.
--
-- EVERY VALUE COLUMN IS NULLABLE ON PURPOSE. NULL means "not set in the app —
-- inherit the environment variable", so the env-only setup keeps working
-- exactly as before until somebody saves. `enabled` NULL means ON: before this
-- table the pass ran whenever both env values were set, and that must not
-- change by itself.
--
-- THE TOKEN IS A SECRET. Encrypted at rest (lib/security/facebookCrypto,
-- AES-256-GCM); `token_last4` is what the panel shows instead of it. It is
-- never returned by any GET and never logged.

CREATE TABLE IF NOT EXISTS meta_crm_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NULL,
  dataset_id TEXT NULL CHECK (dataset_id IS NULL OR dataset_id ~ '^[0-9]{1,30}$'),
  token_encrypted TEXT NULL,
  token_last4 TEXT NULL CHECK (token_last4 IS NULL OR length(token_last4) <= 4),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NULL
);

-- The single row the admin panel edits. Idempotent: a re-run leaves an
-- existing row untouched.
INSERT INTO meta_crm_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE meta_crm_settings IS
  'Single-row (id=1) settings for Bitrix hiring stages → Meta Conversions API for CRM, edited in Settings → Facebook ↔ Bitrix. NULL = inherit META_CRM_DATASET_ID / META_CRM_CAPI_TOKEN; enabled NULL = on. The DB row wins over env once set.';
COMMENT ON COLUMN meta_crm_settings.token_encrypted IS
  'The Conversions API access token, AES-256-GCM (lib/security/facebookCrypto). A secret: never log it, never return it to a browser — token_last4 is the only part shown.';
COMMENT ON COLUMN meta_crm_settings.updated_by IS
  'The admin username that last saved or switched it.';
