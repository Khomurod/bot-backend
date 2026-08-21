/**
 * Message-group routing — PostgreSQL integration tests for the driver-raise
 * split into TWO independent Telegram destinations.
 *
 * Migration 0006 adds `message_group_settings.raise_results_group_id`. What has
 * to be true on a real database, against the real baseline schema:
 *
 *   - the migration applies idempotently (it re-runs safely if a boot dies
 *     mid-way), and is purely additive;
 *   - a deployment that already had a dispatch_review_group_id keeps it — the
 *     review request goes on working straight through the deploy;
 *   - the new column is NOT seeded from the dispatch value. Copying it would
 *     keep posting pay decisions to the dispatch group, which is the behavior
 *     this split removes;
 *   - the real messageRoutingSettings module reads and writes the two columns
 *     independently (a column-name typo between the module and the migration
 *     would silently route to the wrong group, or to nowhere).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const MIGRATION_0006 = fs.readFileSync(
  path.resolve(__dirname, '../database/migrations', '0006_raise_results_group.sql'),
  'utf8',
);

/** Column metadata for message_group_settings, keyed by column name. */
async function columns(harness) {
  const res = await harness.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'message_group_settings'`,
  );
  return new Map(res.rows.map((r) => [r.column_name, r]));
}

test('migration 0006 applies twice and adds a nullable text column', { skip: skipWithoutPg(), timeout: 60000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);

  const before = await columns(harness);
  assert.ok(before.has('dispatch_review_group_id'), 'the baseline has the request column');
  assert.equal(before.has('raise_results_group_id'), false, 'the results column is new');

  await harness.query(MIGRATION_0006);
  await harness.query(MIGRATION_0006); // idempotency: a re-run must be a no-op

  const after = await columns(harness);
  const col = after.get('raise_results_group_id');
  assert.ok(col, 'raise_results_group_id exists');
  assert.equal(col.data_type, 'text', 'a Telegram id here is text, like its siblings');
  assert.equal(col.is_nullable, 'YES', 'nullable = "not configured"');
  assert.equal(col.column_default, null, 'deliberately no hardcoded group-id default');

  // Purely additive: every pre-existing column survived unchanged.
  for (const [name, spec] of before) {
    assert.deepEqual(after.get(name), spec, `${name} was not altered`);
  }
});

test('an existing dispatch group survives the migration and is NOT copied to accounting', { skip: skipWithoutPg(), timeout: 60000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);

  // A deployment as it looks today: one shared group doing both jobs.
  await harness.query(
    `UPDATE message_group_settings
        SET dispatch_review_group_id = '-1001111111111',
            mileage_bonus_group_id   = '-1002222222222'
      WHERE id = 1`,
  );

  await harness.query(MIGRATION_0006);

  const row = (await harness.query('SELECT * FROM message_group_settings WHERE id = 1')).rows[0];
  // The review request keeps working through the deploy…
  assert.equal(row.dispatch_review_group_id, '-1001111111111');
  assert.equal(row.mileage_bonus_group_id, '-1002222222222');
  // …and the results destination starts unconfigured, on purpose.
  assert.equal(row.raise_results_group_id, null,
    'the dispatch group must not be silently reused as the accounting group');
});

test('the baseline schema still applies on top of the migration (boot order)', { skip: skipWithoutPg(), timeout: 90000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  await harness.query(MIGRATION_0006);
  await harness.query(
    "UPDATE message_group_settings SET raise_results_group_id = '-1003333333333' WHERE id = 1",
  );

  // Production re-applies the whole baseline on EVERY boot, after this migration
  // has been recorded. That must neither drop the column nor reset its value.
  await harness.applyDepartmentSchema();

  const row = (await harness.query('SELECT * FROM message_group_settings WHERE id = 1')).rows[0];
  assert.equal(row.raise_results_group_id, '-1003333333333');
});

test('the real routing module reads and writes the two raise columns independently', { skip: skipWithoutPg(), timeout: 60000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  await harness.query(MIGRATION_0006);

  const { messageRoutingSettings: routing } = harness.loadDataLayer(['messageRoutingSettings']);

  // Nothing configured yet: no hidden default, no cross-category fallback.
  assert.equal(await routing.getGroupId('dispatchReview'), null);
  assert.equal(await routing.getGroupId('raiseResults'), null);

  // Configure ONLY the dispatch request group.
  await routing.updateMessageGroupSettings({ dispatchReview: '-1001111111111' });
  assert.equal(await routing.getGroupId('dispatchReview'), '-1001111111111');
  assert.equal(await routing.getGroupId('raiseResults'), null,
    'a configured request group is never a fallback for the results group');

  // Configure ONLY the accounting group: the request group is untouched.
  await routing.updateMessageGroupSettings({ raiseResults: '-1004444444444' });
  assert.equal(await routing.getGroupId('dispatchReview'), '-1001111111111');
  assert.equal(await routing.getGroupId('raiseResults'), '-1004444444444');

  // They really are two different columns on the row.
  const row = (await harness.query('SELECT * FROM message_group_settings WHERE id = 1')).rows[0];
  assert.equal(row.dispatch_review_group_id, '-1001111111111');
  assert.equal(row.raise_results_group_id, '-1004444444444');

  // Clearing one leaves the other alone.
  await routing.updateMessageGroupSettings({ raiseResults: '' });
  assert.equal(await routing.getGroupId('raiseResults'), null);
  assert.equal(await routing.getGroupId('dispatchReview'), '-1001111111111');

  // The same ID in both is allowed — an admin's deliberate choice.
  await routing.updateMessageGroupSettings({
    dispatchReview: '-1005555555555', raiseResults: '-1005555555555',
  });
  assert.equal(await routing.getGroupId('dispatchReview'), '-1005555555555');
  assert.equal(await routing.getGroupId('raiseResults'), '-1005555555555');

  const view = await routing.getMessageGroupSettingsForAdmin();
  assert.equal(view.dispatchReview.groupId, '-1005555555555');
  assert.equal(view.raiseResults.groupId, '-1005555555555');
  assert.equal(view.raiseResults.configured, true);
});
