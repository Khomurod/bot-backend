-- Migration 0009: bitrix settings
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: Bitrix24 was configured only by environment variables on the host, so
-- fixing a wrong assignee id or rotating the inbound webhook meant a Render
-- deploy by whoever holds that dashboard — while RingCentral, ELD, GMaps and
-- the other integrations are entered in Settings and stored encrypted. This
-- gives Bitrix the same home: one row, DB over env, the webhook encrypted with
-- the same AES-256-GCM scheme as every other stored credential.
--
-- EVERY COLUMN IS NULLABLE ON PURPOSE. NULL means "not set in the app — inherit
-- the environment variable", so a half-filled form still works and an env-only
-- deployment behaves exactly as before until someone saves. `assigned_by_id`
-- is TEXT rather than INTEGER so that '' can mean "explicitly none", distinct
-- from NULL: the env value it must be able to override is a NAME that Bitrix
-- ignores, and "clear it" has to beat "inherit it".

CREATE TABLE IF NOT EXISTS bitrix_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NULL,
  -- The inbound webhook URL. Its PATH is the credential, so it is encrypted at
  -- rest and never returned to a browser — only its host is.
  webhook_url_encrypted TEXT NULL,
  entity TEXT NULL CHECK (entity IS NULL OR entity IN ('lead', 'deal')),
  -- TEXT, see above: NULL inherits env, '' is explicitly nobody, a numeric
  -- string is a Bitrix user id.
  assigned_by_id TEXT NULL,
  source_id TEXT NULL,
  source_description TEXT NULL,
  deal_category_id TEXT NULL,
  deal_stage_id TEXT NULL,
  assignee_wait_ms INTEGER NULL CHECK (assignee_wait_ms IS NULL OR assignee_wait_ms >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The single row the admin panel edits. Idempotent: a re-run leaves an
-- existing row untouched.
INSERT INTO bitrix_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE bitrix_settings IS
  'Single-row (id=1) Bitrix24 CRM settings edited in Settings → RingCentral → Bitrix24. Every column NULL = inherit the BITRIX24_* environment variable. The DB row wins over env once set.';
COMMENT ON COLUMN bitrix_settings.webhook_url_encrypted IS
  'Inbound webhook URL, AES-256-GCM (lib/security/facebookCrypto). The URL path IS the credential: never log it, never return it to a browser — only its host.';
COMMENT ON COLUMN bitrix_settings.assigned_by_id IS
  'Bitrix user id to assign new records to at creation. TEXT so that '''' means explicitly none (a distribution rule assigns) while NULL means inherit env. Must be numeric to have any effect — Bitrix ignores a name.';
