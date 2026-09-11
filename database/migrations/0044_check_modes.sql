-- Migration 0044: Observe, Suggest, Autopilot — and Shadow beside them
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: A BOOLEAN CANNOT SAY "WATCH, AND TELL ME WHAT YOU WOULD HAVE DONE".
--
-- `auto_apply_enabled` has exactly two positions: correct things by yourself,
-- or propose and wait. There is no way to say "do not even propose this yet, I
-- am still watching", and no way to say "decide as if you were allowed, write
-- down what you would have done, and do nothing" — which is the only honest way
-- to find out whether a check DESERVES to be trusted before trusting it.
--
-- Three modes, and the ordering is the amount of authority given away:
--
--   observe    decide and record; propose nothing, do nothing
--   suggest    propose to a person; never act. TODAY'S DEFAULT
--   autopilot  act, within the per-run cap, and announce it
--
-- SHADOW IS NOT A FOURTH MODE, it is orthogonal. A check in Suggest can be
-- shadowed and a check in Autopilot can be shadowed; both then decide fully,
-- record what they WOULD have done, and do nothing. Making it a mode would have
-- forced an operator to give up their real setting to try it, and would have
-- lost it again when they turned shadow off.
--
-- THE MAPPING PRESERVES TODAY EXACTLY. `auto_apply_enabled = TRUE` becomes
-- `autopilot`; FALSE becomes `suggest`; and a check with NO ROW — which is most
-- of them — keeps meaning `suggest`, because today such a check still files
-- findings and simply never applies them. Nothing turns on and nothing turns
-- off at deploy.
--
-- AND THE DATABASE KEEPS THE TWO HONEST. `auto_apply_enabled` stays, because
-- `services/operations/corrections/autoApply.js` reads it, and a column quietly
-- abandoned while another took over is the exact failure this project keeps
-- finding: two things that should agree, kept in step by nobody. A CHECK makes
-- disagreement impossible, so a future writer that updates one and forgets the
-- other gets an error instead of silently arming or disarming automation.

ALTER TABLE operational_check_settings
  ADD COLUMN IF NOT EXISTS mode TEXT NULL,
  ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill BEFORE the constraints, or the CHECK below fails on existing rows.
UPDATE operational_check_settings
   SET mode = CASE WHEN auto_apply_enabled THEN 'autopilot' ELSE 'suggest' END
 WHERE mode IS NULL;

ALTER TABLE operational_check_settings
  ALTER COLUMN mode SET DEFAULT 'suggest';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'operational_check_settings' AND column_name = 'mode'
       AND is_nullable = 'YES'
  ) AND NOT EXISTS (SELECT 1 FROM operational_check_settings WHERE mode IS NULL) THEN
    ALTER TABLE operational_check_settings ALTER COLUMN mode SET NOT NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operational_check_settings_mode_check') THEN
    ALTER TABLE operational_check_settings ADD CONSTRAINT operational_check_settings_mode_check
      CHECK (mode IN ('observe', 'suggest', 'autopilot'));
  END IF;

END$$;

-- WHY THERE IS NO CHECK FORCING THE TWO COLUMNS TO AGREE, having tried one.
--
-- The obvious guard is `CHECK (auto_apply_enabled = (mode = 'autopilot'))`, and
-- it was written first. It broke something worth more than it was: migration
-- 0027 seeds three checks with `auto_apply_enabled` alone and `ON CONFLICT DO
-- NOTHING`, so on a database where those rows are absent it inserts them with
-- the boolean set and `mode` at its default — and the constraint refuses. That
-- makes an older migration no longer re-appliable, and "the migration re-applies
-- as a no-op" is a property this repository tests for on purpose.
--
-- The better answer is to make drift HARMLESS rather than forbidden. `mode` is
-- the authority: `services/operations/corrections/autoApply.js` reads it, and
-- nothing that ACTS reads the boolean any more. A stale `auto_apply_enabled`
-- can therefore be wrong without anything behaving wrongly, which is a weaker
-- guarantee about the data and a stronger one about the system.
--
-- The data layer still writes both in one statement, and
-- `tests/checkModesPg.test.js` carries a sentinel asserting no row disagrees —
-- so drift is still caught, in CI, rather than by refusing a write somebody had
-- every right to make.
