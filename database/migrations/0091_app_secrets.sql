-- Migration 0091: app secrets
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.

--
-- WHAT THIS IS FOR. The deployment settings of both services (this app and
-- the separate samsara-integration service) move out of Coolify's environment
-- and into the app, where a super administrator uploads them as one .env file
-- (Settings → System → Secrets). Coolify keeps only DATABASE_URL and
-- INTEGRATION_SECRET_KEY: the two values needed to reach and open this table.
--
-- EVERY SAVE IS A NEW VERSION; NOTHING IS UPDATED IN PLACE. The latest version
-- is the one in use, the previous ones are what a rollback returns to
-- (APP_SECRETS_VERSION=<id> in Coolify loads an older one at boot).
--
-- A VALUE IS STORED ONLY ENCRYPTED, under INTEGRATION_SECRET_KEY and never
-- under the key derived from DATABASE_URL: whoever has the connection string
-- must not be able to open these. `key_fingerprint` says which key wrote a
-- version, so a reader with a different key skips it instead of failing.
-- `last4` is empty for short values, so a short secret is never mostly shown.
--
-- `scope` says who reads a value: 'both' (the same name means the same thing
-- in both services, e.g. BOT_TOKEN), 'bot' (this app) or 'samsara' (the
-- Samsara service). See docs/architecture/app-secrets.md.

CREATE TABLE IF NOT EXISTS app_secret_versions (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT,
  note TEXT,
  key_fingerprint TEXT NOT NULL,
  restored_from BIGINT
);

CREATE TABLE IF NOT EXISTS app_secret_values (
  version_id BIGINT NOT NULL REFERENCES app_secret_versions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('both', 'bot', 'samsara')),
  name TEXT NOT NULL CHECK (name ~ '^[A-Z_][A-Z0-9_]*$'),
  ciphertext TEXT NOT NULL,
  last4 TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (version_id, scope, name)
);
