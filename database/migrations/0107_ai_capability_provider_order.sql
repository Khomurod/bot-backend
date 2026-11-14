-- Migration 0107: ai capability provider order
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHICH PROVIDERS MAY DO ONE TASK, AND IN WHAT ORDER (owner, 14 November
-- 2026). Until now every AI task was asked of the same providers in the same
-- order (Settings → AI → Order of providers). Reading a candidate's CDL photo
-- is the first task the owner wants to keep to providers of their choosing —
-- "only Claude", "only the free ones", "Gemini, then Claude".
--
--   ai_capabilities.provider_order   the provider keys this task may be asked
--       of, first asked first. NULL: the task follows the global order, as
--       every task did before. An array: only those providers, in that order
--       (services/ai/router.js). A task the catalogue marks as needing a
--       choice (lib/ai/capabilityCatalog.js `providerChoice: 'required'`)
--       reads NULL as "nobody" — nothing is asked until a person chooses.
--
-- No foreign key: an array cannot carry one, and a provider deleted later is
-- simply skipped by the router (it is no longer on the roster). The column is
-- new and nullable: every existing task keeps the global order.

ALTER TABLE ai_capabilities
  ADD COLUMN IF NOT EXISTS provider_order TEXT[];
