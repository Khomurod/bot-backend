/**
 * Migration 0028: the two repairs production had already switched on, sized
 * to what production actually wanted.
 *
 * The first background pass after 0027 deployed read, on /api/health,
 * `home_time.closable_open_cycle wanted 65 cap 50` and
 * `identity.stale_unit_assignment wanted 100 cap 50` — both rows pre-dated
 * the seed, enabled at the schema default, so 0027's ON CONFLICT DO NOTHING
 * left them and the cap stopped both batches. The counts are exactly the
 * measurements, so the cap moves to exactly them. The assertions that matter
 * are the negative ones: a cap a person typed is not touched, a disabled
 * check is not touched, a missing row is not created.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

// Every migration that SEEDS a check-settings row is excluded, so these tests
// reason about the rows they create rather than about whatever the current
// seed set happens to be. 0030 switches on the automatic return-to-road check.
const SEEDS_CHECK_SETTINGS = ['0027_', '0028_', '0030_'];
const BEFORE_0027 = allMigrationsSql((name) => !SEEDS_CHECK_SETTINGS.some((p) => name.startsWith(p)));
const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', name), 'utf8');
const MIGRATION_0027 = read('0027_production_repair_permissions_and_legacy_providers.sql');
const MIGRATION_0028 = read('0028_measured_caps_for_enabled_repairs.sql');

async function rows(harness) {
  const res = await harness.query(
    'SELECT check_key, auto_apply_enabled, max_auto_per_run, updated_by FROM operational_check_settings ORDER BY check_key'
  );
  return Object.fromEntries(res.rows.map((r) => [r.check_key, r]));
}

/** Production's shape before deploy: two checks switched on by a person at the default cap. */
async function seedProductionRows(harness, updatedAt = '2026-09-01T00:00:00Z') {
  await harness.query(
    `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, updated_by, updated_at)
     VALUES ('home_time.closable_open_cycle', TRUE, 'admin:1', $1),
            ('identity.stale_unit_assignment', TRUE, 'admin:1', $1)`,
    [updatedAt]
  );
}

test('production\'s shape: enabled at the default 50 → exactly 65 and exactly 100', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: BEFORE_0027 });
  await seedProductionRows(harness);
  await harness.query(MIGRATION_0027);
  let r = await rows(harness);
  assert.equal(r['home_time.closable_open_cycle'].max_auto_per_run, 50, '0027 leaves an existing row alone — this is the production state');
  assert.equal(r['identity.stale_unit_assignment'].max_auto_per_run, 50);

  await harness.query(MIGRATION_0028);
  r = await rows(harness);
  assert.equal(r['home_time.closable_open_cycle'].max_auto_per_run, 65, 'the measured 65, not "more"');
  assert.equal(r['identity.stale_unit_assignment'].max_auto_per_run, 100, 'the measured 100');
  assert.match(r['home_time.closable_open_cycle'].updated_by, /migration 0028/);
  assert.equal(r['identity.group_without_person'].max_auto_per_run, 150, '0027\'s own seed is not this migration\'s business');
});

test('a cap a person typed is theirs', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: BEFORE_0027 });
  await harness.query(
    `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, max_auto_per_run, updated_by)
     VALUES ('home_time.closable_open_cycle', TRUE, 10, 'admin:2'),
            ('identity.stale_unit_assignment', TRUE, 200, 'admin:2')`
  );
  await harness.query(MIGRATION_0027);
  await harness.query(MIGRATION_0028);
  const r = await rows(harness);
  assert.equal(r['home_time.closable_open_cycle'].max_auto_per_run, 10);
  assert.equal(r['identity.stale_unit_assignment'].max_auto_per_run, 200);
  assert.equal(r['home_time.closable_open_cycle'].updated_by, 'admin:2');
});

test('a 50 saved AFTER the measurement was published is a person\'s choice and stays', { skip: skipWithoutPg() }, async (t) => {
  // The Automation tab submits the displayed cap on every toggle, so a stored
  // 50 can be a decision. The value alone cannot tell; the time can: a row
  // saved before the measurement existed cannot have been sized to it, and
  // one saved after this instruction (2026-09-10) is kept exactly as saved.
  const harness = await createPgHarness(t, { extraDdl: BEFORE_0027 });
  await seedProductionRows(harness, '2026-09-10T20:00:00Z');
  await harness.query(MIGRATION_0027);
  await harness.query(MIGRATION_0028);
  const r = await rows(harness);
  assert.equal(r['home_time.closable_open_cycle'].max_auto_per_run, 50);
  assert.equal(r['identity.stale_unit_assignment'].max_auto_per_run, 50);
  assert.equal(r['home_time.closable_open_cycle'].updated_by, 'admin:1');
});

test('a disabled check is not touched, and a missing row is not created', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: BEFORE_0027 });
  await harness.query(
    `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, updated_by)
     VALUES ('home_time.closable_open_cycle', FALSE, 'admin:3')`
  );
  await harness.query(MIGRATION_0028); // without 0027: the other two rows do not exist
  const r = await rows(harness);
  assert.equal(r['home_time.closable_open_cycle'].max_auto_per_run, 50, 'off means off — and its cap is not pre-arranged');
  assert.equal(r['home_time.closable_open_cycle'].auto_apply_enabled, false);
  assert.equal(Object.keys(r).length, 1, 'nothing is created');
});

test('a fresh database keeps 0027\'s seed and 0028 is a no-op, twice', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: allMigrationsSql() });
  await harness.query(MIGRATION_0028);
  const r = await rows(harness);
  assert.equal(r['home_time.closable_open_cycle'].max_auto_per_run, 65);
  assert.equal(r['identity.stale_unit_assignment'].max_auto_per_run, 150, 'a fresh fleet keeps the seeded headroom');
  assert.equal(r['home_time.returned_to_road'].max_auto_per_run, 25, 'and 0030 keeps its own');
  assert.match(r['identity.stale_unit_assignment'].updated_by, /migration 0027/);
});
