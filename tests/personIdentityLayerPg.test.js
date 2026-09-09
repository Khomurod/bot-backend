/**
 * Migration 0015 — the person identity layer, against a real PostgreSQL.
 *
 * The partial unique indexes are the substance of this migration, so they are
 * what these tests are about. "One truck, one driver at a time" has to be
 * something the DATABASE refuses, not a convention the application remembers —
 * production already holds ten units on multiple active groups precisely because
 * nothing refused.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const PRIOR = allMigrationsSql((name) => name < '0015');
const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '..', 'database', 'migrations', '0015_person_identity_layer.sql'),
  'utf8'
);

async function harnessWithLayer(t) {
  return createPgHarness(t, { extraDdl: `${PRIOR}\n${MIGRATION}` });
}

async function makeGroup(harness, telegramId, name) {
  const res = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active)
     VALUES ($1, $2, 'driver', TRUE) RETURNING id`,
    [telegramId, name]
  );
  return res.rows[0].id;
}

async function makePerson(harness, displayName, normalizedKey = null) {
  const res = await harness.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ($1, $2) RETURNING id`,
    [displayName, normalizedKey]
  );
  return res.rows[0].id;
}

test('the migration applies to the baseline and re-applies as a no-op', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  await harness.query(MIGRATION); // second boot

  const tables = await harness.query(
    `SELECT tablename FROM pg_tables
      WHERE tablename IN ('driver_people','driver_person_groups','driver_units') ORDER BY 1`
  );
  assert.deepEqual(tables.rows.map((r) => r.tablename),
    ['driver_people', 'driver_person_groups', 'driver_units']);
});

test('a normalized name is NOT unique — two people may share one', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  // A UNIQUE key here is the mileage_bonus_progress bug: two humans whose names
  // normalize alike would collapse into one and one would stop being paid.
  await makePerson(harness, 'OMAR ALAWAD', 'alawadomar');
  await makePerson(harness, 'OMAR ALAWAD', 'alawadomar');
  const n = await harness.query('SELECT COUNT(*)::int AS n FROM driver_people');
  assert.equal(n.rows[0].n, 2);
});

test('a chat belongs to one person at a time, but its history is unbounded', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  const groupId = await makeGroup(harness, -1001, 'WENZE UNIT # 5 A');
  const first = await makePerson(harness, 'FIRST DRIVER');
  const second = await makePerson(harness, 'SECOND DRIVER');

  await harness.query(
    `INSERT INTO driver_person_groups (person_id, group_id, association_source) VALUES ($1,$2,'backfill')`,
    [first, groupId]
  );

  await assert.rejects(
    () => harness.query(
      `INSERT INTO driver_person_groups (person_id, group_id, association_source) VALUES ($1,$2,'backfill')`,
      [second, groupId]
    ),
    /uniq_driver_person_groups_open_group/,
    'two people cannot hold the same chat at once'
  );

  // Close the first and the chat is free — this is the handover, recorded.
  await harness.query(
    'UPDATE driver_person_groups SET ended_at = NOW() WHERE group_id = $1 AND ended_at IS NULL',
    [groupId]
  );
  await harness.query(
    `INSERT INTO driver_person_groups (person_id, group_id, association_source) VALUES ($1,$2,'manual')`,
    [second, groupId]
  );
  const rows = await harness.query('SELECT COUNT(*)::int AS n FROM driver_person_groups WHERE group_id = $1', [groupId]);
  assert.equal(rows.rows[0].n, 2, 'both occupants stay on record');
});

test('one truck, one driver at a time — the constraint production never had', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  const a = await makePerson(harness, 'DRIVER A');
  const b = await makePerson(harness, 'DRIVER B');

  await harness.query(
    `INSERT INTO driver_units (person_id, unit_number, source) VALUES ($1,'001','group_title')`, [a]
  );
  await assert.rejects(
    () => harness.query(
      `INSERT INTO driver_units (person_id, unit_number, source) VALUES ($1,'001','group_title')`, [b]
    ),
    /uniq_driver_units_open_unit/,
    "unit '001' on four active drivers must be unrepresentable"
  );
});

test('one driver, one truck at a time', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  const a = await makePerson(harness, 'DRIVER A');
  await harness.query(`INSERT INTO driver_units (person_id, unit_number, source) VALUES ($1,'310','group_title')`, [a]);
  await assert.rejects(
    () => harness.query(`INSERT INTO driver_units (person_id, unit_number, source) VALUES ($1,'322','group_title')`, [a]),
    /uniq_driver_units_open_person/
  );
});

test("'001', '01' and '1' are three different trucks", { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  for (const [i, unit] of ['001', '01', '1'].entries()) {
    const p = await makePerson(harness, `DRIVER ${i}`);
    await harness.query(`INSERT INTO driver_units (person_id, unit_number, source) VALUES ($1,$2,'group_title')`, [p, unit]);
  }
  const n = await harness.query('SELECT COUNT(*)::int AS n FROM driver_units WHERE ended_at IS NULL');
  assert.equal(n.rows[0].n, 3);
});

test('a truck changes hands by closing the old assignment', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  const a = await makePerson(harness, 'DRIVER A');
  const b = await makePerson(harness, 'DRIVER B');
  await harness.query(`INSERT INTO driver_units (person_id, unit_number, source) VALUES ($1,'27','group_title')`, [a]);
  await harness.query(`UPDATE driver_units SET ended_at = NOW() WHERE person_id = $1 AND ended_at IS NULL`, [a]);
  await harness.query(`INSERT INTO driver_units (person_id, unit_number, source) VALUES ($1,'27','manual')`, [b]);

  const history = await harness.query('SELECT COUNT(*)::int AS n FROM driver_units WHERE unit_number = $1', ['27']);
  assert.equal(history.rows[0].n, 2, 'the previous driver of unit 27 is still recorded');
});

test('a merge is a pointer, and it is reversible', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  const groupId = await makeGroup(harness, -1002, 'WENZE UNIT # 9 A');
  const keep = await makePerson(harness, 'CANONICAL');
  const dupe = await makePerson(harness, 'DUPLICATE');
  await harness.query(
    `INSERT INTO driver_person_groups (person_id, group_id, association_source) VALUES ($1,$2,'backfill')`,
    [dupe, groupId]
  );

  await harness.query('UPDATE driver_people SET merged_into_person_id = $2 WHERE id = $1', [dupe, keep]);
  const still = await harness.query('SELECT COUNT(*)::int AS n FROM driver_person_groups WHERE person_id = $1', [dupe]);
  assert.equal(still.rows[0].n, 1, 'a merge deletes nothing');

  await harness.query('UPDATE driver_people SET merged_into_person_id = NULL WHERE id = $1', [dupe]);
  const back = await harness.query('SELECT merged_into_person_id FROM driver_people WHERE id = $1', [dupe]);
  assert.equal(back.rows[0].merged_into_person_id, null);
});

test('a person cannot be merged into themselves', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  const p = await makePerson(harness, 'SELF');
  await assert.rejects(
    () => harness.query('UPDATE driver_people SET merged_into_person_id = $1 WHERE id = $1', [p]),
    /driver_people_no_self_merge/
  );
});

test('deleting a group takes its association, never the person', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  const groupId = await makeGroup(harness, -1003, 'WENZE UNIT # 3 A');
  const p = await makePerson(harness, 'SURVIVOR');
  await harness.query(
    `INSERT INTO driver_person_groups (person_id, group_id, association_source) VALUES ($1,$2,'backfill')`,
    [p, groupId]
  );

  await harness.query('DELETE FROM groups WHERE id = $1', [groupId]);

  const person = await harness.query('SELECT COUNT(*)::int AS n FROM driver_people WHERE id = $1', [p]);
  const assoc = await harness.query('SELECT COUNT(*)::int AS n FROM driver_person_groups WHERE person_id = $1', [p]);
  assert.equal(person.rows[0].n, 1, 'the human outlives the chat');
  assert.equal(assoc.rows[0].n, 0);
});

test('an association cannot end before it started', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  const groupId = await makeGroup(harness, -1004, 'WENZE UNIT # 4 A');
  const p = await makePerson(harness, 'A');
  await assert.rejects(
    () => harness.query(
      `INSERT INTO driver_person_groups (person_id, group_id, association_source, started_at, ended_at)
       VALUES ($1,$2,'backfill', NOW(), NOW() - INTERVAL '1 day')`,
      [p, groupId]
    ),
    /driver_person_groups_ends_after_start/
  );
});

test('a blank unit number is refused', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithLayer(t);
  const p = await makePerson(harness, 'A');
  await assert.rejects(
    () => harness.query(`INSERT INTO driver_units (person_id, unit_number, source) VALUES ($1,'   ','group_title')`, [p]),
    /driver_units_unit_not_blank/
  );
});
