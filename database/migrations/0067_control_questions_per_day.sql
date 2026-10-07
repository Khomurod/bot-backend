-- Migration 0067: control questions per day
-- migrate:kind: schema
--
-- At most this many questions a day reach the notification group.
--
-- WHY. Production, 2026-10-06: twenty questions asked, none answered. The
-- per-pass cap and the "five outstanding" standing cap limit a burst; neither
-- limits a DAY, so the group was asked something most days whether or not
-- anybody was answering. The owner asked for one or two important questions a
-- day, with the reason — the most important first (money before records,
-- serious before routine), the rest waiting on Needs Attention.
--
-- Additive and idempotent.

ALTER TABLE control_settings
  ADD COLUMN IF NOT EXISTS max_questions_per_day SMALLINT NOT NULL DEFAULT 2;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'control_settings_questions_per_day'
  ) THEN
    ALTER TABLE control_settings ADD CONSTRAINT control_settings_questions_per_day
      CHECK (max_questions_per_day BETWEEN 0 AND 20);
  END IF;
END $$;
