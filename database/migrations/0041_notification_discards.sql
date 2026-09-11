-- Migration 0041: count what is thrown away when nothing is configured
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: "NOT CONFIGURED" IS A SENTENCE NOBODY ACTS ON. A NUMBER IS.
--
-- With no Telegram destination set, `notify()` discards every notice at the
-- door. That is the right behaviour and was chosen deliberately: enqueuing them
-- would mean that on the day a destination is finally configured, months of
-- stale alerts flood a live staff chat — which is exactly what this repository
-- decided NOT to do with 98 expired home-time alerts.
--
-- But the cost of that decision is invisible. Production right now reports
-- `notifications.reachable: false`, every background feature runs, finds real
-- things, and says nothing — and the admin shows a grey "not configured" note
-- that reads like every other optional setting. The whole project started
-- because 101 staff alerts were discarded for months without anybody noticing,
-- and the replacement had quietly reproduced the same silence by a different
-- route.
--
-- So the discards are COUNTED. One row per category, nine rows forever, no
-- bodies and no subjects — the count, the first time it happened and the last.
-- "Nothing is configured" becomes "1,247 notices were thrown away this week,
-- 900 of them Needs attention", which is a sentence somebody acts on.
--
-- WHAT IT DELIBERATELY DOES NOT STORE: the notice itself. Keeping the bodies
-- would be the backlog this design refuses to build, one table over.

CREATE TABLE IF NOT EXISTS notification_discards (
  category TEXT PRIMARY KEY,
  -- Why it was thrown away. Today only 'no_destination' and 'disabled', both of
  -- which are somebody's decision rather than a fault.
  reason TEXT NOT NULL DEFAULT 'no_destination',
  discarded_count BIGINT NOT NULL DEFAULT 0,
  first_discarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_discarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
