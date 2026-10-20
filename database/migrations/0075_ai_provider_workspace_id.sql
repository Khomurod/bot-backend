-- Migration 0075: an Anthropic workspace id for a key that is not scoped to one
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. An Anthropic API key created at the ORGANIZATION level is
-- refused with "400 This API key is not scoped to a workspace, so this request
-- must include the anthropic-workspace-id header" (seen connecting Claude,
-- October 2026). The adapter sends that header when this column is set.
-- NULL — every existing row — sends nothing, exactly as before. It is an id,
-- not a secret; the key stays encrypted where it was.

ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS workspace_id TEXT;
