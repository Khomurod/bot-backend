-- Migration 0092: a truck row's fleet follows the driver's profile, on autopilot
-- migrate:kind: seed
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- THE OWNER'S DECISION, 5 November 2026. Eleven trucks kept the fleet their
-- row was opened with: 077, 121, 124, 182, 322, 4135, 7777 and 25438 (Company
-- driver on the profile, Owner-Operator on the truck row — most of them chats
-- titled with the bare `( COMPANY )` the title parser learned only in October)
-- and 266116, 311, 319 (Lease on the profile, Owner-Operator or Company on the
-- row). The Dispatcher
-- Board matches a driver by truck AND fleet, so the board could not recognise
-- them. The owner asked that the row follow the profile, by itself.
-- `identity.unit_fleet_behind_profile` is that check; its action,
-- `identity.sync_unit_fleet`, re-reads the profile under lock, never moves a
-- row onto a truck somebody else holds in that fleet, and closes the old row
-- rather than editing it. A check with no row here is disabled (default deny),
-- so the instruction is this row. Cap 20: eleven is what production holds today,
-- and a pass that wants more has more likely found a bug.
--
-- ON CONFLICT DO NOTHING: a row a person already saved is their decision.
INSERT INTO operational_check_settings (check_key, auto_apply_enabled, mode, max_auto_per_run, updated_by, updated_at)
VALUES ('identity.unit_fleet_behind_profile', TRUE, 'autopilot', 20, 'migration 0092 (owner decision, 2026-11-05)', NOW())
ON CONFLICT (check_key) DO NOTHING;
