-- Migration 0023: what Wenze discovered about a provider, and where a policy URL came from
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY. "Add a provider" asked an administrator for a Base URL, a protocol and a
-- comma-separated list of model identifiers — public facts about the provider
-- that a program can look up. Connect now does: it reads the provider's own
-- `/models` listing, chooses a chain, proves the key with one call, and saves.
-- Three things need a home for that to be honest rather than magical:
--
--   catalog_key         which catalogue entry configured this row, so a refresh
--                       knows where the models endpoint is and the terms watcher
--                       knows which official pages to seed. NULL = configured by
--                       hand, the way every existing row was.
--   discovered_models   the normalised listing Wenze last saw (id, context,
--                       free status, capability) — what the admin shows beside
--                       the chain, and what a refresh diffs against.
--   ai_model_events     the audit trail for the maintenance job: a model that
--                       disappeared, one that replaced it, one the smoke test
--                       refused. Append-only. A provider that silently swapped
--                       its chain overnight would be the "nothing told a human"
--                       failure this whole project is about.
--
-- `ai_policy_sources.source_origin` records whether a terms URL was typed by a
-- person, seeded from the catalogue, or found again after the original moved.
-- The watcher treats them differently: a catalogue URL that 404s is rediscovered
-- automatically; a hand-typed one is reported, because a person chose it.
--
-- Nothing here changes routing. Rows configured before this migration keep
-- their chains exactly; the two seeded providers are simply labelled with the
-- catalogue entry they already correspond to.

ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS catalog_key TEXT NULL;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS discovered_models JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS models_refreshed_at TIMESTAMPTZ NULL;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS models_refresh_error TEXT NULL;

UPDATE ai_providers SET catalog_key = provider_key
 WHERE provider_key IN ('groq', 'gemini') AND catalog_key IS NULL;

CREATE TABLE IF NOT EXISTS ai_model_events (
  id BIGSERIAL PRIMARY KEY,
  provider_key TEXT NOT NULL REFERENCES ai_providers(provider_key) ON DELETE CASCADE,
  model TEXT NULL,
  -- added:    a model Wenze started using
  -- retired:  the provider stopped listing it, or refused it as unknown, and it
  --           left the active chain
  -- replaced: a retired model's slot was filled by another (detail says which)
  -- restored: a model that had been retired is listed again and was put back
  -- refused:  the smoke test at connect time rejected it, so it was not chosen
  -- selected: the chain Wenze chose at connect or refresh
  event TEXT NOT NULL
    CHECK (event IN ('added', 'retired', 'replaced', 'restored', 'refused', 'selected')),
  -- Who did it: 'connect' (an administrator connecting), 'refresh' (the
  -- maintenance job), 'manual' (an administrator editing the chain by hand).
  initiator TEXT NOT NULL DEFAULT 'refresh'
    CHECK (initiator IN ('connect', 'refresh', 'manual', 'router')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_model_events_provider_time
  ON ai_model_events (provider_key, created_at DESC);

ALTER TABLE ai_policy_sources ADD COLUMN IF NOT EXISTS source_origin TEXT NOT NULL DEFAULT 'manual';

-- The CHECK is added by name so a re-run is a no-op rather than a duplicate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ai_policy_sources'::regclass
       AND conname = 'ai_policy_sources_origin_check'
  ) THEN
    ALTER TABLE ai_policy_sources
      ADD CONSTRAINT ai_policy_sources_origin_check
        CHECK (source_origin IN ('manual', 'catalog', 'rediscovered'));
  END IF;
END $$;
