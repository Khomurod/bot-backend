/**
 * Migration 0009 against a REAL PostgreSQL, on the real baseline schema.
 *
 * What only a database can prove: that the migration applies on top of the
 * accumulated schema, that re-applying it is a no-op (every boot re-runs the
 * baseline, and a retry must not fail), that the single-row constraint really
 * is enforced, and that the column checks refuse what the application must
 * never store.
 *
 * Needs TEST_DATABASE_URL and SKIPS without it. A skipped test is not a
 * passing test (CLAUDE.md); CI fails on any skip.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const MIGRATION_PATH = path.join(__dirname, '..', 'database', 'migrations', '0009_bitrix_settings.sql');
const MIGRATION = fs.readFileSync(MIGRATION_PATH, 'utf8');

test('the migration creates the settings table with its seed row', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t, { extraDdl: MIGRATION });
  const cols = await harness.query(
    `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bitrix_settings'`
  );
  const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
  for (const column of [
    'enabled', 'webhook_url_encrypted', 'entity', 'assigned_by_id', 'source_id',
    'source_description', 'deal_category_id', 'deal_stage_id', 'assignee_wait_ms',
  ]) {
    assert.ok(byName.has(column), `missing column ${column}`);
    assert.equal(byName.get(column).is_nullable, 'YES', `${column} must be nullable — NULL means "inherit env"`);
  }
  assert.equal(byName.get('assigned_by_id').data_type, 'text', "TEXT so '' can mean explicitly nobody");

  const rows = await harness.query('SELECT id FROM bitrix_settings');
  assert.deepEqual(rows.rows, [{ id: 1 }], 'exactly the seed row');
});

test('applying it twice changes nothing — every boot re-runs the baseline', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t, { extraDdl: MIGRATION });
  await harness.query("UPDATE bitrix_settings SET entity = 'deal', assigned_by_id = '17' WHERE id = 1");
  await harness.query(MIGRATION);
  const row = (await harness.query('SELECT entity, assigned_by_id FROM bitrix_settings WHERE id = 1')).rows[0];
  assert.deepEqual(row, { entity: 'deal', assigned_by_id: '17' }, 'the re-run did not reset a saved value');
  assert.equal((await harness.query('SELECT count(*)::int AS n FROM bitrix_settings')).rows[0].n, 1);
});

test('there can only ever be the one row', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t, { extraDdl: MIGRATION });
  await assert.rejects(
    () => harness.query('INSERT INTO bitrix_settings (id) VALUES (2)'),
    (err) => err.code === '23514',
    'a second row is a check-constraint violation',
  );
});

test('the database refuses an entity that is neither lead nor deal, and a negative wait', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t, { extraDdl: MIGRATION });
  await assert.rejects(
    () => harness.query("UPDATE bitrix_settings SET entity = 'contact' WHERE id = 1"),
    (err) => err.code === '23514',
  );
  await assert.rejects(
    () => harness.query('UPDATE bitrix_settings SET assignee_wait_ms = -5 WHERE id = 1'),
    (err) => err.code === '23514',
  );
  // …while the values the app writes are all accepted, '' for "explicitly nobody" included.
  await harness.query(
    `UPDATE bitrix_settings
        SET enabled = TRUE, entity = 'lead', assigned_by_id = '', source_id = 'WEB',
            assignee_wait_ms = 0, webhook_url_encrypted = 'iv.tag.ciphertext'
      WHERE id = 1`
  );
  const row = (await harness.query('SELECT assigned_by_id, assignee_wait_ms FROM bitrix_settings WHERE id = 1')).rows[0];
  assert.deepEqual(row, { assigned_by_id: '', assignee_wait_ms: 0 });
});
