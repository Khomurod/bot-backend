/**
 * A driver chat seen for the first time gets its starting profile at once
 * (`ensureDefaultProfileForGroup`), read from its title — and a profile that
 * exists is never touched. Six new chats on 5 November 2026 had no profile, so
 * no truck, until somebody opened Driver Groups.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { driverProfiles } = harness.loadDataLayer(['driverProfiles']);
  const insert = async (tg, name, type = 'driver') => (await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES ($1, $2, $3, TRUE) RETURNING *`,
    [tg, name, type]
  )).rows[0];
  return { harness, driverProfiles, insert };
}

test('a new driver chat gets its profile from the title, once', { skip: skipWithoutPg() }, async (t) => {
  const { harness, driverProfiles, insert } = await setup(t);
  const g = await insert('-2001', 'WENZE UNIT # 016 ZAKY GEBREYESUS ( COMPANY DRIVER)');
  assert.equal(await driverProfiles.ensureDefaultProfileForGroup(g), true);
  const row = (await harness.query('SELECT unit_number, driver_type, first_name FROM driver_profiles WHERE group_id = $1', [g.id])).rows[0];
  assert.equal(row.unit_number, '016');
  assert.equal(row.driver_type, 'company_driver');
  assert.equal(await driverProfiles.ensureDefaultProfileForGroup(g), false, 'a second call does nothing');
  const n = (await harness.query('SELECT COUNT(*)::int AS n FROM driver_profiles WHERE group_id = $1', [g.id])).rows[0].n;
  assert.equal(n, 1);
});

test('an existing profile is never overwritten, and a non-driver chat gets none', { skip: skipWithoutPg() }, async (t) => {
  const { harness, driverProfiles, insert } = await setup(t);
  const g = await insert('-2002', 'WENZE UNIT # 717 SANAT ISMAILOV');
  await harness.query(`INSERT INTO driver_profiles (group_id, unit_number, driver_type) VALUES ($1, '999', 'lease')`, [g.id]);
  assert.equal(await driverProfiles.ensureDefaultProfileForGroup(g), false);
  const row = (await harness.query('SELECT unit_number, driver_type FROM driver_profiles WHERE group_id = $1', [g.id])).rows[0];
  assert.deepEqual(row, { unit_number: '999', driver_type: 'lease' });

  const office = await insert('-2003', 'Wenze Office', 'general');
  assert.equal(await driverProfiles.ensureDefaultProfileForGroup(office), false);
  const none = (await harness.query('SELECT COUNT(*)::int AS n FROM driver_profiles WHERE group_id = $1', [office.id])).rows[0].n;
  assert.equal(none, 0);
});
