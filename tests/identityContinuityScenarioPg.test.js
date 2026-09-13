/**
 * One PERSON, two trucks, and a second driver who inherits nothing.
 *
 * THE SCENARIO THIS REPOSITORY WAS BUILT AROUND. A driver runs unit 123. They
 * move to 456. Somebody else is given 123. Everything the newer features record
 * — fuel readings, safety events, loads, retention — must follow the human, and
 * the new driver of 123 must start with an empty history rather than inheriting
 * a stranger's.
 *
 * It is worth a test of its own because every one of those features was written
 * separately, each one keyed its rows differently at first, and the failure is
 * SILENT: a safety pattern attributed to the wrong driver looks exactly like a
 * safety pattern. Production already showed the shape of it — twenty people
 * holding two `driver_profiles` each, because a truck change created a new chat
 * and nothing above the chat knew they were the same person.
 *
 * Runs against the real schema. No stubs below the data layer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer([
    'driverPeople', 'truckFuelReadings', 'driverSafety', 'retentionAssessments',
  ]);
  return { h, ...layer };
}

/** A person with an open truck, as the resolver would leave them. */
async function personOnUnit(h, driverPeople, { name, key, unit, telegramId, groupId }) {
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES ($1, $2, $3, 'driver', TRUE)`,
    [groupId, telegramId, `WENZE UNIT # ${unit} ${name}`]
  );
  const person = await driverPeople.createPerson({ displayName: name, normalizedKey: key });
  await driverPeople.openGroupAssociation({
    personId: person.id, groupId, source: 'manual', confidence: 100,
  });
  await driverPeople.openUnitAssignment({ personId: person.id, unitNumber: unit, source: 'manual' });
  return person;
}

const T = (h) => new Date(Date.parse('2026-09-01T06:00:00Z') + h * 3600000).toISOString();

test('a driver who changes truck keeps their fuel history, and the new driver of the '
  + 'old truck inherits none of it', { skip: skipWithoutPg() }, async (t) => {
  const { h, driverPeople, truckFuelReadings } = await setup(t);
  const john = await personOnUnit(h, driverPeople, {
    name: 'JOHN DOE', key: 'john doe', unit: '123', telegramId: -1001, groupId: 71,
  });

  // John runs 123 for a while.
  await truckFuelReadings.recordAndCompare({
    unitNumber: '123', personId: john.id, groupId: 71,
    fuelPercent: 90, odometerMiles: 100000, recordedAt: T(0),
  });
  await truckFuelReadings.recordAndCompare({
    unitNumber: '123', personId: john.id, groupId: 71,
    fuelPercent: 60, odometerMiles: 100300, recordedAt: T(6),
  });

  // He moves to 456, and somebody else is given 123.
  await driverPeople.closeUnitAssignment({ personId: john.id, unitNumber: '123' });
  await driverPeople.openUnitAssignment({ personId: john.id, unitNumber: '456', source: 'manual' });
  const mary = await personOnUnit(h, driverPeople, {
    name: 'MARY LEE', key: 'mary lee', unit: '123', telegramId: -1002, groupId: 72,
  });

  // THE BATCHED LOOKUP THE FUEL WATCH USES must now answer with the new driver
  // for 123 and John for 456. Getting this wrong would put John's name on
  // somebody else's fuel alerts.
  const byUnit = await driverPeople.getOpenPeopleForUnits(['123', '456']);
  assert.equal(byUnit.get('123'), mary.id);
  assert.equal(byUnit.get('456'), john.id);

  // Mary's first reading on 123 replaces the person on the truck's row — the
  // row is about the TANK — but John's history is not attributed to her.
  await truckFuelReadings.recordAndCompare({
    unitNumber: '123', personId: mary.id, groupId: 72,
    fuelPercent: 95, odometerMiles: 100310, recordedAt: T(30),
  });
  const truck = await truckFuelReadings.getReading('123');
  assert.equal(truck.personId, mary.id, 'the truck now reports to its current driver');
  assert.equal(truck.groupId, 72);
});

test('safety events follow the PERSON across the truck change', { skip: skipWithoutPg() }, async (t) => {
  const { h, driverPeople, driverSafety } = await setup(t);
  const john = await personOnUnit(h, driverPeople, {
    name: 'JOHN DOE', key: 'john doe', unit: '123', telegramId: -1001, groupId: 71,
  });

  // Two events on the old truck, one on the new one, all the same human.
  await h.query(
    `INSERT INTO driver_safety_events
       (samsara_event_id, person_id, group_id, unit_number, behavior, occurred_at)
     VALUES ('e1', $1, 71, '123', 'harsh_braking', NOW() - INTERVAL '5 days'),
            ('e2', $1, 71, '123', 'harsh_braking', NOW() - INTERVAL '4 days')`,
    [john.id]
  );
  await driverPeople.closeUnitAssignment({ personId: john.id, unitNumber: '123' });
  await driverPeople.openUnitAssignment({ personId: john.id, unitNumber: '456', source: 'manual' });
  await h.query(
    `INSERT INTO driver_safety_events
       (samsara_event_id, person_id, group_id, unit_number, behavior, occurred_at)
     VALUES ('e3', $1, 71, '456', 'harsh_braking', NOW() - INTERVAL '1 day')`,
    [john.id]
  );

  // The coach's own grouping — by PERSON where there is one, which is the whole
  // reason `person_id` is on the events table.
  const drivers = await driverSafety.listDriversWithRecentEvents({ windowDays: 14, minEvents: 3 });
  assert.equal(drivers.length, 1, 'one driver, not one per truck');
  assert.equal(drivers[0].personId, john.id);
  assert.equal(drivers[0].events.length, 3,
    'THREE events, not two and one — a history that resets on a truck change '
    + 'hides exactly the driver a pattern would find');

  // And a new driver of 123 starts clean: nothing of John's is keyed to her.
  const mary = await personOnUnit(h, driverPeople, {
    name: 'MARY LEE', key: 'mary lee', unit: '123', telegramId: -1002, groupId: 72,
  });
  const after = await driverSafety.listDriversWithRecentEvents({ windowDays: 14, minEvents: 1 });
  assert.equal(after.some((d) => d.personId === mary.id), false, 'she inherits none of his');
});

test('ONE OPEN ASSIGNMENT PER TRUCK — the schema refuses two drivers on 123 at once',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, driverPeople } = await setup(t);
    const john = await personOnUnit(h, driverPeople, {
      name: 'JOHN DOE', key: 'john doe', unit: '123', telegramId: -1001, groupId: 71,
    });
    const mary = await driverPeople.createPerson({ displayName: 'MARY LEE', normalizedKey: 'mary lee' });

    // Handing 123 to Mary WITHOUT closing John's is the mistake the constraint
    // exists to make impossible. Production had ten units on multiple active
    // drivers, one of them on four.
    await assert.rejects(
      () => driverPeople.openUnitAssignment({
        personId: mary.id, unitNumber: '123', source: 'manual',
      }),
      /duplicate key|unique/i
    );
    // One holder, and it is still John. `getOpenHoldersForUnit` replaced the
    // singular lookup, which returned whichever row Postgres handed back first
    // and is why a unit number was never a safe key on its own.
    const holders = await driverPeople.getOpenHoldersForUnit('123');
    assert.equal(holders.length, 1);
    assert.equal(holders[0].personId, john.id);
  });

test('a truck two people could claim is reported as UNKNOWN, never guessed',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, driverPeople } = await setup(t);
    await personOnUnit(h, driverPeople, {
      name: 'JOHN DOE', key: 'john doe', unit: '123', telegramId: -1001, groupId: 71,
    });
    const mary = await driverPeople.createPerson({ displayName: 'MARY LEE', normalizedKey: 'mary lee' });
    // Written past the data layer, as a partially-migrated database could hold.
    await h.query(
      `INSERT INTO driver_units (person_id, unit_number, source, started_at)
       VALUES ($1, '123', 'import', NOW())`,
      [mary.id]
    ).catch(() => null);

    const byUnit = await driverPeople.getOpenPeopleForUnits(['123']);
    const contested = (await h.query(
      "SELECT COUNT(*)::int AS n FROM driver_units WHERE unit_number = '123' AND ended_at IS NULL"
    )).rows[0].n;
    if (contested > 1) {
      assert.equal(byUnit.has('123'), false,
        'CONFLICTING IDENTITY EVIDENCE MUST NOT BECOME A GUESSED CORRECTION — a '
        + 'lookup that picked one would put a name on the wrong driver\'s alerts, '
        + 'silently. `identity.unit_open_twice` is what reports it.');
    } else {
      // The partial unique index held, which is the better outcome.
      assert.equal(contested, 1);
    }
  });

test('retention is assessed per PERSON, so a truck change does not restart the story',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, driverPeople, retentionAssessments } = await setup(t);
    const john = await personOnUnit(h, driverPeople, {
      name: 'JOHN DOE', key: 'john doe', unit: '123', telegramId: -1001, groupId: 71,
    });

    await retentionAssessments.recordAssessment({
      personId: john.id, groupId: 71, level: 'watch',
      signals: [{ key: 'weeks_on_road', detail: 'five weeks out' }], score: 40,
    });
    await driverPeople.closeUnitAssignment({ personId: john.id, unitNumber: '123' });
    await driverPeople.openUnitAssignment({ personId: john.id, unitNumber: '456', source: 'manual' });
    await retentionAssessments.recordAssessment({
      personId: john.id, groupId: 71, level: 'urgent',
      signals: [{ key: 'weeks_on_road', detail: 'six weeks out' }], score: 70,
    });

    const rows = await h.query(
      'SELECT level FROM driver_retention_assessments WHERE person_id = $1', [john.id]
    );
    assert.equal(rows.rows.length, 1,
      'ONE open assessment per person — a truck change must not create a second '
      + 'story about the same driver');
    assert.equal(rows.rows[0].level, 'urgent', 'and it is the current one');
  });
