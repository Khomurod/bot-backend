-- Migration 0081: forget the health rows of the removed dispatcher ETA worker
-- migrate:kind: backfill
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. The owner removed the dispatcher ETA updates, /update,
-- /status, /load and the pinned-load reading on 23 October 2026
-- (docs/architecture/retired-dispatch-eta.md). The ETA scheduler reported
-- itself as `dispatch_eta`: a heartbeat row in `background_service_runs` and,
-- through the health observations, a row in `system_health_states`. Nothing
-- writes either any more, so each would sit there saying "ok" for ever about
-- work that does not run — a health report that is not true. Same reasoning
-- as migration 0073 for the components removed before it.
--
-- DERIVED STATE, NOT HISTORY. Both rows are the latest status of a component,
-- not a record of events; deleting them loses nothing a person can act on. The
-- ETA tables themselves are NOT touched here — they are droppable by an
-- administrator in Settings → Retired feature leftovers, after a backup.
-- Deleting a row that does not exist is a no-op, so a re-run changes nothing.

DELETE FROM system_health_states WHERE component = 'dispatch_eta';

DELETE FROM background_service_runs WHERE service_key = 'dispatch_eta';
