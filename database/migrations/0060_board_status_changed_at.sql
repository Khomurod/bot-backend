-- When did this driver's BOARD STATUS last change — as opposed to anything else
-- about the row.
--
-- WHY A SECOND TIMESTAMP. `last_changed_at` already moves on a real change, but
-- "real" there means any of eleven meaningful columns: an ETA note retyped, a
-- trailer swapped, a dispatcher renamed. Home-time detection needs a narrower
-- question — "has the board said HOME steadily for long enough to act on" — and
-- answering it from `last_changed_at` would mean a dispatcher editing an ETA
-- resets the confirmation window and a driver who really is home is never
-- recorded as home.
--
-- Backfilled from `last_changed_at` because that is the best evidence already
-- in the table: it is the most recent moment anything about the row moved, so
-- the status has certainly held since at most then. Erring early here is safe —
-- the first poll after this migration corrects any row whose status changes,
-- and the confirmation window only ever delays a transition, never invents one.
--
-- Additive and idempotent.

ALTER TABLE dispatch_board_rows
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

UPDATE dispatch_board_rows
   SET status_changed_at = COALESCE(last_changed_at, first_seen_at, NOW())
 WHERE status_changed_at IS NULL;

-- THE DEFAULT IS SET AFTER THE BACKFILL, NOT WITH THE COLUMN. Declaring
-- DEFAULT NOW() on the ADD COLUMN would stamp every existing row with the
-- migration's own clock and throw away the backfill above. Adding it here
-- leaves history alone and still means a row the poller inserts TOMORROW knows
-- when its status began -- without which a driver seen for the first time could
-- never satisfy the confirmation window, and would sit unmoved for ever.
ALTER TABLE dispatch_board_rows
  ALTER COLUMN status_changed_at SET DEFAULT NOW();

-- The home-time watch reads present rows by status on every pass.
CREATE INDEX IF NOT EXISTS idx_dispatch_board_rows_status_changed
  ON dispatch_board_rows (status, status_changed_at) WHERE present;
