-- Migration 0007: database transfer usage
-- migrate:kind: schema
--
-- One row per UTC month recording how much data this application has read out
-- of the database, so the estimate survives a Render restart and the admin
-- panel can warn BEFORE the hosted database's monthly transfer allowance runs
-- out. The incident that prompted it: 4.222 GB of a 5 GB monthly allowance
-- already spent, with nothing in the application aware of it.
--
-- The numbers are this app's own ESTIMATE (see database/transferMeter.js), not
-- the provider's accounting: Postgres does not report the bytes it puts on the
-- wire, so result sizes are sampled and extrapolated. It is a trend and an
-- early warning, never an invoice.
--
-- Cost of the table itself is deliberately negligible: one row per month,
-- updated by a single UPSERT at most once a minute.
--
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS only, no changes to any
-- existing table, no data touched.

CREATE TABLE IF NOT EXISTS database_transfer_usage (
  month_key        TEXT PRIMARY KEY,          -- 'YYYY-MM', UTC
  bytes_estimated  BIGINT NOT NULL DEFAULT 0, -- estimated bytes read this month
  queries          BIGINT NOT NULL DEFAULT 0,
  rows_read        BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE database_transfer_usage IS
  'Estimated monthly data read from this database by the application. Sampled and extrapolated, not the provider''s accounting. Written by database/transferUsage.js.';
