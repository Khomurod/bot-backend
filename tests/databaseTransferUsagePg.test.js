/**
 * The transfer-usage row, against a real PostgreSQL.
 *
 * What matters here is that the month's estimate SURVIVES A RESTART — Render
 * restarts this app routinely, and a meter that resets to 0% every time would
 * have warned about nothing during the very incident it exists to prevent. That
 * means the UPSERT has to accumulate rather than overwrite, and the boot-time
 * read has to find its own month.
 *
 * Migration 0007 creates the table; it is applied here as extra DDL, so this
 * also proves that file is valid SQL against the real schema.
 *
 * Requires TEST_DATABASE_URL (CI provides a Postgres 16 service container).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'database', 'migrations', '0007_database_transfer_usage.sql'),
  'utf8',
);

/** The meter and its persistence, bound to the throwaway database. */
function loadUsage(harness) {
  const { transferUsage, transferMeter } = harness.loadDataLayer(['transferUsage', 'transferMeter']);
  transferMeter.reset();
  return { transferUsage, transferMeter };
}

test('usage accumulates across flushes and survives a restart', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t, { extraDdl: MIGRATION });
  const { transferUsage, transferMeter } = loadUsage(harness);

  // A first stretch of traffic, flushed.
  transferMeter.recordQuery({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
  const first = await transferUsage.flushUsage();
  assert.equal(first.written, true);

  // A second stretch: the row must ADD, not replace — this is what makes the
  // monthly total meaningful.
  transferMeter.recordQuery({ rows: [{ id: 3 }], rowCount: 1 });
  const second = await transferUsage.flushUsage();
  assert.equal(second.written, true);

  const stored = await harness.query(
    'SELECT month_key, bytes_estimated, queries, rows_read FROM database_transfer_usage',
  );
  assert.equal(stored.rows.length, 1, 'one row per month, not one per flush');
  const row = stored.rows[0];
  assert.equal(row.month_key, transferMeter.currentMonthKey());
  // Both stretches landed in the one row: 2 recorded queries and their 3 rows.
  // (In production the flush's own UPSERT is metered too, because it goes
  // through database/pool.js; the harness binds a plain pool, so here the
  // counts are exactly what the test recorded.)
  assert.equal(Number(row.queries), 2, `expected both flushes to accumulate, got ${row.queries}`);
  assert.equal(Number(row.rows_read), 3, `expected 2 + 1 rows, got ${row.rows_read}`);
  assert.ok(Number(row.bytes_estimated) > 0);

  // The restart: a fresh meter reads the month back instead of reporting zero.
  transferMeter.reset();
  assert.equal(transferMeter.snapshot().bytes, 0);
  const loaded = await transferUsage.loadPersistedUsage();
  assert.equal(loaded.loaded, true);
  assert.ok(transferMeter.snapshot().bytes >= Number(row.bytes_estimated));
});

test('a flush with nothing pending writes nothing', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t, { extraDdl: MIGRATION });
  const { transferUsage } = loadUsage(harness);
  const result = await transferUsage.flushUsage();
  assert.equal(result.written, false);
  const stored = await harness.query('SELECT count(*)::int AS n FROM database_transfer_usage');
  assert.equal(stored.rows[0].n, 0);
});

test('a month with no stored row reports not-loaded rather than failing', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t, { extraDdl: MIGRATION });
  const { transferUsage } = loadUsage(harness);
  const loaded = await transferUsage.loadPersistedUsage();
  assert.equal(loaded.loaded, false);
  assert.equal(loaded.error, undefined, 'an empty table is not an error');
});

test('the migration is idempotent, as every migration in this repo must be', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t, { extraDdl: MIGRATION });
  // Applying it a second time must be a no-op, not a duplicate-table error.
  await harness.query(MIGRATION);
  const columns = await harness.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'database_transfer_usage' ORDER BY column_name`,
  );
  assert.deepEqual(
    columns.rows.map((r) => r.column_name),
    ['bytes_estimated', 'month_key', 'queries', 'rows_read', 'updated_at'],
  );
});
