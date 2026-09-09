/**
 * The person backfill, end to end against a real PostgreSQL.
 *
 * Stage 1 is finished when every active driver group resolves to exactly one
 * person, the telegram_user_id-anchored pairs are linked automatically, and the
 * name-only collisions are reported rather than merged. These tests assert
 * exactly that — plus the two properties that make it safe to run on a live
 * fleet: a dry run writes nothing, and a second run is a no-op.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATH = path.resolve(__dirname, '../services/identity/personBackfillService.js');
const PLAN_PATH = path.resolve(__dirname, '../services/identity/personBackfillPlan.js');

/**
 * Point the run at the harness's throwaway database.
 *
 * The service takes `db` by injection, so this needs no module-cache surgery —
 * which matters, because loadDataLayer deliberately drops its pool stub in a
 * `finally` and only binds the modules it loads itself.
 */
function loadService(harness) {
  delete require.cache[SERVICE_PATH];
  delete require.cache[PLAN_PATH];
  const service = require(SERVICE_PATH);
  const db = { pool: harness.pool, query: harness.query };
  return {
    runPersonBackfill: (options = {}) => service.runPersonBackfill({ ...options, db }),
    driverPeople: harness.loadDataLayer(['driverPeople']).driverPeople,
  };
}

async function seed(harness, rows) {
  for (const row of rows) {
    const res = await harness.query(
      `INSERT INTO groups (telegram_group_id, group_name, group_type, active)
       VALUES ($1, $2, 'driver', $3) RETURNING id`,
      [row.telegramGroupId, row.groupName, row.active !== false]
    );
    const groupId = res.rows[0].id;
    await harness.query(
      `INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number, telegram_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_id) DO UPDATE SET
         first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
         unit_number = EXCLUDED.unit_number, telegram_user_id = EXCLUDED.telegram_user_id`,
      [groupId, row.firstName, row.lastName, row.unitNumber || null, row.telegramUserId || null]
    );
  }
}

const FLEET = [
  // The real twin pair: one Telegram account, two live chats.
  { telegramGroupId: -4532192670, groupName: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', firstName: 'RUSLAN', lastName: 'ABDULLAEV', unitNumber: '27', telegramUserId: 8606595680 },
  { telegramGroupId: -1003926411779, groupName: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', firstName: 'RUSLAN', lastName: 'ABDULLAEV', unitNumber: '27', telegramUserId: 8606595680 },
  // A name collision with no anchor — a candidate, not a merge.
  { telegramGroupId: -2001, groupName: 'WENZE UNIT # 310 OMAR ALAWAD', firstName: 'OMAR', lastName: 'ALAWAD', unitNumber: '310' },
  { telegramGroupId: -2002, groupName: 'WENZE UNIT # 005 OMAR ALAWAD', firstName: 'OMAR', lastName: 'ALAWAD', unitNumber: '005' },
  // A contested unit.
  { telegramGroupId: -2003, groupName: 'WENZE UNIT # 001 OLABODE OLUDAISI', firstName: 'OLABODE', lastName: 'OLUDAISI', unitNumber: '001' },
  { telegramGroupId: -2004, groupName: 'WENZE UNIT # 001 STARKS DAYMON', firstName: 'STARKS', lastName: 'DAYMON', unitNumber: '001' },
  // An inactive group must be left out entirely.
  { telegramGroupId: -2005, groupName: 'WENZE UNIT # 999 GONE AWAY INACTIVE', firstName: 'GONE', lastName: 'AWAY', unitNumber: '999', active: false },
];

async function harnessWithFleet(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await seed(harness, FLEET);
  return harness;
}

test('a dry run writes nothing at all', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFleet(t);
  const { runPersonBackfill } = loadService(harness);

  const { plan, applied, dryRun } = await runPersonBackfill();

  assert.equal(dryRun, true);
  assert.equal(applied, null);
  assert.equal(plan.stats.groups, 6, 'the inactive group is not a person');
  assert.equal(plan.stats.people, 5, 'the anchored pair is one human');

  for (const table of ['driver_people', 'driver_person_groups', 'driver_units']) {
    const n = await harness.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    assert.equal(n.rows[0].n, 0, `${table} must be untouched by a dry run`);
  }
});

test('applying links the anchored pair and leaves the contested unit unclaimed', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFleet(t);
  const { runPersonBackfill } = loadService(harness);

  const { plan, applied } = await runPersonBackfill({ apply: true });

  assert.equal(applied.peopleCreated, 5);
  assert.equal(applied.associationsOpened, 6, 'six active groups, five people');

  // The twin pair is one person holding both chats.
  const twin = await harness.query(
    `SELECT p.id, COUNT(a.id)::int AS groups
       FROM driver_people p
       JOIN driver_person_groups a ON a.person_id = p.id
      WHERE p.display_name = 'RUSLAN ABDULLAEV'
      GROUP BY p.id`
  );
  assert.equal(twin.rows.length, 1, 'one human, not two');
  assert.equal(twin.rows[0].groups, 2);

  const source = await harness.query(
    `SELECT DISTINCT association_source FROM driver_person_groups WHERE person_id = $1`,
    [twin.rows[0].id]
  );
  assert.deepEqual(source.rows.map((r) => r.association_source), ['telegram_user_id']);

  // The name-only collision stayed two people.
  const omar = await harness.query(`SELECT COUNT(*)::int AS n FROM driver_people WHERE display_name = 'OMAR ALAWAD'`);
  assert.equal(omar.rows[0].n, 2, 'a shared name is not an identity');
  assert.equal(plan.mergeCandidates.length, 1, 'it is reported instead');

  // Unit 001 is claimed by nobody; 27, 310 and 005 are claimed.
  const units = await harness.query(`SELECT unit_number FROM driver_units WHERE ended_at IS NULL ORDER BY unit_number`);
  assert.deepEqual(units.rows.map((r) => r.unit_number), ['005', '27', '310']);
  assert.equal(plan.contestedUnits.length, 1);
  assert.equal(plan.contestedUnits[0].unitNumber, '001');
});

test('running it a second time changes nothing', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFleet(t);
  const { runPersonBackfill } = loadService(harness);

  await runPersonBackfill({ apply: true });
  const before = await harness.query('SELECT COUNT(*)::int AS n FROM driver_people');

  const { applied } = await runPersonBackfill({ apply: true });
  const after = await harness.query('SELECT COUNT(*)::int AS n FROM driver_people');

  assert.equal(applied.peopleCreated, 0, 'a re-run must not fragment anyone');
  assert.equal(applied.groupsSkipped, 6);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test('a group added later is picked up without disturbing the rest', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFleet(t);
  const { runPersonBackfill } = loadService(harness);
  await runPersonBackfill({ apply: true });

  await seed(harness, [{
    telegramGroupId: -3001, groupName: 'WENZE UNIT # 700 NEW DRIVER',
    firstName: 'NEW', lastName: 'DRIVER', unitNumber: '700',
  }]);

  const { applied } = await runPersonBackfill({ apply: true });
  assert.equal(applied.peopleCreated, 1);
  assert.equal(applied.associationsOpened, 1);
  assert.equal(applied.unitsOpened, 1);

  const total = await harness.query('SELECT COUNT(*)::int AS n FROM driver_people');
  assert.equal(total.rows[0].n, 6);
});

test('the data layer resolves a merged person to the canonical one', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFleet(t);
  const { runPersonBackfill, driverPeople } = loadService(harness);
  await runPersonBackfill({ apply: true });

  const omars = await driverPeople.findPeopleByNormalizedKey(
    (await harness.query(`SELECT normalized_key FROM driver_people WHERE display_name='OMAR ALAWAD' LIMIT 1`)).rows[0].normalized_key
  );
  assert.equal(omars.length, 2);

  await driverPeople.mergePerson(omars[0].id, omars[1].id);
  const resolved = await driverPeople.resolveCanonicalPerson(omars[0].id);
  assert.equal(resolved.id, omars[1].id);

  // Merged people drop out of the canonical listing but keep their history.
  const canonical = await driverPeople.findPeopleByNormalizedKey(omars[0].normalizedKey);
  assert.equal(canonical.length, 1);
  const stillLinked = await driverPeople.listGroupsForPerson(omars[0].id);
  assert.equal(stillLinked.length, 1, 'a merge moves nothing');

  await driverPeople.unmergePerson(omars[0].id);
  assert.equal((await driverPeople.findPeopleByNormalizedKey(omars[0].normalizedKey)).length, 2);
});

test('the layer stays invisible: no existing table is touched', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFleet(t);
  const { runPersonBackfill } = loadService(harness);

  const before = await harness.query(
    `SELECT (SELECT COUNT(*) FROM groups) AS groups,
            (SELECT COUNT(*) FROM driver_profiles) AS profiles,
            (SELECT md5(string_agg(g.group_name || ':' || g.active, ',' ORDER BY g.id)) AS h FROM groups g) AS digest`
  );
  await runPersonBackfill({ apply: true });
  const after = await harness.query(
    `SELECT (SELECT COUNT(*) FROM groups) AS groups,
            (SELECT COUNT(*) FROM driver_profiles) AS profiles,
            (SELECT md5(string_agg(g.group_name || ':' || g.active, ',' ORDER BY g.id)) AS h FROM groups g) AS digest`
  );
  assert.deepEqual(after.rows[0], before.rows[0], 'Stage 1 must be purely additive');
});
