-- Driver Raises: the dispatch roster is rebuilt from the Dispatcher Board.
--
-- WHY THE COLUMNS BELOW EXIST. Until now `dispatch_team_drivers` recorded only
-- that somebody had put a driver on a team — never WHO decided it or on what
-- evidence. That was workable while every row was typed by a person. It stops
-- being workable the moment a weekly job rebuilds the roster from the Board,
-- because the job then has no way to tell its own earlier work from a decision
-- a human made deliberately, and "do not silently fight the human" cannot be
-- implemented against a table that cannot see the difference.
--
-- So each assignment now says where it came from, what the Board said when it
-- was made, and — when a person overrode the Board — that a person did it and
-- when. A manual row is never rewritten by reconciliation; it is reported as a
-- standing override instead.
--
-- NOTHING HISTORICAL MOVES. `raise_round_picks` snapshots the driver list at
-- the moment a round was submitted, so a completed review keeps showing the
-- team and drivers it actually had. This migration touches only the CURRENT
-- roster, and every existing row is marked `manual` precisely because that is
-- what it is: somebody typed it, and reconciliation must not silently discard
-- work whose reasoning it cannot see.
--
-- Additive and idempotent: every statement guards itself and re-running does
-- nothing, so this cannot fail a boot.

ALTER TABLE dispatch_team_drivers
  -- 'board'  — reconciliation placed this driver from the current Board.
  -- 'manual' — a person placed or moved them; reconciliation leaves it alone.
  ADD COLUMN IF NOT EXISTS assignment_source TEXT NOT NULL DEFAULT 'manual',
  -- What the Board's dispatcher cell said when this row was last reconciled.
  -- Stored verbatim so "why is this driver on this team" is answerable later
  -- without re-reading a spreadsheet that has since changed.
  ADD COLUMN IF NOT EXISTS board_dispatcher TEXT,
  ADD COLUMN IF NOT EXISTS board_row_key TEXT,
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ,
  -- A HUMAN OVERRIDE IS A FACT WITH A TIME AND AN AUTHOR, not a flag. Without
  -- the two companions "a person decided this" degrades to folklore the first
  -- time somebody asks when and who.
  ADD COLUMN IF NOT EXISTS manual_override_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manual_override_by TEXT,
  -- Why a row could not be settled automatically, in words a person reads.
  ADD COLUMN IF NOT EXISTS review_reason TEXT;

DO $$
BEGIN
  ALTER TABLE dispatch_team_drivers DROP CONSTRAINT IF EXISTS dispatch_team_drivers_assignment_source;
  ALTER TABLE dispatch_team_drivers ADD CONSTRAINT dispatch_team_drivers_assignment_source CHECK (
    assignment_source IN ('board', 'manual')
  );
END $$;

-- EVERY PRE-EXISTING ROW IS A MANUAL ONE. It was typed by a person before the
-- Board could place anybody, so the default above is already right — this is
-- written out only so the intent is not left to a default nobody reads. Rows
-- that reconciliation later places from the Board flip to 'board' themselves.
UPDATE dispatch_team_drivers
   SET assignment_source = 'manual'
 WHERE assignment_source IS NULL;

-- Reconciliation reads the roster by source on every pass.
CREATE INDEX IF NOT EXISTS idx_dispatch_team_drivers_source
  ON dispatch_team_drivers (assignment_source) WHERE active;
