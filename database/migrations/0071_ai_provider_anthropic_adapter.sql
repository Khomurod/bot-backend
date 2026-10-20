-- Migration 0071: allow the 'anthropic' adapter on ai_providers — Claude as a provider
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. The owner (October 2026) asked for Claude as an AI
-- provider that can be put anywhere in the Settings → AI order. Its Messages
-- API is a third wire format (services/ai/adapters/anthropic.js), and 0019's
-- CHECK only knows 'openai_chat' and 'gemini', so saving a Claude provider
-- would be refused by the database.
--
-- WIDENED, NOT CHANGED. The constraint is dropped and re-added with one more
-- allowed value under the SAME name (Postgres's default name for 0019's inline
-- CHECK, verified in production). Every existing row satisfies the new one, no
-- data is touched, and re-running it is a no-op — the precedent is 0029's
-- home_time_requests_status_check.

ALTER TABLE ai_providers
  DROP CONSTRAINT IF EXISTS ai_providers_adapter_check;
ALTER TABLE ai_providers
  ADD CONSTRAINT ai_providers_adapter_check
  CHECK (adapter IN ('openai_chat', 'gemini', 'anthropic'));
