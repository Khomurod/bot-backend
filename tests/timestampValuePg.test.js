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

// ── a rejected timestamp is not a new sighting ───────────────────────────────
//
// Turning an unreadable `seenAt` into NULL saved the write and broke the
// counting: `NULL IS DISTINCT FROM last_seen_at` is TRUE, so every poll of the
// SAME provider reading counted as another sighting, while `last_seen_at` kept
// its old value and never converged. Two polls then produce the sustained
// movement that lets an automatic Home → Road change through — on one sighting.

test('an unreadable sighting time never advances the movement count', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: new Date().toISOString() });

  // One real sighting, moving.
  await watch.recordObservation(7701, {
    lat: 42.5, lng: -88.6, speedMph: 61, seenAt: '2026-09-12T01:00:00Z',
    checkedAt: new Date().toISOString(), moving: true,
  });
  const first = await h.query('SELECT moving_sightings FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(Number(first.rows[0].moving_sightings), 1);

  // The same truck, still moving, but the provider's timestamp is unreadable.
  // Poll it three times: not one of them is new evidence.
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await watch.recordObservation(7701, {
      lat: 42.5, lng: -88.6, speedMph: 61, seenAt: 'unknown',
      checkedAt: new Date().toISOString(), moving: true,
    });
  }
  const after = await h.query('SELECT moving_sightings, last_seen_at FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(Number(after.rows[0].moving_sightings), 1,
    'three polls of one unreadable reading are not three sightings');
  assert.equal(new Date(after.rows[0].last_seen_at).toISOString(), '2026-09-12T01:00:00.000Z',
    'and the last good sighting time is kept');
});

test('a genuinely new sighting still counts', { skip: skipWithoutPg() }, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: new Date().toISOString() });
  for (const at of ['2026-09-12T01:00:00Z', '2026-09-12T02:00:00Z']) {
    // eslint-disable-next-line no-await-in-loop
    await watch.recordObservation(7701, {
      lat: 42.5, lng: -88.6, speedMph: 61, seenAt: at,
      checkedAt: new Date().toISOString(), moving: true,
    });
  }
  const row = await h.query('SELECT moving_sightings FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(Number(row.rows[0].moving_sightings), 2);
});

// ── a required timestamp is a different question ─────────────────────────────
//
// `driver_safety_events.occurred_at` is NOT NULL, so turning an unreadable
// value into a null swaps one exception for another rather than making the
// writer resilient. Inventing a time would be worse than both: every window,
// coaching decision and duplicate check in that table is keyed on WHEN the
// event happened.

test('a safety event with no readable time is refused, not invented', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { driverSafety } = h.loadDataLayer(['driverSafety']);

  const result = await driverSafety.recordSafetyEvent({
    samsaraEventId: 'evt-no-time', behavior: 'harshBraking', occurredAt: 'sometime today',
  });

  assert.equal(result, null, 'the caller reads null as "not recorded"');
  const rows = await h.query("SELECT COUNT(*)::int AS n FROM driver_safety_events WHERE samsara_event_id = 'evt-no-time'");
  assert.equal(rows.rows[0].n, 0, 'and nothing with a made-up time was written');
});

test('a safety event with a real time is still recorded', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { driverSafety } = h.loadDataLayer(['driverSafety']);

  const result = await driverSafety.recordSafetyEvent({
    samsaraEventId: 'evt-with-time', behavior: 'harshBraking',
    occurredAt: '2026-09-12T01:00:00Z',
  });
  assert.ok(result, 'it was recorded');
  assert.equal(new Date(result.occurredAt).toISOString(), '2026-09-12T01:00:00.000Z');
});

// ── the same trap, one column type over ─────────────────────────────────────
//
// Postgres accepts NaN in a `double precision` column and REFUSES it in an
// `integer` one. So a NaN speed or distance is stored happily, read back on the
// next pass, fed into a score — and the score lands in `last_score INTEGER`,
// which refuses it with the same `invalid input syntax` the timestamps raised.
// One driver then fails on every pass forever, because the value that poisons
// the score is the value the previous pass stored.

test('a NaN reading is refused at the boundary, not stored to poison the next pass', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: new Date().toISOString() });

  const stored = await watch.recordObservation(7701, {
    lat: 42.5, lng: -88.6,
    speedMph: Number('not a speed'),      // a provider that sent a word
    milesFromAnchor: Number.NaN,
    checkedAt: new Date().toISOString(),
  });

  assert.ok(stored, 'the observation was still written');
  const row = await h.query(
    'SELECT last_speed_mph, max_miles_from_anchor FROM home_time_return_watch WHERE group_id = 7701'
  );
  assert.equal(row.rows[0].last_speed_mph, null, 'a speed that is not a number is not a speed');
  assert.equal(Number(row.rows[0].max_miles_from_anchor), 0, 'and it did not become a NaN distance');
});

test('a NaN score does not abort the write on an INTEGER column', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: new Date().toISOString() });

  await watch.recordObservation(7701, {
    checkedAt: new Date().toISOString(), confidence: 'low', score: Number.NaN,
  });

  const row = await h.query('SELECT last_score, last_confidence FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(row.rows[0].last_score, null);
  assert.equal(row.rows[0].last_confidence, 'low', 'the verdict still landed');
});

test('real numbers are still stored exactly', { skip: skipWithoutPg() }, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: new Date().toISOString() });
  await watch.recordObservation(7701, {
    lat: 42.5, lng: -88.6, speedMph: 61.5, milesFromAnchor: 12.25,
    checkedAt: new Date().toISOString(), score: 40,
  });
  const row = await h.query(
    'SELECT last_speed_mph, max_miles_from_anchor, last_score FROM home_time_return_watch WHERE group_id = 7701'
  );
  assert.equal(Number(row.rows[0].last_speed_mph), 61.5);
  assert.equal(Number(row.rows[0].max_miles_from_anchor), 12.25);
  assert.equal(Number(row.rows[0].last_score), 40);
});

test('a real fractional distance is stored — the defect that stuck one driver', {
  skip: skipWithoutPg(),
}, async (t) => {
  // `COALESCE($7, 0)` made Postgres infer the parameter's type from the integer
  // literal beside it, so 12.25 miles was refused with "invalid input syntax
  // for type integer" against a DOUBLE PRECISION column. The distance is only
  // computed when the watch has an anchor AND the truck was seen — rare enough
  // that exactly one driver hit it, on every pass, for a day.
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: new Date().toISOString() });
  await watch.recordObservation(7701, {
    lat: 42.5, lng: -88.6, milesFromAnchor: 12.25, checkedAt: new Date().toISOString(),
  });
  const row = await h.query('SELECT max_miles_from_anchor FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(Number(row.rows[0].max_miles_from_anchor), 12.25);
});
