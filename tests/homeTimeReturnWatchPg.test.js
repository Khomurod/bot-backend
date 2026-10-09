'use strict';

/**
 * The return watch's narrowed statements, against a real PostgreSQL.
 *
 * A pass used to receive the whole 24-column watch row four times for every
 * driver at home. It now reads it ONCE — the create hands back what the row
 * remembers — and its sighting write echoes back only the four values the
 * score reads next. Both answers are still worked out BY THE DATABASE rather
 * than re-derived in JavaScript: the moving-sighting counter has been wrong
 * twice in ways only the real statement could show (a repeated ping, an
 * untimed one), so the narrowing proves PARITY — every narrow answer equals
 * what the full row says — rather than trusting a copy of the rules.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const opts = { skip: skipWithoutPg() };
const HOME = { lat: 41.88, lng: -87.63 };
const FAR = { lat: 42.5, lng: -88.6 };
const T1 = '2026-09-12T01:00:00.000Z';
const T2 = '2026-09-12T02:00:00.000Z';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const watch = h.loadDataLayer(['homeTime/returnWatch'])['homeTime/returnWatch'];
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (7701, -17701, 'WENZE UNIT # 77 A DRIVER', 'driver', TRUE),
            (7702, -17702, 'WENZE UNIT # 78 B DRIVER', 'driver', TRUE)`
  );
  return { h, watch };
}

/** What the FULL row says about the fields a pass reads. */
async function fullRemembered(watch, groupId) {
  const full = await watch.getWatch(groupId);
  return {
    anchor: full.anchor && { lat: full.anchor.lat, lng: full.anchor.lng },
    last: full.last,
    maxMilesFromAnchor: full.maxMilesFromAnchor,
    movingSightings: full.movingSightings,
  };
}

async function runningOf(watch, groupId) {
  const { anchor, maxMilesFromAnchor, movingSightings } = await fullRemembered(watch, groupId);
  return { anchor, maxMilesFromAnchor, movingSightings };
}

test('a new watch hands back what it remembers — which is nothing yet', opts, async (t) => {
  const { watch } = await setup(t);
  const first = await watch.ensureWatch({ groupId: 7701, homeSince: T1 });
  assert.deepEqual(first, { anchor: null, last: null, maxMilesFromAnchor: 0, movingSightings: 0 });
});

test('an existing watch hands back exactly what the full row says, and keeps its anchor', opts, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, personId: null, roadHistoryId: null, homeSince: T1 });
  await watch.recordObservation(7701, {
    ...HOME, speedMph: 0, seenAt: T1, checkedAt: T1, anchorEligible: true, anchorSource: 'live_gps',
  });
  await watch.recordObservation(7701, {
    ...FAR, speedMph: 61, seenAt: T2, checkedAt: T2, milesFromAnchor: 66, moving: true,
  });

  const again = await watch.ensureWatch({ groupId: 7701, homeSince: null });

  assert.deepEqual(again, await fullRemembered(watch, 7701), 'the one read is the full row, narrowed');
  assert.deepEqual(again.anchor, HOME, 'where the truck was parked, not where it went');
  assert.equal(again.last.speedMph, 61);
  assert.equal(again.last.at.toISOString(), T2);
  const row = await h.query('SELECT home_since FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(row.rows[0].home_since.toISOString(), T1, 'a missing home date does not erase the one it has');
});

test('the sighting write hands back the anchor and running values the row now holds', opts, async (t) => {
  const { watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: T1 });

  // The first parked sighting SETS the anchor — and the score must see it at once.
  const parked = await watch.recordObservation(7701, {
    ...HOME, speedMph: 0, seenAt: T1, checkedAt: T1, anchorEligible: true, anchorSource: 'live_gps',
  });
  assert.deepEqual(parked, { anchor: HOME, maxMilesFromAnchor: 0, movingSightings: 0 });
  assert.deepEqual(parked, await runningOf(watch, 7701));

  const moving = await watch.recordObservation(7701, {
    ...FAR, speedMph: 61, seenAt: T2, checkedAt: T2, milesFromAnchor: 66.5, moving: true, anchorEligible: true,
  });
  assert.deepEqual(moving, { anchor: HOME, maxMilesFromAnchor: 66.5, movingSightings: 1 });
  assert.deepEqual(moving, await runningOf(watch, 7701));

  // A repeated ping, and an untimed one, are not new sightings — as the row says.
  for (const seenAt of [T2, 'unknown']) {
    // eslint-disable-next-line no-await-in-loop
    const same = await watch.recordObservation(7701, {
      ...FAR, speedMph: 61, seenAt, checkedAt: T2, milesFromAnchor: 12, moving: true,
    });
    assert.deepEqual(same, { anchor: HOME, maxMilesFromAnchor: 66.5, movingSightings: 1 });
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(same, await runningOf(watch, 7701));
  }
});

test('the verdict write changes the verdict and nothing else', opts, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: T1 });
  await watch.recordObservation(7701, {
    ...HOME, speedMph: 0, seenAt: T1, checkedAt: T1, anchorEligible: true, anchorSource: 'live_gps',
    load: { loadIdentifier: 'L-1', status: 'assigned', pickupTime: T2 },
  });
  const before = (await h.query('SELECT * FROM home_time_return_watch WHERE group_id = 7701')).rows[0];

  const signals = { signals: ['active_load'], blockers: ['parked_at_home'], facts: { hasLoad: true } };
  const wrote = await watch.recordVerdict(7701, { checkedAt: T2, confidence: 'medium', score: 50, signals });

  assert.equal(wrote, true);
  const after = (await h.query('SELECT * FROM home_time_return_watch WHERE group_id = 7701')).rows[0];
  assert.equal(after.last_confidence, 'medium');
  assert.equal(after.last_score, 50);
  assert.deepEqual(after.last_signals, signals);
  assert.equal(after.last_checked_at.toISOString(), T2);
  const VERDICT = ['last_confidence', 'last_score', 'last_signals', 'last_checked_at', 'updated_at'];
  for (const column of Object.keys(before).filter((c) => !VERDICT.includes(c))) {
    assert.deepEqual(after[column], before[column], `${column} is not the verdict's to change`);
  }
});

test('a NaN verdict score is stored as no score, and the verdict still lands', opts, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: T1 });
  await watch.recordVerdict(7701, { checkedAt: T2, confidence: 'low', score: Number.NaN });
  const row = await h.query('SELECT last_score, last_confidence FROM home_time_return_watch WHERE group_id = 7701');
  assert.equal(row.rows[0].last_score, null);
  assert.equal(row.rows[0].last_confidence, 'low');
});

test('a verdict for a watch that is gone writes nothing, and says so', opts, async (t) => {
  const { watch } = await setup(t);
  assert.equal(await watch.recordVerdict(7701, { checkedAt: T2, confidence: 'low', score: 0 }), false);
});

test('the tidy-up counts what it drops and keeps the drivers still home', opts, async (t) => {
  const { h, watch } = await setup(t);
  await watch.ensureWatch({ groupId: 7701, homeSince: T1 });
  await watch.ensureWatch({ groupId: 7702, homeSince: T1 });

  assert.equal(await watch.clearStaleWatches([7701]), 1);
  const left = await h.query('SELECT group_id FROM home_time_return_watch ORDER BY group_id');
  assert.deepEqual(left.rows.map((r) => r.group_id), [7701]);
  assert.equal(await watch.clearStaleWatches([7701]), 0, 'nothing stale, nothing dropped');
  assert.equal(await watch.clearStaleWatches([]), 1, 'nobody home: every watch goes');
});

test('the at-home list names the driver, the unit and the open stay — and only what the pass uses', opts, async (t) => {
  const { h, watch } = await setup(t);
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (7703, -17703, 'WENZE UNIT # 79 GONE', 'driver', FALSE)`
  );
  await h.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number) VALUES (7701, 'A', 'DRIVER', '77')`
  );
  for (const [groupId, state] of [[7701, 'home'], [7702, 'road'], [7703, 'home']]) {
    // eslint-disable-next-line no-await-in-loop
    await h.query(
      `INSERT INTO driver_home_status (group_id, telegram_group_id, state, state_since, last_status_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [groupId, -groupId - 10000, state, T1]
    );
  }
  const stay = await h.query(
    `INSERT INTO driver_road_history (group_id, driver_name, unit_number, road_started_at, home_arrived_at, days_on_road, bonus_usd)
     VALUES (7701, 'A DRIVER', '77', '2026-08-01T12:00:00Z', $1, 42, 200) RETURNING id`,
    [T1]
  );
  const person = await h.query("INSERT INTO driver_people (display_name) VALUES ('A DRIVER') RETURNING id");
  await h.query(
    `INSERT INTO driver_person_groups (person_id, group_id, started_at, association_source)
     VALUES ($1, 7701, '2026-01-01T00:00:00Z', 'manual')`,
    [person.rows[0].id]
  );

  const list = await watch.listDriversAtHome();

  assert.deepEqual(list, [{
    groupId: 7701,
    groupName: 'WENZE UNIT # 77 A DRIVER',
    homeSince: new Date(T1),
    unitNumber: '77',
    driverName: 'A DRIVER',
    personId: person.rows[0].id,
    roadHistoryId: stay.rows[0].id,
  }], 'a driver on the road, and an inactive chat, are nobody this pass watches');
});
