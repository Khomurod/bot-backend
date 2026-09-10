-- Migration 0027: switch on the three repairs the owner asked for, and give
-- legacy AI provider rows their catalogue identity
-- migrate:kind: seed
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY A MIGRATION. Every check ships disabled, and a person switches it on in
-- Needs Attention → Automation. The owner asked for three of them to run now,
-- and this session had no path to production other than the application
-- itself (the database API was suspended for egress quota; there is no
-- DATABASE_URL here). A seed row IS the person's switch, written once, with the
-- reason on the row — and it is still theirs: switching a check off in the
-- admin sticks, because ON CONFLICT DO NOTHING never overrides a row that
-- already exists.
--
-- THE CAPS ARE THE SAFETY LIMIT, NOT A WAY AROUND IT. A batch that wants more
-- than its cap applies NOTHING and files a serious finding about itself. The
-- Home Time repair was measured at 65 closable cycles (38 class A + 27 class B)
-- against production; its cap is exactly 65, so a fleet that no longer matches
-- that measurement stops the batch rather than widening it. The identity caps
-- cover the ~100 unplaced driver groups with room for the ones that appear
-- before the sweep reaches them, and stay far inside the schema's 500.
INSERT INTO operational_check_settings (check_key, auto_apply_enabled, max_auto_per_run, updated_by, updated_at)
VALUES
  ('identity.group_without_person',  TRUE, 150, 'migration 0027 (owner instruction, 2026-09-10)', NOW()),
  ('identity.stale_unit_assignment', TRUE, 150, 'migration 0027 (owner instruction, 2026-09-10)', NOW()),
  ('home_time.closable_open_cycle',  TRUE,  65, 'migration 0027 (owner instruction, 2026-09-10)', NOW())
ON CONFLICT (check_key) DO NOTHING;

-- ─── Legacy providers meet the catalogue ─────────────────────────────────────
-- Providers configured before Phase 3-B (Groq and Gemini, from environment
-- keys) have no `catalog_key` and, for Gemini, no `base_url`: the call adapter
-- carried its own default, so nothing needed one — until model discovery asked
-- "which URL lists your models?" and had nothing to ask. The code now falls
-- back to the catalogue for such rows; this fills the columns so the admin
-- shows them as the catalogued providers they are. Only rows whose key IS a
-- catalogue key are touched, and only where the column is empty.
UPDATE ai_providers
   SET catalog_key = provider_key
 WHERE catalog_key IS NULL
   AND provider_key IN ('groq', 'gemini', 'openrouter', 'cerebras', 'mistral', 'together', 'deepseek', 'nvidia');

UPDATE ai_providers
   SET base_url = CASE provider_key
     WHEN 'groq'       THEN 'https://api.groq.com/openai/v1'
     WHEN 'gemini'     THEN 'https://generativelanguage.googleapis.com/v1beta'
     WHEN 'openrouter' THEN 'https://openrouter.ai/api/v1'
     WHEN 'cerebras'   THEN 'https://api.cerebras.ai/v1'
     WHEN 'mistral'    THEN 'https://api.mistral.ai/v1'
     WHEN 'together'   THEN 'https://api.together.xyz/v1'
     WHEN 'deepseek'   THEN 'https://api.deepseek.com/v1'
     WHEN 'nvidia'     THEN 'https://integrate.api.nvidia.com/v1'
   END
 WHERE base_url IS NULL
   AND provider_key IN ('groq', 'gemini', 'openrouter', 'cerebras', 'mistral', 'together', 'deepseek', 'nvidia');
