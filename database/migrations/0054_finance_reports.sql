-- Migration 0054: one weekly finance report per week, and only ever one
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR.
--
-- Migrations 0052 and 0053 made "what went out last week?" answerable. This is
-- the answer arriving on its own, on Monday morning, without anybody asking.
--
-- ONE AUTOMATIC REPORT PER PERIOD, AND THAT IS THE WHOLE POINT. A redeploy on
-- a Monday morning restarts every timer in the application, and a weekly job
-- whose only guard is "have I run since I started?" sends the same report
-- again — to a room of people who will reasonably assume the second one means
-- something. The claim in `service_runs` stops the second SEND; this row is the
-- record that the period was handled and what it said.
--
-- The uniqueness is a PARTIAL index, `WHERE status <> 'manual'`, because the
-- two things it governs are different. An automatic report happens to a period
-- exactly once, whatever restarts in between. A manual send is something a
-- PERSON did, deliberately, and they are allowed to do it twice — refusing the
-- second would be the tool arguing with its operator, and a manual row is
-- already distinguishable by its status.
--
-- `suppressed_backfill` IS A STATUS, NOT AN ABSENCE. If the monitor was
-- switched on partway through a period, a total drawn from it reads "$0 issued"
-- when the truth is "we were not watching". A row saying so is what tells the
-- difference later; no row at all would look identical to a job that never ran.
--
-- `totals` IS SQL-DERIVED, ALWAYS. Every number in it is COUNT/SUM over
-- finance_messages and finance_moneycodes. Nothing a model read out of a
-- document is ever summed into a report — see docs/architecture/ai-decisions.md
-- and docs/architecture/finance-monitor.md.
--
-- `body` IS STORED SO THE SENT TEXT CAN BE RE-READ. "What did last week's
-- report actually say" is a question a person asks after a disagreement, and
-- recomputing it from today's data answers a different question.

CREATE TABLE IF NOT EXISTS finance_reports (
  id                  BIGSERIAL PRIMARY KEY,
  period_start        TIMESTAMPTZ NOT NULL,
  period_end          TIMESTAMPTZ NOT NULL,
  scheduled_for       TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL,
  chat_id             TEXT,
  telegram_message_id BIGINT,
  totals              JSONB,
  body                TEXT,
  error               TEXT,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT finance_reports_status CHECK (
    status IN ('sent', 'failed', 'suppressed_backfill', 'manual')
  ),
  CONSTRAINT finance_reports_period_order CHECK (period_end > period_start)
);

-- One automatic report per period. Manual sends are excluded: see the header.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_finance_reports_period
  ON finance_reports (period_start)
  WHERE status <> 'manual';

CREATE INDEX IF NOT EXISTS idx_finance_reports_scheduled
  ON finance_reports (scheduled_for DESC);
