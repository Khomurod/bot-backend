/**
 * A status a PERSON set is not the AI's to change.
 *
 * Settings → Driver Profiles is where an administrator changes a driver's
 * status, through `updateDriverProfile`. That save has to mark the group's
 * status `manual`, and `getDriverGroupsForStatusAi` has to leave a manual
 * status out, or the next classification pass reads the chat title again and
 * puts back what the person just changed.
 *
 * Until October 2026 this was held by a source-text test on
 * `setGroupStatusByAdmin`, a writer for the old Driver Groups API that nothing
 * had called since that API was removed. This holds the path that runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = harness.loadDataLayer(['driverProfiles', 'groups']);
  return { harness, profiles: layer.driverProfiles, groups: layer.groups };
}

async function driverGroup(harness, profiles, { telegramId, name }) {
  const g = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active, status_source)
     VALUES ($1, $2, 'driver', TRUE, 'ai') RETURNING id`,
    [telegramId, name]
  );
  const groupId = g.rows[0].id;
  const profile = await profiles.upsertDriverProfileByGroupId({
    group_id: groupId, first_name: 'Test', last_name: name, status: 'active',
  });
  return { groupId, profileId: profile.id };
}

test('a status changed in the profile is manual, and the AI pass no longer sees it',
  { skip: skipWithoutPg() }, async (t) => {
    const { harness, profiles, groups } = await setup(t);
    const edited = await driverGroup(harness, profiles, { telegramId: '-1001', name: 'EDITED' });
    const untouched = await driverGroup(harness, profiles, { telegramId: '-1002', name: 'UNTOUCHED' });

    await profiles.updateDriverProfile(edited.profileId, { status: 'inactive' });

    const row = (await harness.query(
      'SELECT active, status_source FROM groups WHERE id = $1', [edited.groupId]
    )).rows[0];
    assert.equal(row.active, false, 'the group follows the profile');
    assert.equal(row.status_source, 'manual', 'and is marked as a person\'s decision');

    const candidates = (await groups.getDriverGroupsForStatusAi()).map((g) => g.id);
    assert.ok(!candidates.includes(edited.groupId), 'the AI pass leaves a manual status alone');
    assert.ok(candidates.includes(untouched.groupId),
      'while a status the AI set stays its to revisit, so the filter is not simply empty');
  });

test('a profile save that does not touch the status leaves its source alone',
  { skip: skipWithoutPg() }, async (t) => {
    const { harness, profiles } = await setup(t);
    const g = await driverGroup(harness, profiles, { telegramId: '-1003', name: 'RENAMED' });

    await profiles.updateDriverProfile(g.profileId, { last_name: 'RENAMED AGAIN' });

    const row = (await harness.query(
      'SELECT status_source FROM groups WHERE id = $1', [g.groupId]
    )).rows[0];
    assert.equal(row.status_source, 'ai', 'only a status change is a person taking the status over');
  });
