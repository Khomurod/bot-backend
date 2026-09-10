-- Migration 0025: a policy page that moved, and one that was lost
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY. Official URLs change. A terms page redirects to a new address, a docs
-- site is reorganised, a deprecation page is created where none existed. The
-- watcher used to record each of those as a fetch error and count failures
-- until a person noticed the count. It now follows the move itself and only
-- asks a person when it genuinely cannot find the page again — so the row
-- needs to remember where it came from and when it was last found.
--
--   redirected_to     the final URL the last fetch landed on, when it differed
--                     from `url`. Recorded on every check; `url` itself is
--                     switched only when the move looks like the page's new
--                     home (same site), so a redirect to a generic landing page
--                     is visible without becoming the watched source.
--   moved_from        the previous `url` when Wenze switched to a new one,
--                     so the change is reviewable and reversible by hand.
--   rediscovered_at   when the page was last found again after being lost.
--   lost_reported_at  when a person was last told this page could not be
--                     found. NULL once it is found again, so the next loss
--                     is reported afresh rather than swallowed as "already told".

ALTER TABLE ai_policy_sources ADD COLUMN IF NOT EXISTS redirected_to TEXT NULL;
ALTER TABLE ai_policy_sources ADD COLUMN IF NOT EXISTS moved_from TEXT NULL;
ALTER TABLE ai_policy_sources ADD COLUMN IF NOT EXISTS rediscovered_at TIMESTAMPTZ NULL;
ALTER TABLE ai_policy_sources ADD COLUMN IF NOT EXISTS lost_reported_at TIMESTAMPTZ NULL;
