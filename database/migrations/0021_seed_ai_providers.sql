-- Migration 0021: put Groq and Gemini on the roster the router actually reads
-- migrate:kind: data
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THIS EXISTS, AND WHY IT IS THE RISKIEST THREE LINES IN STAGE 5.
--
-- Migration 0019 created `ai_providers` and deliberately seeded NOTHING, so the
-- deploy was a no-op: every value NULL, and NULL means inherit the environment.
-- That was right while the router had no consumers. It stops being right the
-- moment `callGroqWithFallback` and `callGeminiText`/`callGeminiJson` become
-- wrappers over it, because `getProvidersForRouter` selects
-- `WHERE enabled = TRUE` — and an empty table means `roster.available` is false,
-- which means EVERY AI call in the application throws `AiUnavailableError`.
--
-- The consumers would all degrade correctly to their deterministic paths, which
-- is exactly the design. It would also be a total, silent AI outage on deploy.
-- "It fails safe" is not the same as "it works".
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHAT IS SEEDED IS TODAY'S BEHAVIOUR, WRITTEN DOWN.
--
--   api_key_encrypted NULL  → `envKeyFor()` supplies GROQ_API_KEY / GEMINI_API_KEY,
--                             so the running deployment keeps working with no
--                             secret moved, no Render change, nothing rotated;
--   model_chain             → the DEFAULT_* chains those two clients already
--                             use when their env overrides are unset;
--   priority 10 / 20        → Groq first, Gemini second, which is the order all
--                             nine hand-coded "try Groq, then Gemini" branches
--                             already implement;
--   is_free TRUE            → both are used on their free tiers, and this is
--                             what `free_only_mode` filters on.
--
-- ON CONFLICT DO NOTHING, so an operator who has already configured either
-- provider from Admin → Settings → AI keeps their settings. A migration that
-- overwrote a stored key with NULL would look like a successful deploy and
-- silently move the fleet back onto an environment variable.
--
-- `enabled = TRUE` is the one value here that is a decision rather than a
-- transcription. It is TRUE because these two providers ARE enabled today, in
-- the only sense that has ever existed: their keys are set and the code calls
-- them. Seeding them disabled would be the same outage this migration exists to
-- prevent, arrived at by a different route.
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO ai_providers (provider_key, label, adapter, enabled, priority, is_free, base_url, model_chain)
VALUES (
  'groq', 'Groq', 'openai_chat', TRUE, 10, TRUE,
  'https://api.groq.com/openai/v1',
  '["llama-3.3-70b-versatile","llama-3.1-8b-instant","meta-llama/llama-4-scout-17b-16e-instruct","openai/gpt-oss-20b"]'::jsonb
)
ON CONFLICT (provider_key) DO NOTHING;

INSERT INTO ai_providers (provider_key, label, adapter, enabled, priority, is_free, base_url, model_chain)
VALUES (
  'gemini', 'Google Gemini', 'gemini', TRUE, 20, TRUE,
  NULL,
  '["gemini-3.1-flash-lite","gemini-3-flash","gemini-2.5-flash-lite","gemini-2.5-flash","gemini-3.1-flash","gemini-2.0-flash"]'::jsonb
)
ON CONFLICT (provider_key) DO NOTHING;
