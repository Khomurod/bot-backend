-- Migration 0110: meta crm lead events
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: Meta's Conversions API for CRM expects one raw-lead event for EVERY
-- lead before any later stage ("100 leads → 100 raw lead events"), and the
-- qualified-leads optimisation the owner wants needs it (23 November 2026).
-- The stage sync now records a `Lead` event for each Facebook lead filed in
-- the last seven days, from the `leads` row itself — before Bitrix has any
-- deal for it, or when it never will (no name or phone). Such a row has no
-- deal and no stage, so the two columns may now be empty. Every existing row
-- keeps its values; the UNIQUE (leadgen_id, event_name) guarantee is
-- unchanged, so a lead's `Lead` is recorded once. At most four rows per lead
-- now (Lead, Qualified, Converted, Lost).
--
-- Relaxing a NOT NULL is idempotent: run twice, it changes nothing the second
-- time.

ALTER TABLE meta_crm_events ALTER COLUMN deal_id DROP NOT NULL;
ALTER TABLE meta_crm_events ALTER COLUMN stage_id DROP NOT NULL;
