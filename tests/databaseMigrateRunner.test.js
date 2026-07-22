/**
 * PostgreSQL integration — the forward-migration runner (database/migrate/).
 *
 * Proves the ledger + apply loop behave correctly against a REAL database:
 * run-once semantics, ordering, atomic rollback, no-transaction mode, checksum
 * drift, and baseline sentinel recording. Uses a bare throwaway database
 * (applySchema:false) so migrations are exercised in isolation.
 *
 * Requires TEST_DATABASE_URL; SKIPs without it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');
const { runMigrations } = require('../database/migrate/runner');
const { loadMigrations } = require('../database/migrate/loader');
const ledger = require('../database/migrate/ledger');
const { checksum } = require('../database/migrate/checksum');

/** A silent logger so test output stays clean; captures warnings for asserts. */
function captureLogger() {
  const warnings = [];
  const logs = [];
  return {
    warnings,
    logs,
    log: (m) => logs.push(m),
    warn: (m) => warnings.push(m),
    error: () => {},
  };
}

/** Make a temp migrations dir; register cleanup on the test context. */
function tempMigrationsDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-test-'));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql, 'utf8');
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('empty dir: ledger is created and baseline sentinel recorded', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t, { applySchema: false });
  const dir = tempMigrationsDir(t);
  const logger = captureLogger();

  const result = await runMigrations(harness.pool, {
    migrationsDir: dir, baselineChecksum: checksum('SELECT 1'), logger,
  });

  assert.deepEqual(result.applied, []);
  const tbl = await harness.query(
    "SELECT to_regclass('public.schema_migrations') AS t",
  );
  assert.ok(tbl.rows[0].t, 'schema_migrations table exists');
  const base = await harness.query(
    'SELECT kind FROM schema_migrations WHERE version = $1', [ledger.BASELINE_VERSION],
  );
  assert.equal(base.rows[0].kind, 'baseline');
});

test('a forward migration applies once and is skipped on re-run', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t, { applySchema: false });
  const dir = tempMigrationsDir(t, {
    '0001_make_widgets.sql':
      '-- migrate:kind: schema\nCREATE TABLE IF NOT EXISTS widgets (id SERIAL PRIMARY KEY, n INT);\n',
  });

  const first = await runMigrations(harness.pool, { migrationsDir: dir, logger: captureLogger() });
  assert.deepEqual(first.applied, ['0001']);
  const exists = await harness.query("SELECT to_regclass('public.widgets') AS t");
  assert.ok(exists.rows[0].t, 'widgets table created');

  const second = await runMigrations(harness.pool, { migrationsDir: dir, logger: captureLogger() });
  assert.deepEqual(second.applied, [], 're-run applies nothing');
  assert.deepEqual(second.skipped, ['0001']);

  const rows = await harness.query('SELECT COUNT(*)::int AS c FROM schema_migrations WHERE version=$1', ['0001']);
  assert.equal(rows.rows[0].c, 1, 'ledger has exactly one row for the migration');
});

test('migrations apply in ascending version order regardless of readdir order', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t, { applySchema: false });
  const dir = tempMigrationsDir(t, {
    // 0002 depends on the table 0001 creates: only correct order succeeds.
    '0002_seed_widgets.sql': "-- migrate:kind: seed\nINSERT INTO widgets (n) VALUES (42);\n",
    '0001_make_widgets.sql': 'CREATE TABLE widgets (id SERIAL PRIMARY KEY, n INT);\n',
  });

  const result = await runMigrations(harness.pool, { migrationsDir: dir, logger: captureLogger() });
  assert.deepEqual(result.applied, ['0001', '0002']);
  const n = await harness.query('SELECT n FROM widgets');
  assert.equal(n.rows[0].n, 42);
});

test('a failing migration rolls back atomically and is not recorded', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t, { applySchema: false });
  const dir = tempMigrationsDir(t, {
    // First statement is valid, second is a hard error → whole migration must roll back.
    '0001_partial_fail.sql':
      'CREATE TABLE keeps (id INT);\nINSERT INTO does_not_exist VALUES (1);\n',
  });

  await assert.rejects(
    () => runMigrations(harness.pool, { migrationsDir: dir, logger: captureLogger() }),
    /Migration "0001_partial_fail\.sql" failed/,
  );

  const leftover = await harness.query("SELECT to_regclass('public.keeps') AS t");
  assert.equal(leftover.rows[0].t, null, 'the valid statement was rolled back');
  const recorded = await harness.query('SELECT COUNT(*)::int AS c FROM schema_migrations WHERE version=$1', ['0001']);
  assert.equal(recorded.rows[0].c, 0, 'a failed migration is never recorded');
});

test('checksum drift on an applied migration warns but does not re-run', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t, { applySchema: false });
  const dir = tempMigrationsDir(t, {
    '0001_make_widgets.sql': 'CREATE TABLE widgets (id SERIAL PRIMARY KEY);\n',
  });
  await runMigrations(harness.pool, { migrationsDir: dir, logger: captureLogger() });

  // Edit the already-applied file to different (would-fail-if-rerun) content.
  fs.writeFileSync(path.join(dir, '0001_make_widgets.sql'),
    'CREATE TABLE widgets (id SERIAL PRIMARY KEY);\nDROP TABLE nonexistent;\n', 'utf8');

  const logger = captureLogger();
  const result = await runMigrations(harness.pool, { migrationsDir: dir, logger });
  assert.deepEqual(result.applied, [], 'drifted migration is not re-executed');
  assert.deepEqual(result.drift, ['0001']);
  assert.ok(logger.warnings.some((w) => /checksum drift/i.test(w)), 'a drift warning was logged');
});

test('a no-transaction migration applies and records', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t, { applySchema: false });
  const dir = tempMigrationsDir(t, {
    '0001_concurrent_index.sql':
      '-- migrate:no-transaction\nCREATE TABLE widgets (id SERIAL PRIMARY KEY, n INT);\n'
      + 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_widgets_n ON widgets(n);\n',
  });

  const parsed = loadMigrations(dir);
  assert.equal(parsed[0].noTransaction, true, 'directive parsed');

  const result = await runMigrations(harness.pool, { migrationsDir: dir, logger: captureLogger() });
  assert.deepEqual(result.applied, ['0001']);
  const idx = await harness.query("SELECT to_regclass('public.idx_widgets_n') AS t");
  assert.ok(idx.rows[0].t, 'concurrent index created');
});

test('baseline sentinel checksum refreshes across runs', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t, { applySchema: false });
  const dir = tempMigrationsDir(t);
  await runMigrations(harness.pool, { migrationsDir: dir, baselineChecksum: 'sha256:aaa', logger: captureLogger() });
  await runMigrations(harness.pool, { migrationsDir: dir, baselineChecksum: 'sha256:bbb', logger: captureLogger() });

  const rows = await harness.query(
    'SELECT COUNT(*)::int AS c, MAX(checksum) AS ck FROM schema_migrations WHERE version=$1',
    [ledger.BASELINE_VERSION],
  );
  assert.equal(rows.rows[0].c, 1, 'exactly one baseline sentinel row');
  assert.equal(rows.rows[0].ck, 'sha256:bbb', 'checksum updated in place');
});

test('loader rejects a malformed filename', async (t) => {
  const dir = tempMigrationsDir(t, { 'not-a-migration.sql': 'SELECT 1;\n' });
  assert.throws(() => loadMigrations(dir), /Invalid migration filename/);
});

test('loader rejects duplicate versions', async (t) => {
  const dir = tempMigrationsDir(t, {
    '0001_a.sql': 'SELECT 1;\n',
    '0001_b.sql': 'SELECT 1;\n',
  });
  assert.throws(() => loadMigrations(dir), /Duplicate migration version/);
});

test('loader returns [] for a missing directory', (t) => {
  const missing = path.join(os.tmpdir(), 'definitely-not-here-xyz', 'nope');
  assert.deepEqual(loadMigrations(missing), []);
});
