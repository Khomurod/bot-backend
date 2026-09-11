-- Migration 0042: count the things that went unheard, not the number of times
-- the same ones were reconsidered
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THIS EXISTS: A COUNTER THAT SHIPPED WRONG, FOUND IN PRODUCTION AN HOUR
-- LATER.
--
-- Migration 0041 added `notification_discards` so that "no destination is
-- configured" would stop being a sentence nobody acts on and become a number
-- somebody does. It counted the wrong thing.
--
-- `notify()` resolves the destination BEFORE it builds the notice key, so with
-- nowhere to send, the discard was recorded several lines above the dedup that
-- makes a notice idempotent. The load-lifecycle watch reconsiders the same
-- conflicted loads every ten minutes and `worthAsking` has no time gate, so
-- each reconsideration was counted again.
--
-- WHAT WAS ACTUALLY OBSERVED, and no more than that: `load_lifecycle` went
-- from 47 to 162 discards in the twenty minutes after the deploy, against
-- roughly 48 conflicted loads and 12 fuel notices — so about 60 distinct
-- things had been counted 162 times. It then held at 162 for two readings,
-- which is why no weekly figure is extrapolated here: the growth rate depends
-- on how often each watch re-notifies, and that was not measured long enough
-- to state.
--
-- The inflation is real regardless of its rate. A wrong number is worse than
-- the sentence it replaced, because the whole argument for 0041 was that the
-- cost of silence should be legible, and a count that rises without anything
-- new going unheard is not legible.
--
-- WHAT THIS STORES, AND WHAT IT DELIBERATELY DOES NOT.
--
-- One row per DISTINCT notice key that was thrown away: the key and when it was
-- first seen. The key is `category:subjectType:subjectId:discriminator` — for a
-- load, `load_lifecycle:load:9001:2026-09-11`. It carries no body, no driver
-- name, no phone number and no chat id.
--
-- It is NOT the backlog this design refuses to build. A row here can never be
-- claimed, sent, or read back into a message; there is nothing in it to send.
-- The day a destination is finally configured, nothing in this table delivers.
--
-- AND IT DOES NOT TOUCH DELIVERY. `noticeSentWithin` still answers only about
-- notices that were queued or sent, so configuring a destination announces
-- everything still true rather than waiting out a repeat window that a discard
-- quietly started. That distinction is the reason this is a separate table
-- rather than a terminal status on the outbox.
--
-- The discriminator is what bounds it. Callers that re-check a condition change
-- the discriminator when the EVENT changes — the load watch uses the date — so
-- a load conflicted for a month is thirty rows, not four thousand.

CREATE TABLE IF NOT EXISTS notification_discard_keys (
  notice_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'no_destination',
  first_discarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- For the prune, and for "how much has gone unheard since Tuesday".
CREATE INDEX IF NOT EXISTS idx_notification_discard_keys_seen
  ON notification_discard_keys (first_discarded_at DESC);
