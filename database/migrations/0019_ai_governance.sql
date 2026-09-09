-- Migration 0019: AI providers, capabilities and a call log — governed from the admin
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: AI is used in twenty-odd places across this application and is governed
-- nowhere. Keys are `process.env` read at MODULE LOAD, so no setting could take
-- effect without a restart. Provider, model, latency and failure reason exist
-- in memory at call time and are thrown into console.log. There is no way to
-- ask "is Groq answering?", "which model wrote this?", or "has our free tier
-- run out?" without reading server logs.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE RULE THAT SHAPES ALL OF IT: AI IS AN ACCELERATOR, NEVER A DEPENDENCY.
--
-- Twelve of the existing consumers already degrade correctly to deterministic
-- logic — `driverProfileAiParser` to `parseDriverFromGroupName`,
-- `homeTimeIntentService` to `classifyDeterministically`, and so on. Nothing
-- here may weaken that. With every row in `ai_providers` disabled, the
-- application must still pass its whole test suite; these tables exist to make
-- AI *manageable*, not to make it *load-bearing*.
--
-- Which is also why NOTHING IS SEEDED. No provider row, no capability row. A
-- fresh boot after this migration behaves exactly as it does today, reading the
-- same environment variables, because every DB value is NULL and NULL means
-- "inherit the environment" — the `samsaraSettings` rule, applied per value.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- The master switch. FALSE means every capability falls to its deterministic
  -- path — which is a supported, tested mode of operation, not an outage.
  enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- A guarantee, not a preference: with this on, a paid provider is never
  -- called, full stop. An operator turns it on to be certain, and "prefer free"
  -- would make them uncertain again.
  free_only_mode BOOLEAN NOT NULL DEFAULT TRUE,

  -- 'priority'    — strict order; what free-tier prioritisation wants.
  -- 'round_robin' — rotate the starting point across the SAME order, so no one
  --                 free allowance is always the first one burned.
  -- Weighted routing is deliberately absent: it earns its complexity only when
  -- providers differ in cost or capability enough to justify a ratio, and
  -- `priority` is the seam to add it later without reshaping the router.
  routing_mode TEXT NOT NULL DEFAULT 'priority'
    CHECK (routing_mode IN ('priority', 'round_robin')),

  -- Gemini's client has NO timeout today; a hung connection hangs the caller
  -- forever, including in interactive paths. This is the floor that fixes it.
  request_timeout_ms INTEGER NOT NULL DEFAULT 60000
    CHECK (request_timeout_ms BETWEEN 5000 AND 300000),
  max_retry_wait_ms INTEGER NOT NULL DEFAULT 35000
    CHECK (max_retry_wait_ms BETWEEN 0 AND 120000),

  -- How long a call log row is kept. The log carries no prompts and no
  -- completions, but it is still operational exhaust with no reason to be
  -- immortal.
  call_log_retention_days SMALLINT NOT NULL DEFAULT 30
    CHECK (call_log_retention_days BETWEEN 1 AND 365),

  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ai_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Providers.
--
-- Most are an OpenAI-compatible chat-completions endpoint, which is what
-- services/groqClient.js already speaks — so Cerebras, Mistral, OpenRouter and
-- Together are a base_url and a key in a row here, not new code. Gemini keeps
-- its own adapter because its wire format differs.
--
-- `api_key_encrypted` NULL means "inherit the environment", so today's
-- GROQ_API_KEY / GEMINI_API_KEY deployment keeps working with nothing migrated.
-- The key is AES-256-GCM via lib/security/facebookCrypto (the repository
-- standard for secrets this app reads alone) and is NEVER returned in full —
-- reads mask it to ••••abcd, and only /test exercises it.
--
-- `enabled` and `cooled_until` are separate on purpose. `enabled` is a human's
-- decision; `cooled_until` is the system's temporary opinion. Conflating them
-- would let a bad afternoon look like a configuration change — and would let
-- software silently undo an operator's choice.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_providers (
  provider_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,

  -- 'openai_chat' covers every OpenAI-compatible endpoint; 'gemini' is the one
  -- shape that genuinely differs.
  adapter TEXT NOT NULL DEFAULT 'openai_chat'
    CHECK (adapter IN ('openai_chat', 'gemini')),

  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  priority SMALLINT NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 999),
  is_free BOOLEAN NOT NULL DEFAULT TRUE,

  base_url TEXT NULL,
  -- Ordered chain, tried in sequence within this provider before moving on.
  model_chain JSONB NOT NULL DEFAULT '[]'::jsonb,

  api_key_encrypted TEXT NULL,
  -- Enough to recognise WHICH key is stored without storing anything usable.
  api_key_last4 TEXT NULL,

  -- The system's temporary opinion. 'indefinite' is a sentinel, not a date: a
  -- rejected credential is not fixed by the passage of time, so it waits for a
  -- person and clears the moment one saves a new key.
  cooled_until TIMESTAMPTZ NULL,
  cooled_indefinitely BOOLEAN NOT NULL DEFAULT FALSE,
  cooldown_reason TEXT NULL,
  consecutive_failures SMALLINT NOT NULL DEFAULT 0,

  last_ok_at TIMESTAMPTZ NULL,
  last_error_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,

  notes TEXT NULL,
  updated_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ai_providers_key_not_blank CHECK (btrim(provider_key) <> ''),
  -- A cooldown says why, or it is not a cooldown. An operator who cannot learn
  -- why AI is degraded reads it as "AI is broken".
  CONSTRAINT ai_providers_cooldown_has_reason
    CHECK ((cooled_until IS NULL AND cooled_indefinitely = FALSE)
           OR btrim(COALESCE(cooldown_reason, '')) <> '')
);

CREATE INDEX IF NOT EXISTS idx_ai_providers_rotation
  ON ai_providers (priority, provider_key) WHERE enabled = TRUE;

-- ─────────────────────────────────────────────────────────────────────────
-- Capabilities — one row per named thing AI is used FOR.
--
-- Separate from providers because "may Wenze use AI at all" and "may AI decide
-- a driver's status" are different questions, and an operator must be able to
-- answer them differently. `ai_enabled = FALSE` on one capability sends exactly
-- that consumer to its deterministic path and leaves the rest alone.
--
-- `sends_raw_text` is documentation with teeth. Most capabilities send
-- structured, de-identified fields; two (`chat_annotation`, `ai_analysis`) send
-- driver message text. Under a free tier that may train on submissions, that is
-- a trade-off an operator should SEE rather than discover, so the column exists
-- to be shown in the admin beside the switch.
--
-- may_propose / may_auto_apply default FALSE and are the enforcement point for
-- the rule that AI may rank and explain an operational finding but may never
-- author or apply a correction.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_capabilities (
  capability_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  provider_override TEXT NULL REFERENCES ai_providers(provider_key) ON DELETE SET NULL,
  sends_raw_text BOOLEAN NOT NULL DEFAULT FALSE,
  has_deterministic_fallback BOOLEAN NOT NULL DEFAULT TRUE,
  may_propose BOOLEAN NOT NULL DEFAULT FALSE,
  may_auto_apply BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The hard line, in the schema rather than only in code: no capability may
  -- ever be granted permission to apply a correction. AI ranks and explains;
  -- people and deterministic evidence decide.
  CONSTRAINT ai_capabilities_never_auto_apply CHECK (may_auto_apply = FALSE)
);

-- ─────────────────────────────────────────────────────────────────────────
-- The call log.
--
-- NO PROMPTS. NO COMPLETIONS. NO PII. Only what is needed to answer "is this
-- provider healthy", "which model actually answered", and "what did it cost" —
-- and the absence of content is what makes it safe to keep at all.
--
-- This also finally makes `chat_message_annotations.model_version` honest: it
-- has stored the constant string 'groq-v1-annotator' since it was created,
-- rather than the model that answered.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_call_log (
  id BIGSERIAL PRIMARY KEY,
  capability_key TEXT NULL,
  provider_key TEXT NULL,
  model TEXT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'failed', 'skipped')),
  -- A FAILURE.* from lib/ai/classify.js, so health can be read by CLASS: a
  -- provider out of quota and a provider with a dead key need different
  -- responses and must not average together into "unhealthy".
  failure_kind TEXT NULL,
  latency_ms INTEGER NULL,
  prompt_tokens INTEGER NULL,
  completion_tokens INTEGER NULL,
  attempts SMALLINT NOT NULL DEFAULT 1,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_call_log_recent ON ai_call_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_call_log_provider
  ON ai_call_log (provider_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_call_log_failures
  ON ai_call_log (created_at DESC) WHERE outcome = 'failed';
