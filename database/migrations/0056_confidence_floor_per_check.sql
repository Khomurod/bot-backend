-- A per-check confidence floor, so a learning proposal can become a real
-- setting instead of a paragraph.
--
-- THE LOWER BOUND IS THE SAFETY PROPERTY, and it is enforced by the database
-- rather than by code. `MIN_CONFIDENCE` in the decision seam is 70; this column
-- may hold 70 to 95 and nothing else. So an applied proposal can only ever make
-- a check MORE cautious, and a value that would grant the machine more autonomy
-- cannot be stored at all — not by the learning pass, not by a route, not by a
-- mistake in a later refactor.
--
-- 95 rather than 100 at the top: a floor of 100 would stop the check acting
-- entirely, which is a switch-off wearing the clothes of a threshold, and there
-- is already an honest action for that (`disable_auto_apply`).
--
-- NULL means "inherit the global floor", the same convention every other
-- settings column in this application uses. A check nobody has tuned keeps
-- behaving exactly as it does today, so this migration changes no behaviour by
-- itself.
ALTER TABLE operational_check_settings
  ADD COLUMN IF NOT EXISTS min_confidence SMALLINT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'operational_check_settings_min_confidence_range'
  ) THEN
    ALTER TABLE operational_check_settings
      ADD CONSTRAINT operational_check_settings_min_confidence_range
      CHECK (min_confidence IS NULL OR min_confidence BETWEEN 70 AND 95);
  END IF;
END $$;

-- Who moved it and when, so an applied proposal is auditable and revertible
-- without reading the audit log for context that belongs on the row.
ALTER TABLE operational_check_settings
  ADD COLUMN IF NOT EXISTS min_confidence_set_by TEXT NULL;
ALTER TABLE operational_check_settings
  ADD COLUMN IF NOT EXISTS min_confidence_set_at TIMESTAMPTZ NULL;
