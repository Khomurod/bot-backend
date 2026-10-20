-- Migration 0073: forget the health rows of the background work removed in October 2026
-- migrate:kind: backfill
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. `system_health_states` holds one row per background
-- component, and the health screen lists every row it finds. Six components
-- went with the features the owner removed: Route Control (`route_control`),
-- the driver-raise review (`raise_approval`), BOL/POD forwarding
-- (`datatruck_documents`), and fuel (`fuel_risk`, `fuel_stop_alerts`,
-- `eld_location_freshness`). Nothing writes those rows any more, so each would
-- sit on the health screen saying "ok" for ever about work that does not run —
-- a health report that is not true.
--
-- DERIVED STATE, NOT HISTORY. A row is the latest status of a component, not
-- a record of events; deleting it loses nothing a person can act on. All six
-- read `ok` with no error when this was written (production, 2026-10-20).
-- Deleting a row that does not exist is a no-op, so a re-run changes nothing.

DELETE FROM system_health_states
 WHERE component IN (
   'route_control',
   'raise_approval',
   'datatruck_documents',
   'fuel_risk',
   'fuel_stop_alerts',
   'eld_location_freshness'
 );
