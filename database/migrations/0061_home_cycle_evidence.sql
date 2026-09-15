-- Why each home cycle opened, and why it closed.
--
-- WHAT WAS MISSING. `driver_road_history` records the two timestamps and the
-- bonus, and says nothing about where either timestamp came from. That was
-- tolerable while the only writer was a driver typing "Status: Home" in their
-- own chat. It stops being tolerable the moment Wenze opens and closes cycles
-- from the Dispatcher Board, because a manager looking at "home 14 - 18 Sep"
-- has no way to ask whether a person said so or a spreadsheet did, and a
-- correction nobody can trace is a correction nobody can argue with.
--
-- So each side of the cycle now carries WHO said it and WHAT they said:
--   opened_by / closed_by        a short source token - driver_message,
--                                dispatcher_board, admin, import, evidence
--   opened_evidence / closed_evidence  the sentence a person reads
--
-- HISTORICAL ROWS ARE LEFT NULL, deliberately. Backfilling them with a guessed
-- source would be inventing the very provenance this migration exists to
-- record; a blank column honestly says "written before Wenze tracked this".
--
-- Additive and idempotent.

ALTER TABLE driver_road_history
  ADD COLUMN IF NOT EXISTS opened_by TEXT,
  ADD COLUMN IF NOT EXISTS opened_evidence TEXT,
  ADD COLUMN IF NOT EXISTS closed_by TEXT,
  ADD COLUMN IF NOT EXISTS closed_evidence TEXT;
