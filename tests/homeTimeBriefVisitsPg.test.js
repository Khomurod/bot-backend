'use strict';

/**
 * The 12-hour rule against a real PostgreSQL (migration 0111 and
 * database/homeTime/briefVisits.js), through the real transition:
 *
 *   - a 40-minute HOME is folded: kept and marked, its bonus zeroed, the road
 *     clock back at the trip's start — and the real arrival records the whole
 *     trip; the folded row is out of the history, the efficiency report and
 *     the bonus queue;
 *   - home again three hours after leaving reopens the stay, and the managers'
 *     outbox holds a notice for each of the four events, none swallowed;
 *   - the guards hold: a stay whose bonus is decided is neither folded nor
 *     reopened, and a bonus is not decided until SETTLE_HOURS after the return;
 *   - the long-trip question carries the whole trip, read from the record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/identity/personResolver', '../services/homeTimeService', '../services/homeTime/stayClose',
  '../services/homeTime/briefVisits', '../services/homeTime/managerNotices',
  '../services/operations/consistencyService', '../services/operations/snapshot/loaders',
].map((p) => path.resolve(__dirname, `${p}.js`));

function bind(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    const db = { pool: harness.pool, query: harness.query };
    const store = require('../database/operationalFindings');
    const { runConsistencySweep } = require('../services/operations/consistencyService');
    return {
      ht: require('../database/homeTime'),
      resolver: require('../services/identity/personResolver'),
      homeTime: require('../services/homeTimeService'),
      store,
      sweep: () => runConsistencySweep({ db, store }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

const telegram = { sendMessage: async () => ({ message_id: 1 }) };

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await h.query(`INSERT INTO home_time_settings (id, enabled, completed_notify_group_id) VALUES (1, TRUE, '-500')
    ON CONFLICT (id) DO UPDATE SET enabled = TRUE, completed_notify_group_id = '-500'`);
  const g = await h.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active)
     VALUES (-27, 'WENZE UNIT # 27 KWAME ASANTE', 'driver', TRUE) RETURNING *`
  );
  await h.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number, driver_type)
     VALUES ($1, 'KWAME', 'ASANTE', '27', 'company_driver')`, [g.rows[0].id]
  );
  const bound = bind(h);
  await bound.resolver.ensurePersonForGroup(g.rows[0]);
  const move = (newState, eventAt) => bound.homeTime.applyStateTransition(telegram, g.rows[0], {
    newState, eventAt, detectedBy: 'dispatcher_board', evidenceSummary: `dispatcher board: ${newState === 'home' ? 'HOME' : 'READY'}`,
  });
  return {
    h, ...bound, group: g.rows[0], move,
  };
}

const legs = (h, groupId) => h.query('SELECT * FROM driver_road_history WHERE group_id = $1 ORDER BY id', [groupId]).then((r) => r.rows);
const isoOf = (v) => (v ? new Date(v).toISOString() : null);

test('a 40-minute HOME is folded, and the real arrival records the WHOLE trip', { skip: skipWithoutPg() }, async (t) => {
  const { h, ht, group, move } = await setup(t);
  await move('road', '2026-10-01T00:00:00.000Z');
  await move('home', '2026-11-03T10:00:00.000Z');
  await move('road', '2026-11-03T10:40:00.000Z');

  let [flap] = await legs(h, group.id);
  assert.ok(flap.folded_at, 'kept and marked');
  assert.match(flap.folded_reason, /Home only 40 min/);
  assert.equal(Number(flap.bonus_usd), 0);
  assert.equal(flap.home_days, 0);
  const status = await ht.getDriverHomeStatus(group.id);
  assert.equal(isoOf(status.state_since), '2026-10-01T00:00:00.000Z', 'the road clock is the trip\'s');
  assert.equal(isoOf(status.state_changed_at), '2026-11-03T10:40:00.000Z', 'the change is kept for the Board');

  await move('home', '2026-11-12T10:00:00.000Z');
  const all = await legs(h, group.id);
  [flap] = all;
  const trip = all[1];
  assert.equal(isoOf(trip.road_started_at), '2026-10-01T00:00:00.000Z');
  assert.equal(trip.days_on_road, 42);
  assert.equal(Number(trip.bonus_usd), 200, 'six weeks: two extra, not split');

  assert.deepEqual((await ht.listRoadHistory()).map((r) => r.id), [trip.id], 'the flap is not a trip in the history');
  assert.deepEqual((await ht.listRoadHistory({ bonusOnly: true })).map((r) => r.id), [trip.id]);
  assert.deepEqual((await ht.listCyclesForEfficiency()).map((r) => r.id), [trip.id]);
});

test('home again 3 hours after leaving reopens the stay, and the managers hear all four events', { skip: skipWithoutPg() }, async (t) => {
  const { h, group, move } = await setup(t);
  await move('road', '2026-10-01T00:00:00.000Z');
  await move('home', '2026-11-10T10:00:00.000Z');
  await move('road', '2026-11-12T08:00:00.000Z');
  await move('home', '2026-11-12T11:00:00.000Z');

  let all = await legs(h, group.id);
  assert.equal(all.length, 1, 'no three-hour trip recorded');
  assert.equal(all[0].return_to_road_at, null);
  assert.equal(isoOf(all[0].reopened_at), '2026-11-12T11:00:00.000Z');
  assert.match(all[0].reopened_note, /On the road only 3 h/);

  await move('road', '2026-11-15T12:00:00.000Z');
  all = await legs(h, group.id);
  assert.equal(all[0].home_days, 5, 'counted from the first arrival');
  assert.equal(all[0].closed_by, 'dispatcher_board');

  const notices = await h.query('SELECT event_type, event_key FROM home_time_manager_notices ORDER BY id');
  assert.deepEqual(notices.rows.map((n) => n.event_type), ['arrived_home', 'back_on_road', 'arrived_home', 'back_on_road']);
  assert.equal(new Set(notices.rows.map((n) => n.event_key)).size, 4, 'none swallowed by an earlier key');
});

test('THE GUARDS: a decided bonus is neither folded nor reopened, and a bonus waits SETTLE_HOURS', { skip: skipWithoutPg() }, async (t) => {
  const { h, ht, group } = await setup(t);
  const insert = (over) => ht.insertRoadHistory({
    groupId: group.id, driverName: 'KWAME ASANTE', unitNumber: '27',
    roadStartedAt: '2026-10-01T00:00:00Z', homeArrivedAt: '2026-11-12T00:00:00Z',
    daysOnRoad: 42, exceededWeeks: 2, bonusUsd: 200, bonusDecision: 'waiting_home_stay', ...over,
  });
  const held = await insert({ bonusDecision: 'needs_review' });
  assert.equal(await ht.foldHomeStay(held.id, { returnToRoadAt: '2026-11-12T00:30:00Z', reason: 'x' }), null);
  await ht.closeHomeStay(held.id, { returnToRoadAt: '2026-11-14T00:00:00Z', homeDays: 2 });
  assert.equal(await ht.reopenHomeStay(held.id, {
    expectedReturnAt: '2026-11-14T00:00:00Z', arrivedAgainAt: '2026-11-14T03:00:00Z', note: 'x',
  }), null, 'a held bonus keeps its stay');

  const waiting = await insert({});
  assert.equal(await ht.reopenHomeStay(waiting.id, {
    expectedReturnAt: '2026-11-14T00:00:00Z', arrivedAgainAt: '2026-11-14T03:00:00Z', note: 'x',
  }), null, 'an open stay is not reopened');
  const now = Date.now();
  await ht.closeHomeStay(waiting.id, { returnToRoadAt: new Date(now - 3 * 3600e3).toISOString(), homeDays: 2 });
  assert.deepEqual((await ht.listRoadBonusesAwaitingDecision({ settleHours: 16 })).map((r) => r.id), [],
    'left 3 hours ago: they may still come back');
  await h.query('UPDATE driver_road_history SET return_to_road_at = $2 WHERE id = $1', [waiting.id, new Date(now - 17 * 3600e3)]);
  assert.deepEqual((await ht.listRoadBonusesAwaitingDecision({ settleHours: 16 })).map((r) => r.id), [waiting.id]);

  const status = await ht.upsertDriverHomeStatus({
    groupId: group.id, telegramGroupId: -27, state: 'road', stateSince: '2026-11-14T00:00:00Z', lastStatusAt: '2026-11-14T00:00:00Z',
  });
  assert.equal(isoOf(status.state_changed_at), '2026-11-14T00:00:00.000Z', 'an ordinary write records the change at the clock\'s start');
});

test('THE LONG-TRIP QUESTION carries the whole trip, read from the record', { skip: skipWithoutPg() }, async (t) => {
  const { h, store, sweep, group, move } = await setup(t);
  await move('road', '2026-08-01T00:00:00.000Z');
  await move('home', '2026-08-20T09:00:00.000Z');
  await move('road', '2026-08-20T09:30:00.000Z'); // a flap, folded
  await move('home', '2026-09-22T00:00:00.000Z');
  await move('road', '2026-09-25T06:00:00.000Z');
  const trip = (await legs(h, group.id)).find((r) => !r.folded_at && r.home_arrived_at);
  await h.query("UPDATE driver_road_history SET bonus_decision = 'needs_review' WHERE id = $1", [trip.id]);

  await sweep();
  const [finding] = await store.listFindings({ status: 'open', checkKey: 'home_time.road_bonus_review' });
  const e = finding.evidence_json || finding.evidence;
  assert.equal(e.daysOnRoad, 52);
  assert.equal(e.homeDays, 3);
  assert.equal(isoOf(e.returnToRoadAt), '2026-09-25T06:00:00.000Z');
  assert.equal(e.openedBy, 'dispatcher_board');
  assert.equal(e.closedEvidence, 'dispatcher board: READY');
  assert.equal(e.briefVisits, 1);
  assert.deepEqual(e.briefVisitDays, ['2026-08-20']);
});
