-- Migration 0028: lift the untouched default cap on the two repairs a person
-- had already switched on, to exactly the measured count
-- migrate:kind: seed
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT PRODUCTION SHOWED. Migration 0027 seeded three switches with their
-- measured caps — and found two rows already there: an administrator had
-- switched `home_time.closable_open_cycle` and `identity.stale_unit_assignment`
-- on earlier, at the schema's default cap of 50, which 0027 rightly left
-- alone. The first background pass after deploy then read, on /api/health:
--
--   home_time.closable_open_cycle    wanted 65   cap 50   → applied nothing
--   identity.stale_unit_assignment   wanted 100  cap 50   → applied nothing
--
-- Both counts are EXACTLY the measurements the owner's instruction rests on
-- (65 closable cycles; 100 drivers with no recorded truck). The cap did its
-- job — it stopped a batch nobody had sized — and now the batch is sized.
--
-- WHAT THIS TOUCHES, AND ONLY THIS. A row that is already enabled AND still
-- carries the default 50 — the one value nobody chose. A cap a person typed
-- (10, 25, 200) is theirs and is not changed; a disabled check is not
-- changed; a row that does not exist is not created (0027 owns that). Run
-- once: whatever an administrator sets afterwards sticks.
UPDATE operational_check_settings
   SET max_auto_per_run = 65,
       updated_by = 'migration 0028 (measured: 65 closable cycles, 2026-09-10)',
       updated_at = NOW()
 WHERE check_key = 'home_time.closable_open_cycle'
   AND auto_apply_enabled = TRUE
   AND max_auto_per_run = 50;

UPDATE operational_check_settings
   SET max_auto_per_run = 100,
       updated_by = 'migration 0028 (measured: 100 drivers without a recorded truck, 2026-09-10)',
       updated_at = NOW()
 WHERE check_key = 'identity.stale_unit_assignment'
   AND auto_apply_enabled = TRUE
   AND max_auto_per_run = 50;
