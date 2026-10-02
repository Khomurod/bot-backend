-- Migration 0063: load lifecycle retired
-- migrate:kind: schema
--
-- A load the board has stopped returning is finished, and now it says so.
--
-- WHY. Production, 2026-10-02: 713 loads tracked for about a hundred trucks,
-- 289 of them sitting in `assigned`. The lifecycle watch reads Datatruck's
-- order window (two days back, five ahead) and only ever touches the loads in
-- it. A load that drops out of the window is never looked at again — its phase
-- freezes wherever it was — and nothing marked it gone. The only exit was the
-- 30-day prune. Meanwhile every reader kept treating the frozen phase as the
-- present: a load frozen `in_transit` counted as "working" against a driver
-- who is at home, and one frozen `empty` fed "sitting empty since" for weeks.
--
-- A SOFT MARK, NOT A DELETE, because the row still answers "what did this
-- driver run last week?" and the prune already deletes on its own schedule.
-- An order that reappears in the window is un-retired by the next
-- observation (database/loadLifecycle.js recordLoadObservation).
--
-- Additive and idempotent.

ALTER TABLE load_lifecycle ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE load_lifecycle ADD COLUMN IF NOT EXISTS retired_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'load_lifecycle_retired_reason_check'
  ) THEN
    ALTER TABLE load_lifecycle ADD CONSTRAINT load_lifecycle_retired_reason_check
      CHECK (
        (retired_at IS NULL AND retired_reason IS NULL)
        -- `IS NOT NULL` spelled out: `NULL IN (...)` is NULL, and a CHECK
        -- passes on NULL, so without it a retirement with no reason got in.
        OR (retired_at IS NOT NULL AND retired_reason IS NOT NULL
            AND retired_reason IN ('delivered', 'left_the_board'))
      );
  END IF;
END $$;

-- Every reader asks "the loads that are current", so that is what is indexed.
CREATE INDEX IF NOT EXISTS idx_load_lifecycle_current_group
  ON load_lifecycle (group_id) WHERE retired_at IS NULL;

COMMENT ON COLUMN load_lifecycle.retired_at IS
  'When the lifecycle watch stopped seeing this order in the board window. NULL = current. Readers that mean "now" must filter on it.';
COMMENT ON COLUMN load_lifecycle.retired_reason IS
  'delivered = it finished delivered before it left the window; left_the_board = it left the window in any other phase.';
