-- Migration 0087: meta crm events dataset
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.

--
-- WHY: Settings → Facebook ↔ Bitrix → Test (services/metaCrm/settingsTest.js,
-- check b) sends its one test event as an exact copy of an event Meta already
-- received, so Meta deduplicates it instead of counting a second conversion.
-- Deduplication happens inside ONE dataset. Without knowing which dataset a
-- sent row went to, a Test of a NEW dataset ID could copy an event the OLD
-- dataset received — a first, countable event in the new one (CodeRabbit,
-- PR #318).
--
-- dataset_id is the dataset Meta accepted the event into, written by markSent.
-- NULL on every row sent before this column existed: unknown, so the Test
-- never copies one of those — it only matches a row whose dataset_id equals
-- the dataset being tested.

ALTER TABLE meta_crm_events ADD COLUMN IF NOT EXISTS dataset_id TEXT;
