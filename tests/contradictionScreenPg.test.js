'use strict';

/**
 * The fleet-wide screen, and the section that could never be read.
 *
 * TWO THINGS ONLY A REAL DATABASE PROVES.
 *
 *   THE RETENTION SECTION COMES BACK READABLE. It never did. `readRetention`
 *   selected `urgency` and `assessed_at`, columns `driver_retention_assessments`
 *   does not have; the query raised, `safely()` turned that into `null`, and
 *   every driver's retention section was `known: false` for ever. So
 *   `quiet_but_active` — the contradiction that tells a driver who stopped
 *   working apart from a FEED that stopped reporting — could not fire at all.
 *   A swallowed failure and an honest absence look identical from outside, so
 *   the only test that catches this is one that asserts the section is KNOWN
 *   against real rows.
 *
 *   THE SCREEN FINDS EACH REPRESENTABLE KIND. It is deliberately looser than
 *   the JS that decides, and the requirement is one-directional: over-selecting
 *   costs six wasted queries, under-selecting means a contradiction nobody ever
 *   hears about. One driver is seeded per kind, so a new kind added to
 *   `findContradictions` without a branch in the screen fails visibly.
 *
 * AND ONE KIND IS DELIBERATELY NOT SCREENED FOR. `two_open_units` cannot happen:
 * `uniq_driver_units_open_person` refuses a second open unit, which the last
 * test here proves by trying. Scanning the fleet for it every fifteen minutes
 * would be a cost with no possible answer, so the JS check stays as a guard
 * against that index being dropped and gets no query.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { findContradictions } = require('../lib/drivers/context');
const { assess } = require('../lib/retention/signals');

/**
 * The signals a real assessment produces for a driver who has gone quiet.
 *
 * BUILT BY THE PRODUCTION ASSESSOR, NOT BY HAND. The reader looked for
 * `s.kind`; `lib/retention/signals.js` writes `s.key`. The first version of
 * this test seeded `{ kind: 'gone_quiet' }` — the shape the broken reader
 * wanted — so it passed while `quiet_but_active` remained unable to fire
 * against a single real row. Going through `assess()` means the fixture is
 * whatever production actually stores, and the two cannot drift apart again.
 */
function quietSignals() {
  const { signals } = assess({
    baselineMessages: 40, recentMessages: 0, avgSentiment: 0,
    roadWeeksOverAllowance: 0, daysOnRoad: 10,
  });
  const quiet = signals.filter((sig) => String(sig.key).includes('quiet'));
  assert.ok(quiet.length, 'the assessor really does emit a quiet signal');
  assert.ok(quiet[0].key, 'and it carries `key` — the field the reader must use');
  assert.equal(quiet[0].kind, undefined, 'there is no `kind`, which was the bug');
  return signals;
}

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { driverContext, driverPeople } = h.loadDataLayer(['driverContext', 'driverPeople']);
  return { h, ctx: driverContext, people: driverPeople };
}

async function aDriver(h, people, { name, unit, groupId }) {
  const person = await people.createPerson({ displayName: name, normalizedKey: name.toLowerCase() });
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES ($1, $2, $3, 'driver', TRUE)`,
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

// ── the section that was never readable ──────────────────────────────────────

test('THE RETENTION SECTION IS READABLE — it asked for columns that do not exist',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people, { name: 'QUIET ONE', unit: '401', groupId: 7401 });
    await h.query(
      `INSERT INTO driver_retention_assessments
         (person_id, group_id, driver_name, score, level, signals, first_seen_at, last_seen_at)
       VALUES ($1, 7401, 'QUIET ONE', 40, 'watch',
               $2::jsonb,
               NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 hour')`,
      [person.id, JSON.stringify(quietSignals())]
    );

    const out = await ctx.getDriverContext(person.id);
    assert.equal(out.retention.known, true,
      'known:false here is how this bug hid — a failed query and no rows look identical');
    assert.equal(out.retention.goneQuiet, true);
    assert.equal(out.retention.urgency, 'watch');
    assert.equal(out.retention.signals, 1);
    assert.ok(out.retention.goneQuietSince, 'and when, so a notice can say since when');
  });

test('gone-quiet-since is when it STARTED, not when the sweep last looked',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people, { name: 'QUIET TWO', unit: '402', groupId: 7402 });
    await h.query(
      `INSERT INTO driver_retention_assessments
         (person_id, group_id, score, level, signals, first_seen_at, last_seen_at)
       VALUES ($1, 7402, 40, 'watch', $2::jsonb,
               NOW() - INTERVAL '9 days', NOW())`,
      [person.id, JSON.stringify(quietSignals())]
    );
    const out = await ctx.getDriverContext(person.id);
    const days = (Date.now() - new Date(out.retention.goneQuietSince).getTime()) / 86400000;
    assert.ok(days > 8, `expected roughly nine days, got ${days.toFixed(1)}`);
  });

test('a driver with no assessment is not quiet, and is still KNOWN',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people, { name: 'BUSY ONE', unit: '403', groupId: 7403 });
    const out = await ctx.getDriverContext(person.id);
    assert.equal(out.retention.known, true, 'an absence established is not an absence of evidence');
    assert.equal(out.retention.goneQuiet, false);
  });

// ── the screen finds each kind ───────────────────────────────────────────────

test('THE SCREEN FINDS EVERY REPRESENTABLE KIND, and leaves the ordinary driver alone',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, ctx, people } = await setup(t);

    // 1 — at home, and simultaneously in transit.
    const home = await aDriver(h, people, { name: 'HOME DRIVER', unit: '501', groupId: 7501 });
    await h.query(
      `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
       VALUES (7501, 'home', NOW() - INTERVAL '3 days', NOW())`
    );
    await h.query(
      `INSERT INTO load_lifecycle (order_id, group_id, phase, confidence, updated_at)
       VALUES ('L1', 7501, 'in_transit', 'high', NOW())`
    );

    // 2 — called quiet while the fleet shows them fuelling this morning.
    const quiet = await aDriver(h, people, { name: 'QUIET BUSY', unit: '503', groupId: 7503 });
    await h.query(
      `INSERT INTO driver_retention_assessments
         (person_id, group_id, score, level, signals, first_seen_at, last_seen_at)
       VALUES ($1, 7503, 55, 'urgent', $2::jsonb,
               NOW() - INTERVAL '5 days', NOW())`,
      [quiet.id, JSON.stringify(quietSignals())]
    );
    await h.query(
      `INSERT INTO truck_fuel_readings (unit_number, person_id, fuel_percent, odometer_miles, recorded_at)
       VALUES ('503', $1, 61, 200000, NOW() - INTERVAL '2 hours')`,
      [quiet.id]
    );

    // 3 — nothing wrong at all.
    const fine = await aDriver(h, people, { name: 'FINE DRIVER', unit: '504', groupId: 7504 });
    await h.query(
      `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
       VALUES (7504, 'road', NOW() - INTERVAL '10 days', NOW())`
    );

    const candidates = await ctx.listContradictionCandidates({});
    assert.ok(candidates.includes(home.id), 'home while working');
    assert.ok(candidates.includes(quiet.id), 'quiet but active');
    assert.ok(!candidates.includes(fine.id), 'and the ordinary driver costs six queries nobody ran');

    // And what the screen selected really does contradict, per the module that
    // decides. A screen that returned the right ids for the wrong reasons would
    // pass the assertions above.
    for (const person of [home, quiet]) {
      // eslint-disable-next-line no-await-in-loop
      const found = findContradictions(await ctx.getDriverContext(person.id));
      assert.ok(found.length > 0, `person ${person.id} was screened in and confirmed`);
    }
  });

test('a quiet driver with NO recent activity is not screened in — that is just retention',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people, { name: 'REALLY QUIET', unit: '505', groupId: 7505 });
    await h.query(
      `INSERT INTO driver_retention_assessments
         (person_id, group_id, score, level, signals, first_seen_at, last_seen_at)
       VALUES ($1, 7505, 55, 'urgent', $2::jsonb,
               NOW() - INTERVAL '5 days', NOW())`,
      [person.id, JSON.stringify(quietSignals())]
    );
    await h.query(
      `INSERT INTO truck_fuel_readings (unit_number, person_id, fuel_percent, odometer_miles, recorded_at)
       VALUES ('505', $1, 61, 200000, NOW() - INTERVAL '9 days')`,
      [person.id]
    );
    const candidates = await ctx.listContradictionCandidates({});
    assert.ok(!candidates.includes(person.id),
      'nothing disagrees: retention says quiet and so does every other source');
  });

// ── the kind the database already prevents ──────────────────────────────────

test('TWO OPEN UNITS IS NOT SCREENED FOR BECAUSE IT CANNOT HAPPEN',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, people } = await setup(t);
    const person = await aDriver(h, people, { name: 'ONE TRUCK', unit: '601', groupId: 7601 });

    await assert.rejects(
      () => h.query(
        `INSERT INTO driver_units (person_id, unit_number, source, started_at)
         VALUES ($1, '999', 'manual', NOW())`,
        [person.id]
      ),
      /uniq_driver_units_open_person/,
      'the schema refuses it, so a fleet-wide scan for it every 15 minutes '
        + 'would find nothing for ever'
    );
  });

test('A QUIET DRIVER WHOSE TRUCK IS IN TRANSIT IS SCREENED IN, on the load alone',
  { skip: skipWithoutPg() }, async (t) => {
    // `findContradictions` has always counted a moving load as activity. The
    // screen checked only fuel and safety, so a driver marked quiet whose truck
    // is plainly in transit — no recent fuel reading, no safety event — was
    // never read, and the contradiction the screen exists to surface was the
    // one kind it could not see.
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people, { name: 'QUIET HAULER', unit: '601', groupId: 7601 });
    await h.query(
      `INSERT INTO driver_retention_assessments
         (person_id, group_id, score, level, signals, first_seen_at, last_seen_at)
       VALUES ($1, 7601, 55, 'urgent', $2::jsonb,
               NOW() - INTERVAL '5 days', NOW())`,
      [person.id, JSON.stringify(quietSignals())]
    );
    await h.query(
      `INSERT INTO load_lifecycle (order_id, group_id, phase, confidence, updated_at)
       VALUES ('L9', 7601, 'in_transit', 'high', NOW())`
    );
    // Deliberately NO fuel reading and NO safety event.

    const candidates = await ctx.listContradictionCandidates({});
    assert.ok(candidates.includes(person.id),
      'the load is the activity here, and the screen must not miss it');

    const found = findContradictions(await ctx.getDriverContext(person.id));
    assert.ok(found.some((c) => c.kind === 'quiet_but_active'),
      'and the evaluator confirms what the screen selected it for');
  });

test('a quiet driver whose load is merely ASSIGNED is not screened in',
  { skip: skipWithoutPg() }, async (t) => {
    // The screen must match the evaluator, which counts only phases that mean
    // the truck is working. A load sitting assigned contradicts nothing.
    const { h, ctx, people } = await setup(t);
    const person = await aDriver(h, people, { name: 'QUIET WAITER', unit: '602', groupId: 7602 });
    await h.query(
      `INSERT INTO driver_retention_assessments
         (person_id, group_id, score, level, signals, first_seen_at, last_seen_at)
       VALUES ($1, 7602, 55, 'urgent', $2::jsonb,
               NOW() - INTERVAL '5 days', NOW())`,
      [person.id, JSON.stringify(quietSignals())]
    );
    await h.query(
      `INSERT INTO load_lifecycle (order_id, group_id, phase, confidence, updated_at)
       VALUES ('L10', 7602, 'assigned', 'high', NOW())`
    );

    const candidates = await ctx.listContradictionCandidates({});
    assert.ok(!candidates.includes(person.id));
  });
