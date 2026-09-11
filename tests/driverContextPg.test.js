'use strict';

/**
 * Assembling one driver's picture from the real tables.
 *
 * WHAT ONLY A REAL DATABASE CAN PROVE HERE: that a section which cannot be read
 * comes back as a GAP rather than as an empty section. Every query in this
 * module is wrapped so one broken table cannot blank the page — and a wrapper
 * that swallowed a failure into `{}` instead of `null` would turn "the safety
 * query failed" into "this driver has no safety events", which is the exact
 * conflation the whole context model exists to prevent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { findContradictions, coverage } = require('../lib/drivers/context');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { driverContext, driverPeople } = h.loadDataLayer(['driverContext', 'driverPeople']);
  return { h, ctx: driverContext, people: driverPeople };
}

async function aDriver(h, people, { name = 'JOHN DOE', unit = '123', groupId = 7001 } = {}) {
  const person = await people.createPerson({ displayName: name, normalizedKey: name.toLowerCase() });
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES ($1, $2, $3, 'driver', TRUE) ON CONFLICT DO NOTHING`,
    [groupId, -100000 - groupId, `WENZE UNIT # ${unit} ${name}`]
  );
  await h.query(
    `INSERT INTO driver_person_groups (person_id, group_id, started_at, association_source)
     VALUES ($1, $2, NOW(), 'manual')`,
    [person.id, groupId]
  );
  await h.query(
    `INSERT INTO driver_units (person_id, unit_number, source, started_at)
     VALUES ($1, $2, 'manual', NOW())`,
    [person.id, unit]
  );
  return person;
}

test('a driver with nothing recorded is a page of gaps, not a clean bill of health',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people);
    const out = await ctx.getDriverContext(person.id);
    assert.equal(out.identity.known, true, 'identity is there');
    assert.equal(out.homeTime.known, false, 'and home time genuinely is not');
    const c = coverage(out);
    assert.ok(c.missing.includes('homeTime'));
  });

test('an unknown person returns a context of gaps rather than throwing',
  { skip: skipWithoutPg() }, async (t) => {
    const { ctx } = await setup(t);
    const out = await ctx.getDriverContext(999999);
    assert.equal(out.identity.known, false);
    assert.deepEqual(findContradictions(out), []);
  });

test('no person id at all is an empty context', { skip: skipWithoutPg() }, async (t) => {
  const { ctx } = await setup(t);
  const out = await ctx.getDriverContext(null);
  assert.equal(coverage(out).known, 0);
});

test('identity reports every OPEN unit, which is how two-at-once becomes visible',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people);
    await h.query(
      `INSERT INTO driver_units (person_id, unit_number, source, started_at)
       VALUES ($1, '456', 'import', NOW())`,
      [person.id]
    ).catch(() => null);

    const out = await ctx.getDriverContext(person.id);
    if (out.identity.openUnits.length > 1) {
      const found = findContradictions(out);
      assert.ok(found.some((c) => c.kind === 'two_open_units'),
        'the picture reports the disagreement rather than picking a truck');
    } else {
      // The partial unique index held, which is the better outcome.
      assert.equal(out.identity.openUnits.length, 1);
    }
  });

test('HOME AND IN TRANSIT AT ONCE IS REPORTED FROM REAL ROWS',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people);
    await h.query(
      `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
       VALUES (7001, 'home', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`
    );
    await h.query(
      `INSERT INTO load_lifecycle (order_id, group_id, phase, confidence, updated_at)
       VALUES ('A1', 7001, 'in_transit', 'high', NOW())`
    );
    const out = await ctx.getDriverContext(person.id);
    assert.equal(out.homeTime.state, 'home');
    assert.equal(out.loads.movingPhase, 'in_transit');
    const found = findContradictions(out);
    assert.ok(found.some((c) => c.kind === 'home_while_working'));
  });

test('a load merely ASSIGNED is not movement, so being home is not contradicted',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people);
    await h.query(
      `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
       VALUES (7001, 'home', NOW() - INTERVAL '1 day', NOW())`
    );
    await h.query(
      `INSERT INTO load_lifecycle (order_id, group_id, phase, confidence, updated_at)
       VALUES ('A2', 7001, 'assigned', 'high', NOW())`
    );
    const out = await ctx.getDriverContext(person.id);
    assert.equal(out.loads.movingPhase, null);
    assert.deepEqual(findContradictions(out), []);
  });

test('fuel and safety come back per PERSON, so they survive a truck change',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people);
    await h.query(
      `INSERT INTO truck_fuel_readings (unit_number, person_id, fuel_percent, odometer_miles, recorded_at)
       VALUES ('123', $1, 44, 100000, NOW() - INTERVAL '2 hours')`,
      [person.id]
    );
    const out = await ctx.getDriverContext(person.id);
    assert.equal(out.fuel.known, true);
    assert.equal(Number(out.fuel.fuelPercent), 44);
    assert.ok(out.fuel.newestReadingAt);
  });

test('a missing table is a GAP, never an empty section', { skip: skipWithoutPg() }, async (t) => {
  const { h, ctx, people } = await setup(t);
  const person = await aDriver(h, people);
  await h.query('DROP TABLE IF EXISTS driver_safety_events CASCADE');
  const out = await ctx.getDriverContext(person.id);
  assert.equal(out.safety.known, false,
    'swallowing the failure into an empty section would turn "the query failed" '
    + 'into "this driver has no safety events", and only one of those is a '
    + 'reason to relax');
  // And the rest of the page still assembled.
  assert.equal(out.identity.known, true);
});
