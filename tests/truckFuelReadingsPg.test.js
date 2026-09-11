/**
 * The fuel-reading store against a real PostgreSQL.
 *
 * Three claims that are about SQL and cannot be proved with a fake:
 *
 *   ONE ROW PER TRUCK, FOREVER. This is the guarantee that keeps it from
 *   becoming the position history the application deliberately does not keep.
 *   Asserted by hammering the same unit and counting rows.
 *
 *   A PASS THAT CANNOT RESOLVE THE PERSON DOES NOT ERASE THE ONE THAT COULD.
 *   That is a COALESCE in the ON CONFLICT clause, and a wrong one there would
 *   silently detach a truck's fuel history from its driver — exactly the
 *   identity break this whole project exists to stop.
 *
 *   THE SUMMARY SEPARATES "no trucks can be compared yet" FROM "no truck is
 *   burning badly". They are the same silence and mean opposite things.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { truckFuelReadings } = h.loadDataLayer(['truckFuelReadings']);
  return { h, readings: truckFuelReadings };
}

const T = (h) => new Date(Date.parse('2026-09-20T06:00:00Z') + h * 3600000).toISOString();

test('a truck gets exactly one row no matter how many passes run', { skip: skipWithoutPg() }, async (t) => {
  const { h, readings } = await setup(t);
  for (let i = 0; i < 25; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await readings.recordAndCompare({
      unitNumber: '310', groupId: null, personId: null,
      fuelPercent: 90 - i, odometerMiles: 100000 + i * 12, recordedAt: T(i / 3),
    });
  }
  const res = await h.query('SELECT COUNT(*)::int AS n FROM truck_fuel_readings');
  assert.equal(res.rows[0].n, 1, '25 passes, one row — not a position history');

  const row = await readings.getReading('310');
  assert.equal(row.fuelPercent, 66, 'and it holds the LATEST reading');
  assert.equal(row.odometerMiles, 100288);
});

test('the baseline survives passes and produces a comparison once the miles are real',
  { skip: skipWithoutPg() }, async (t) => {
    const { readings } = await setup(t);
    const first = await readings.recordAndCompare({
      unitNumber: '311', fuelPercent: 95, odometerMiles: 200000, recordedAt: T(0),
    });
    assert.equal(first.previous, null);

    const soon = await readings.recordAndCompare({
      unitNumber: '311', fuelPercent: 94, odometerMiles: 200008, recordedAt: T(0.3),
    });
    assert.equal(soon.previous, null, '8 miles is not a window');

    const later = await readings.recordAndCompare({
      unitNumber: '311', fuelPercent: 70, odometerMiles: 200180, recordedAt: T(4),
    });
    assert.deepEqual(later.previous, { fuelPercent: 95, odometerMiles: 200000 },
      'the comparison is against the BASELINE, not against the 8-mile-old sample');
  });

test('a pass that cannot resolve the person keeps the person an earlier pass found',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, readings } = await setup(t);
    await h.query(
      `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
       VALUES (7, -1007, 'WENZE UNIT # 312 SAM RIVERA', 'driver', TRUE)`
    );
    const person = await h.query(
      "INSERT INTO driver_people (display_name, normalized_key) VALUES ('SAM RIVERA','sam rivera') RETURNING id"
    );
    const personId = Number(person.rows[0].id);

    await readings.recordAndCompare({
      unitNumber: '312', personId, groupId: 7, fuelPercent: 80, odometerMiles: 300000, recordedAt: T(0),
    });
    await readings.recordAndCompare({
      unitNumber: '312', personId: null, groupId: null,
      fuelPercent: 78, odometerMiles: 300020, recordedAt: T(1),
    });

    const row = await readings.getReading('312');
    assert.equal(row.personId, personId,
      'an identity lookup that failed for one pass must not detach the history');
    assert.equal(row.groupId, 7);
    assert.equal(row.fuelPercent, 78, 'while the reading itself still advances');
  });

test('a refuel resets the stored baseline in the database too', { skip: skipWithoutPg() }, async (t) => {
  const { readings } = await setup(t);
  await readings.recordAndCompare({
    unitNumber: '313', fuelPercent: 30, odometerMiles: 400000, recordedAt: T(0),
  });
  await readings.recordAndCompare({
    unitNumber: '313', fuelPercent: 99, odometerMiles: 400150, recordedAt: T(3),
  });
  const row = await readings.getReading('313');
  assert.equal(row.baselineReason, 'refuel');
  assert.equal(row.baselineOdometerMiles, 400150);

  const after = await readings.recordAndCompare({
    unitNumber: '313', fuelPercent: 80, odometerMiles: 400400, recordedAt: T(8),
  });
  assert.deepEqual(after.previous, { fuelPercent: 99, odometerMiles: 400150 },
    'the next window measures the NEW tank, from the fill onward');
});

test('the summary tells a fleet that cannot be compared from a fleet with nothing wrong',
  { skip: skipWithoutPg() }, async (t) => {
    const { readings } = await setup(t);
    const empty = await readings.summariseFuelReadings();
    assert.deepEqual(
      { trucks: empty.trucks, comparable: empty.comparable },
      { trucks: 0, comparable: 0 },
      'nothing recorded yet — silence here is not good news'
    );

    await readings.recordAndCompare({
      unitNumber: '314', fuelPercent: 90, odometerMiles: 500000, recordedAt: T(0),
    });
    const oneNew = await readings.summariseFuelReadings();
    assert.equal(oneNew.trucks, 1);
    assert.equal(oneNew.withFuel, 1);
    assert.equal(oneNew.comparable, 0, 'a truck seen once cannot be compared against anything');

    await readings.recordAndCompare({
      unitNumber: '314', fuelPercent: 70, odometerMiles: 500200, recordedAt: T(4),
    });
    const ready = await readings.summariseFuelReadings();
    assert.equal(ready.comparable, 1);
    assert.ok(ready.newestReading, 'and the age of the newest reading says whether it is still live');
  });

test('a truck reporting no tank level stores UNKNOWN and is not counted as comparable',
  { skip: skipWithoutPg() }, async (t) => {
    const { readings } = await setup(t);
    await readings.recordAndCompare({
      unitNumber: '315', fuelPercent: null, odometerMiles: null, recordedAt: T(0),
    });
    const row = await readings.getReading('315');
    assert.equal(row.fuelPercent, null, 'never zero');
    assert.equal(row.baselineOdometerMiles, null);
    const s = await readings.summariseFuelReadings();
    assert.equal(s.withFuel, 0);
    assert.equal(s.comparable, 0);
  });
