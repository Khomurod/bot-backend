-- Migration 0074: a quota spent on ONE model pauses that model, not its provider
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. Groq and Gemini count their free allowances per MODEL:
-- "Rate limit reached for model `openai/gpt-oss-20b` … tokens per day". Until
-- now a spent allowance cooled the whole provider until the next UTC day, so
-- the four other models in its chain — each with its own untouched allowance —
-- were never asked. The owner (October 2026): "when one model's quota runs
-- out, switch automatically", and see in Settings → AI which models can be
-- used right now and which cannot.
--
-- `model_cooldowns` maps a model id to {"until": ISO time, "reason": text}.
-- The router skips a model until its time has passed; an entry in the past is
-- simply ignored. An empty object is "every model available", which is what
-- every existing row gets, so this changes nothing until a model is paused.

ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS model_cooldowns JSONB NOT NULL DEFAULT '{}'::jsonb;
