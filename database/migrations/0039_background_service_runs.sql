-- Migration 0039: one row per background worker, saying whether it has actually
-- run — the thing an empty result set cannot say
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THIS EXISTS: A WORKER THAT SILENTLY STOPPED LOOKS EXACTLY LIKE A QUIET
-- FLEET.
--
-- Twenty-five background services run in this application. Three of them
-- expose a `lastRun` for /api/health, and all three keep it in PROCESS MEMORY,
-- so a Render restart makes them report `lastRun: null` — indistinguishable
-- from "this pass has never worked in its life". The other twenty-two expose
-- nothing at all: `runFuelRiskCheck`, `runLoadLifecyclePass`, `runSafetyCoach`
-- and `runReturnToRoadPass` each build a detailed per-pass summary and their
-- `tick()` throws it away.
--
-- So the honest state of the system today is that nobody can tell a worker that
-- found nothing from a worker whose timer was never armed, and the second one
-- has happened: an unset notification destination silently discarded every
-- notice for weeks while every feature reported success.
--
-- ONE ROW PER SERVICE, UPDATED IN PLACE. About twenty-five rows forever. This
-- is deliberately NOT a run history — a table with a row per tick would be the
-- largest table in the database within a month and nobody would read the old
-- rows. What is kept is the last outcome, when it happened, and the counters
-- needed to tell "failing since Tuesday" from "failed once at lunchtime".
--
-- `last_status` is a closed vocabulary and `blocked` is the interesting one:
--
--   ok       the pass completed. `last_summary` says what it found.
--   error    the pass threw. `last_error` says what, with no payload.
--   skipped  the pass ran and correctly did nothing (nothing was due).
--   blocked  the pass CANNOT run until a person configures something. This is
--            not a failure and must never be reported as one — it is the
--            "features requiring owner configuration clearly report that fact"
--            case, and rendering it as an error is how a real outage gets lost
--            among things that were never switched on.
--
-- `expected_interval_seconds` is what makes staleness decidable without the
-- code: a pass that has not finished in several of its own intervals has
-- stopped, whatever it last said.

CREATE TABLE IF NOT EXISTS background_service_runs (
  service_key TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ NULL,
  last_finished_at TIMESTAMPTZ NULL,
  last_status TEXT NULL,
  last_error TEXT NULL,
  last_summary JSONB NULL,
  last_ok_at TIMESTAMPTZ NULL,
  -- When it last FAILED, kept after it recovers. Without this a recovery is not
  -- detectable: a worker with zero consecutive failures and a non-zero lifetime
  -- failure count looks identical whether it recovered a minute ago or in March,
  -- and "working again" is only worth saying about the first.
  last_error_at TIMESTAMPTZ NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  runs_total BIGINT NOT NULL DEFAULT 0,
  failures_total BIGINT NOT NULL DEFAULT 0,
  expected_interval_seconds INTEGER NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'background_service_runs_status_check'
  ) THEN
    ALTER TABLE background_service_runs
      ADD CONSTRAINT background_service_runs_status_check
      CHECK (last_status IS NULL OR last_status IN ('ok', 'error', 'skipped', 'blocked'));
  END IF;
END$$;

-- The query self-healing makes every half hour: everything, ordered by how long
-- it has been since anybody heard from it.
CREATE INDEX IF NOT EXISTS idx_background_service_runs_finished
  ON background_service_runs (last_finished_at DESC NULLS FIRST);
