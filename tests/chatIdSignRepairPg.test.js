/**
 * Migration 0014 — repairing a Telegram chat id that lost its minus sign.
 *
 * The rule it must honour is narrow on purpose: rewrite a stored id ONLY when
 * the negated value is a group this database already holds. That is decided from
 * recorded data, not inferred. A positive id matching no known group is left
 * alone — it may be a reachable chat that was simply never captured, and giving
 * it a sign would be inventing a fact.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

// 0014 rewrites message_group_settings.raise_results_group_id, a column migration
// 0006 adds. A real boot applies the baseline and then every migration in order,
// so the harness has to as well — the baseline alone is not the schema 0014 runs
// against.
const PRIOR_MIGRATIONS = allMigrationsSql((name) => name < '0014');

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '..', 'database', 'migrations', '0014_repair_sign_dropped_chat_ids.sql'),
  'utf8'
);

const HR_ID = -5052301861;

async function seedGroup(harness) {
  await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active)
     VALUES ($1, 'HR Personnel', 'driver', TRUE)`,
    [HR_ID]
  );
}

async function setHomeTime(harness, internal, completed) {
  await harness.query(
    `INSERT INTO home_time_settings (id, internal_clarification_group_id, completed_notify_group_id)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE
       SET internal_clarification_group_id = EXCLUDED.internal_clarification_group_id,
           completed_notify_group_id = EXCLUDED.completed_notify_group_id`,
    [internal, completed]
  );
}

async function homeTimeIds(harness) {
  const res = await harness.query(
    'SELECT internal_clarification_group_id AS internal, completed_notify_group_id AS completed'
    + ' FROM home_time_settings WHERE id = 1'
  );
  return res.rows[0];
}

test('the production value is repaired to the group it meant', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: PRIOR_MIGRATIONS });
  await seedGroup(harness);
  await setHomeTime(harness, '5052301861', '5052301861');

  await harness.query(MIGRATION);

  const row = await homeTimeIds(harness);
  assert.equal(row.internal, String(HR_ID));
  assert.equal(row.completed, String(HR_ID));
});

test('re-running it changes nothing', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: PRIOR_MIGRATIONS });
  await seedGroup(harness);
  await setHomeTime(harness, '5052301861', null);

  await harness.query(MIGRATION);
  const once = await homeTimeIds(harness);
  await harness.query(MIGRATION);
  const twice = await homeTimeIds(harness);

  assert.equal(once.internal, String(HR_ID));
  assert.deepEqual(twice, once, 'a second apply must be a no-op, not a second minus sign');
});

test('a positive id matching no known group is left exactly as it was', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: PRIOR_MIGRATIONS });
  await seedGroup(harness);
  await setHomeTime(harness, '999888777', null);

  await harness.query(MIGRATION);

  const row = await homeTimeIds(harness);
  assert.equal(row.internal, '999888777', 'the migration must not invent a sign it cannot justify');
});

test('an already-correct negative id is untouched', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: PRIOR_MIGRATIONS });
  await seedGroup(harness);
  await setHomeTime(harness, String(HR_ID), null);

  await harness.query(MIGRATION);

  assert.equal((await homeTimeIds(harness)).internal, String(HR_ID));
});

test('a NULL destination stays NULL', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: PRIOR_MIGRATIONS });
  await seedGroup(harness);
  await setHomeTime(harness, null, null);

  await harness.query(MIGRATION);

  const row = await homeTimeIds(harness);
  assert.equal(row.internal, null);
  assert.equal(row.completed, null);
});

test('the same rule covers every message_group_settings destination', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: PRIOR_MIGRATIONS });
  await seedGroup(harness);
  await harness.query(
    `INSERT INTO message_group_settings
       (id, mileage_bonus_group_id, road_bonus_group_id, dispatch_review_group_id, raise_results_group_id)
     VALUES (1, '5052301861', '5052301861', '5052301861', '424242')
     ON CONFLICT (id) DO UPDATE SET
       mileage_bonus_group_id = EXCLUDED.mileage_bonus_group_id,
       road_bonus_group_id = EXCLUDED.road_bonus_group_id,
       dispatch_review_group_id = EXCLUDED.dispatch_review_group_id,
       raise_results_group_id = EXCLUDED.raise_results_group_id`
  );

  await harness.query(MIGRATION);

  const row = (await harness.query(
    `SELECT mileage_bonus_group_id AS mileage, road_bonus_group_id AS road,
            dispatch_review_group_id AS dispatch, raise_results_group_id AS raise
       FROM message_group_settings WHERE id = 1`
  )).rows[0];

  assert.equal(row.mileage, String(HR_ID));
  assert.equal(row.road, String(HR_ID));
  assert.equal(row.dispatch, String(HR_ID));
  assert.equal(row.raise, '424242', 'no matching group means no change');
});
