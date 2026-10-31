/**
 * What a driver-profile save writes to the group, read back from Postgres.
 *
 * The group keeps its own copies of the driver's language and birthday: the
 * bot reads `groups.language` to answer in the driver's language, and the
 * birthday cards read `groups.driver_birthday` (`getGroupsWithBirthdayToday`).
 * Since the old Driver Groups writers were removed (October 2026), a driver-
 * profile save (`syncGroupFromDriverProfile`) is the only code that changes
 * either once the group exists, so this reads the stored row rather than
 * trusting the statement that was sent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = harness.loadDataLayer(['driverProfiles', 'groups']);
  const g = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active)
     VALUES ('-1009', 'WENZE UNIT # 9 SYNC', 'driver', TRUE) RETURNING id`
  );
  const groupId = g.rows[0].id;
  const profile = await layer.driverProfiles.upsertDriverProfileByGroupId({
    group_id: groupId, first_name: 'Sync', last_name: 'Driver', status: 'active',
    language: 'en', date_of_birth: '1990-04-01',
  });
  const stored = async () => (await harness.query(
    "SELECT language, to_char(driver_birthday, 'YYYY-MM-DD') AS birthday FROM groups WHERE id = $1",
    [groupId]
  )).rows[0];
  return { ...layer, groupId, profileId: profile.id, stored };
}

test('a profile save carries the language and the birthday to the group',
  { skip: skipWithoutPg() }, async (t) => {
    const { driverProfiles, groups, groupId, profileId, stored } = await setup(t);
    assert.deepEqual(await stored(), { language: 'en', birthday: '1990-04-01' }, 'the first save');

    await driverProfiles.updateDriverProfile(profileId, { language: 'uz' });
    assert.deepEqual(await stored(), { language: 'uz', birthday: '1990-04-01' },
      'a language change keeps the birthday');

    const cards = (await groups.getGroupsWithBirthdayToday(4, 1)).map((r) => r.id);
    assert.ok(cards.includes(groupId), 'the birthday cards find the driver on the day');
  });

test('clearing the birthday on the profile clears the group\'s copy',
  { skip: skipWithoutPg() }, async (t) => {
    const { driverProfiles, groups, groupId, profileId, stored } = await setup(t);

    await driverProfiles.updateDriverProfile(profileId, { date_of_birth: null });
    assert.deepEqual(await stored(), { language: 'en', birthday: null },
      'NULL is written, not skipped, so an old birthday cannot linger');

    const cards = (await groups.getGroupsWithBirthdayToday(4, 1)).map((r) => r.id);
    assert.ok(!cards.includes(groupId), 'and no card goes out for a birthday that was removed');
  });
