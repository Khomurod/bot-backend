-- Migration 0064: road bonus decision
-- migrate:kind: schema
--
-- The extra-week road bonus is decided when the driver goes BACK on the road,
-- not when they get home — and sometimes by a person.
--
-- THE OWNER'S RULE (2026-10-06). The bonus is paid after the driver's home
-- stay. A driver who stays home longer than the home allowance (4 days) has
-- broken the arrangement the bonus pays for, and gets no bonus at all. And a
-- road trip longer than six weeks is checked by a person before anything is
-- paid: production reported a 117-day trip worth $1,200 whose road clock had
-- simply never been reset.
--
-- Until now the bonus summary was posted the moment the driver got home, so
-- neither rule could be applied — the home stay had not happened yet.
--
-- `bonus_decision`, one per leg that carries a bonus:
--   waiting_home_stay  the driver is home; nothing is decided until they leave
--   released           the summary may be posted (the poller posts it)
--   needs_review       a person must approve it first (Needs Attention / Telegram)
--   forfeited          home longer than the allowance: no bonus
-- NULL is every leg from before this change. Those were already posted or
-- claimed at the transition, and nothing reads them for a decision.
--
-- Additive and idempotent.

ALTER TABLE driver_road_history ADD COLUMN IF NOT EXISTS bonus_decision TEXT;
ALTER TABLE driver_road_history ADD COLUMN IF NOT EXISTS bonus_decision_reason TEXT;
ALTER TABLE driver_road_history ADD COLUMN IF NOT EXISTS bonus_decided_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'driver_road_history_bonus_decision_check'
  ) THEN
    ALTER TABLE driver_road_history ADD CONSTRAINT driver_road_history_bonus_decision_check
      CHECK (
        bonus_decision IS NULL
        OR bonus_decision IN ('waiting_home_stay', 'released', 'needs_review', 'forfeited')
      );
  END IF;
END $$;

-- The two questions the poller asks every ten minutes: which legs can now be
-- decided, and which decided legs are waiting to be posted.
CREATE INDEX IF NOT EXISTS idx_driver_road_history_bonus_waiting
  ON driver_road_history (id)
  WHERE bonus_decision = 'waiting_home_stay' AND bonus_posted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_driver_road_history_bonus_review
  ON driver_road_history (id)
  WHERE bonus_decision = 'needs_review' AND bonus_posted_at IS NULL;

COMMENT ON COLUMN driver_road_history.bonus_decision IS
  'waiting_home_stay | released | needs_review | forfeited. NULL = a leg from before decisions existed (already posted).';
COMMENT ON COLUMN driver_road_history.bonus_decision_reason IS
  'Why it was decided this way, in words a manager reads.';
