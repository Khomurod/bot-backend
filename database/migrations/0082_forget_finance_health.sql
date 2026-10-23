-- Migration 0082: forget the health rows of the removed Finance Monitor workers
-- migrate:kind: backfill
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. The owner removed the Finance Monitor on 23 October 2026
-- (docs/architecture/retired-finance-monitor.md). Three workers went with it:
-- the finance document reader (`finance_document_reader`), the weekly
-- money-code report (`finance_weekly_report`) and the re-read after a parser
-- change (`finance_reparse`). Each reported itself as a heartbeat row in
-- `background_service_runs` and, through the health observations, a row in
-- `system_health_states`. Nothing writes those rows any more, so each would sit
-- there saying "ok" — or "blocked", waiting for a switch that no longer exists
-- — for ever about work that does not run: a health report that is not true.
-- Same reasoning as migrations 0073 and 0081.
--
-- DERIVED STATE, NOT HISTORY. Every row deleted here is the latest status of a
-- component, not a record of events; deleting it loses nothing a person can
-- act on. The finance tables themselves — the money-code record — are NOT
-- touched: they are droppable by an administrator in Settings → Retired
-- feature leftovers, after a backup. Deleting a row that does not exist is a
-- no-op, so a re-run changes nothing.

DELETE FROM system_health_states
 WHERE component IN (
   'finance_document_reader',
   'finance_weekly_report',
   'finance_reparse'
 );

DELETE FROM background_service_runs
 WHERE service_key IN (
   'finance_document_reader',
   'finance_weekly_report',
   'finance_reparse'
 );
