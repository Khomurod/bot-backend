-- Migration 0111: home time brief visits
-- migrate:kind: schema
--
-- A visit home shorter than 12 hours is not a home stay, and a few hours on
-- the road between two home stays is not a road trip (owner, 27 November 2026).
--
-- WHY. In the 30 days to 27 November, 15 of 53 company-driver home stays
-- lasted under 12 hours and 8 under two: the Dispatcher Board flipping HOME
-- and back. Each one ended the road trip it interrupted, so the trip's extra
-- weeks were split, the bonus was decided on a home stay of 0 days, and the
-- next trip began at the flap, which accounting was then told was "came home
-- early after 0 days on the road".
--
-- WHAT THE COLUMNS RECORD. Nothing is deleted: a brief visit keeps its row,
-- marked, so a person can still see that the Board said HOME for 40 minutes.
--
--   driver_road_history.folded_at      when Wenze decided this home stay was
--                                      too short to be one. Its road trip
--                                      went on: the driver's road clock
--                                      continues from the trip's start, and
--                                      the next real home arrival records the
--                                      whole trip. A folded row carries no
--                                      bonus (the trip that continued does)
--                                      and is never judged by accounting.
--   driver_road_history.folded_reason  the same in words, with the figures
--                                      the row held before it was folded.
--   driver_road_history.reopened_at    the driver came back home a few hours
--                                      after this stay closed, so it was
--                                      reopened rather than a new one begun:
--                                      the home days are counted from the
--                                      FIRST arrival.
--   driver_road_history.reopened_note  the short road segment, in words.
--   driver_home_status.state_changed_at  when the state last actually
--                                      changed. Equal to state_since except
--                                      after a fold or a reopen, which set
--                                      state_since back to the start of the
--                                      trip or the stay that continues. The
--                                      Board watch's anti-flapping rules are
--                                      about the CHANGE, so they read this.
--
-- Additive and idempotent.

ALTER TABLE driver_road_history ADD COLUMN IF NOT EXISTS folded_at TIMESTAMPTZ;
ALTER TABLE driver_road_history ADD COLUMN IF NOT EXISTS folded_reason TEXT;
ALTER TABLE driver_road_history ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE driver_road_history ADD COLUMN IF NOT EXISTS reopened_note TEXT;
ALTER TABLE driver_home_status ADD COLUMN IF NOT EXISTS state_changed_at TIMESTAMPTZ;

COMMENT ON COLUMN driver_road_history.folded_at IS
  'A home stay under 12 hours: not a home stay. The road trip continued; the next arrival records it whole.';
COMMENT ON COLUMN driver_road_history.reopened_at IS
  'The driver came home again under 12 hours after this stay closed, so it was reopened, not begun anew.';
COMMENT ON COLUMN driver_home_status.state_changed_at IS
  'When the state last changed. state_since may be earlier after a brief visit is folded.';
