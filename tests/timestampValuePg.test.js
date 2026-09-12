'use strict';

/**
 * The cast is the thing that breaks, so the test has to reach the cast.
 *
 * A stubbed client answers whatever it is told to, so every unit test in this
 * repository was happy to hand `'TBD'` to a `timestamptz` parameter. Postgres
 * is not: it raises `invalid input syntax`, aborts the statement, and — before
 * the caller learned to isolate its drivers — took the whole return-to-road
 * pass with it, once every twelve minutes, for a day.
 *
 * These tests prove three things against the real schema: that the raw value
 * really does raise, that the writers no longer pass it, and that refusing it
 * costs only the one field.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

/** What Datatruck has actually been seen to put in a `pickup_time`. */
const NOT_A_DATE = 'TBD';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['homeTime/returnWatch']);
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (7701, -17701, 'WENZE UNIT # 77 A DRIVER', 'driver', TRUE)`
  );
  return { h, watch: layer['homeTime/returnWatch'] };
}

test('the raw value really does abort the statement — this is not theoretical', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h } = await setup(t);
  await assert.rejects(
    () => h.query('SELECT $1::timestamptz AS t', [NOT_A_DATE]),
    (err) => {
      assert.match(err.message, /invalid input syntax/i);
      return true;
    },
    'if this ever stops throwing, the guard below is no longer needed'
  );
});

test('an unreadable pickup time no longer takes the write down', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: new Date().toISOString() });

  const stored = await watch.recordObservation(7701, {
    checkedAt: new Date().toISOString(),
    load: { loadIdentifier: 'L-900', status: 'dispatched', pickupTime: NOT_A_DATE },
  });

  assert.ok(stored, 'the observation was written');
  // The one field that could not be read is empty; everything beside it landed.
  const row = await h.query('SELECT load_identifier, load_status, load_pickup_at FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(row.rows[0].load_identifier, 'L-900');
  assert.equal(row.rows[0].load_status, 'dispatched');
  assert.equal(row.rows[0].load_pickup_at, null);
});

test('a readable pickup time is still stored', { skip: skipWithoutPg() }, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: new Date().toISOString() });
  await watch.recordObservation(7701, {
    checkedAt: new Date().toISOString(),
    load: { loadIdentifier: 'L-901', status: 'dispatched', pickupTime: '2026-09-15T08:00:00Z' },
  });
  const row = await h.query('SELECT load_pickup_at FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(new Date(row.rows[0].load_pickup_at).toISOString(), '2026-09-15T08:00:00.000Z');
});

test('an unreadable sighting time is refused the same way', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: new Date().toISOString() });
  await watch.recordObservation(7701, {
    lat: 41.88, lng: -87.63, speedMph: 0, seenAt: 'unknown', checkedAt: new Date().toISOString(),
  });
  const row = await h.query('SELECT last_lat, last_seen_at FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(Number(row.rows[0].last_lat), 41.88, 'the position still landed');
  assert.equal(row.rows[0].last_seen_at, null);
});

test('a watch can be created even when the home date is unreadable', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, watch } = await setup(t);
  const created = await watch.ensureWatch({ groupId: 7701, homeSince: 'not a date' });
  assert.ok(created, 'refusing the value must not refuse the driver');
  const row = await h.query('SELECT home_since FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(row.rows[0].home_since, null);
});
