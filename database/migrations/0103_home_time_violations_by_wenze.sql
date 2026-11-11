-- Migration 0103: home time violations by wenze
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WENZE DECIDES HOME-TIME VIOLATIONS ITSELF (owner, 11 November 2026). The
-- external script that moved Bitrix pipeline 33's cards was switched off and
-- abandoned; the last alert went out on 31 October. Now Wenze reads its own
-- home/road record (the Dispatcher Board — only HOME is home — and the
-- drivers' own messages, services/homeTimeService.js), decides "came home
-- early" (fewer than 28 days on the road) and "overstayed" (more than 4 days
-- home) for company drivers, posts accounting's alert exactly as before, and
-- moves the driver's card in pipeline 33 itself.
--
--   home_time_settings.violation_source   'wenze' (now) or 'bitrix' (the old
--       script's cards). Exactly one decides; the other path stands down, so a
--       card Wenze moved is never alerted on a second time.
--   home_time_settings.own_violations_since   when Wenze started deciding:
--       only home stays that begin after it are judged — no backlog (owner).
--   home_time_violation_notices: a Wenze-decided row is keyed by the driver's
--       group + home-since date + violation (`source = 'wenze'`); its Bitrix
--       card is optional (deal_id may be NULL when none could be matched).
--   home_time_policy_exceptions   a driver's own rule ("3 weeks on the road,
--       3 days home"), set by anyone with access on the Home Time page.

ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS violation_source TEXT NOT NULL DEFAULT 'wenze';
ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS own_violations_since TIMESTAMPTZ;

ALTER TABLE home_time_violation_notices
  ALTER COLUMN deal_id DROP NOT NULL;
ALTER TABLE home_time_violation_notices
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'bitrix';
ALTER TABLE home_time_violation_notices
  ADD COLUMN IF NOT EXISTS group_id INTEGER;
-- The rule the stay was judged by, when it was the driver's own (else NULL = policy).
ALTER TABLE home_time_violation_notices
  ADD COLUMN IF NOT EXISTS rule_road_days INTEGER;
ALTER TABLE home_time_violation_notices
  ADD COLUMN IF NOT EXISTS rule_home_days INTEGER;
-- What happened to the driver's pipeline-33 card: moved, not found, two match…
ALTER TABLE home_time_violation_notices
  ADD COLUMN IF NOT EXISTS bitrix_note TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS home_time_violation_notices_wenze_once
  ON home_time_violation_notices (group_id, home_from, violation)
  WHERE source = 'wenze';

CREATE TABLE IF NOT EXISTS home_time_policy_exceptions (
  id            BIGSERIAL PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  -- NULL keeps the company policy for that half (28 days road / 4 days home).
  road_days     INTEGER CHECK (road_days IS NULL OR road_days BETWEEN 1 AND 365),
  home_days     INTEGER CHECK (home_days IS NULL OR home_days BETWEEN 0 AND 365),
  valid_until   DATE,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at    TIMESTAMPTZ
);

-- One rule per driver group at a time.
CREATE UNIQUE INDEX IF NOT EXISTS home_time_policy_exceptions_one_active
  ON home_time_policy_exceptions (group_id)
  WHERE removed_at IS NULL;
