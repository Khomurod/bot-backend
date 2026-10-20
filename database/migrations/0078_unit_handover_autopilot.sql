-- Migration 0078: hand a departed driver's truck to its new driver, on autopilot
-- migrate:kind: seed
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- THE OWNER'S DECISION, 20 October 2026. Ten trucks were still recorded to
-- drivers who had left (every chat of theirs inactive) while a new hire's
-- active chat claimed each one. The owner moved all ten and asked that the next
-- ones move by themselves. `identity.unit_handover` is that check; its action,
-- `identity.hand_over_unit`, re-checks under lock that the old holder still
-- has no active chat. A check with no row here is disabled (default deny), so
-- the instruction is this row. Cap 20: ten is what a fortnight of hiring
-- produced, and a pass that wants more has more likely found a bug.
--
-- ON CONFLICT DO NOTHING: a row a person already saved is their decision.
INSERT INTO operational_check_settings (check_key, auto_apply_enabled, mode, max_auto_per_run, updated_by, updated_at)
VALUES ('identity.unit_handover', TRUE, 'autopilot', 20, 'migration 0078 (owner decision B2, 2026-10-20)', NOW())
ON CONFLICT (check_key) DO NOTHING;
