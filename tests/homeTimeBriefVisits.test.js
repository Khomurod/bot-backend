'use strict';

/**
 * The 12-hour rule (owner, 27 November 2026): a visit home under 12 hours is
 * not going home, and a few hours on the road between two home stays is not a
 * trip. Pinned here, without a database:
 *
 *   - the pure rule (lib/homeTime/briefVisits.js): one way to count days, what
 *     is brief, and when a stay may be folded or reopened (never once its
 *     bonus is posted or decided);
 *   - the transition (services/homeTimeService.js) against an in-memory
 *     record: a 40-minute HOME folds back into the trip and the road clock
 *     goes on from the trip's start, so the next real arrival records the
 *     WHOLE trip and its whole bonus; coming home 3 hours after leaving
 *     reopens the stay, records no trip, and the managers hear both the
 *     return home and the final departure under keys of their own;
 *   - the bonus waits SETTLE_HOURS after the return before it is decided.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const B = require('../lib/homeTime/briefVisits');
const { staySubject, buildBackOnRoadNotice, buildArrivedHomeNotice } = require('../lib/homeTime/managerNotice');
const { SETTLE_HOURS } = require('../lib/homeTime/roadBonusDecision');

// ─── the pure rule ───────────────────────────────────────────────────────────

test('DAYS are complete 24-hour periods, whatever the clock or the zone', () => {
  assert.equal(B.wholeDays('2026-11-01T00:00:00Z', '2026-11-05T23:59:00Z'), 4);
  assert.equal(B.wholeDays('2026-11-01T00:00:00Z', '2026-11-06T00:00:00Z'), 5);
  assert.equal(B.wholeDays('2026-11-05T00:00:00Z', '2026-11-01T00:00:00Z'), 0, 'never negative');
  assert.equal(B.wholeDays(null, '2026-11-01T00:00:00Z'), null, 'unreadable is unknown, not zero');
  // Across the 1 November 2026 change in Chicago: 96.5 real hours is 4 days.
  // Counting calendar days in that zone said 3, and the fine and the bonus
  // could disagree about the same stay.
  assert.equal(B.wholeDays('2026-10-30T15:00:00Z', '2026-11-03T15:30:00Z'), 4);
  const { wholeDaysBetween } = require('../services/homeTimeConstants');
  assert.equal(wholeDaysBetween('2026-10-30T15:00:00Z', '2026-11-03T15:30:00Z'), 4, 'the bonus counts the same way');
  assert.equal(wholeDaysBetween('x', '2026-11-03T15:30:00Z'), 0, 'and keeps its own "unreadable is 0"');
});

test('BRIEF is under 12 hours, real and forward', () => {
  assert.equal(B.isBrief('2026-11-01T00:00:00Z', '2026-11-01T11:59:00Z'), true);
  assert.equal(B.isBrief('2026-11-01T00:00:00Z', '2026-11-01T12:00:00Z'), false, '12 hours is a stay');
  assert.equal(B.isBrief('2026-11-01T12:00:00Z', '2026-11-01T00:00:00Z'), false, 'backwards is not brief');
  assert.equal(B.isBrief(null, '2026-11-01T00:00:00Z'), false);
  assert.equal(B.durationLabel('2026-11-01T00:00:00Z', '2026-11-01T00:40:00Z'), '40 min');
  assert.equal(B.durationLabel('2026-11-01T00:00:00Z', '2026-11-01T03:30:00Z'), '3.5 h');
});

const stay = (over = {}) => ({
  id: 9,
  road_started_at: '2026-10-01T00:00:00Z',
  home_arrived_at: '2026-11-10T10:00:00Z',
  return_to_road_at: null,
  folded_at: null,
  days_on_road: 40,
  bonus_usd: 100,
  bonus_posted_at: null,
  bonus_decision: 'waiting_home_stay',
  ...over,
});

test('FOLD: only an open stay under 12 hours whose bonus nobody has posted or decided', () => {
  assert.equal(B.shouldFold(stay(), '2026-11-10T10:40:00Z'), true);
  assert.equal(B.shouldFold(stay(), '2026-11-10T22:00:00Z'), false, '12 hours is a stay');
  assert.equal(B.shouldFold(stay({ bonus_posted_at: '2026-11-10T10:05:00Z' }), '2026-11-10T10:40:00Z'), false,
    'a posted bonus is history');
  assert.equal(B.shouldFold(stay({ bonus_decision: 'needs_review' }), '2026-11-10T10:40:00Z'), false);
  assert.equal(B.shouldFold(stay({ bonus_usd: 0, bonus_posted_at: '2026-11-10T10:05:00Z' }), '2026-11-10T10:40:00Z'), true,
    'a leg with no bonus has nothing to protect');
  assert.equal(B.shouldFold(stay({ road_started_at: null }), '2026-11-10T10:40:00Z'), false,
    'no trip to carry on');
  assert.match(B.foldReason(stay(), '2026-11-10T10:40:00Z'),
    /Home only 40 min \(under 12 hours\).*trip from 2026-10-01 continues.*40 day\(s\).*\$100/);
});

test('REOPEN: only the stay the road state began at, left under 12 hours ago, bonus undecided', () => {
  const left = stay({ return_to_road_at: '2026-11-14T08:00:00Z' });
  const at = { roadSince: '2026-11-14T08:00:00Z', arrivedAt: '2026-11-14T11:00:00Z' };
  assert.equal(B.shouldReopen(left, at), true);
  assert.equal(B.shouldReopen(left, { ...at, arrivedAt: '2026-11-14T20:00:00Z' }), false, '12 hours away is a trip');
  assert.equal(B.shouldReopen(left, { ...at, roadSince: '2026-11-13T00:00:00Z' }), false,
    'a road state that did not begin at that stay is not its continuation');
  assert.equal(B.shouldReopen({ ...left, folded_at: '2026-11-14T08:00:00Z' }, at), false);
  assert.equal(B.shouldReopen({ ...left, bonus_decision: 'released' }, at), false);
  assert.equal(B.shouldReopen(null, at), false);
  assert.match(B.reopenNote(left, at.arrivedAt), /On the road only 3 h .*the home stay from 2026-11-10 continues/);
});

test('NOTICES: a reopened stay is told about under keys of its own, and a brief stop says what it was', () => {
  assert.equal(staySubject(12), 12);
  assert.equal(staySubject(12, '2026-11-14T11:00:00Z'), `12:again:${Date.parse('2026-11-14T11:00:00Z')}`);
  assert.equal(staySubject(null, '2026-11-14T11:00:00Z'), null, 'no stay, no stay key');
  const back = buildBackOnRoadNotice({
    driverName: 'Kwame Asante', endedAt: '2026-11-10T10:40:00Z', homeDays: 0,
    briefNote: 'Short stop (40 min), under 12 hours: not counted as home time.',
  });
  assert.match(back, /Short stop \(40 min\)/);
  assert.doesNotMatch(back, /Time at home/, '"0 days at home" would be the wrong thing to say');
  const home = buildArrivedHomeNotice({
    driverName: 'Kwame Asante', homeSince: '2026-11-10T10:00:00Z', briefNote: 'On the road only 3 h <b>',
  });
  assert.match(home, /On the road only 3 h &lt;b&gt;/, 'escaped');
});

test('the bonus is decided only once the driver has been gone SETTLE_HOURS', () => {
  assert.equal(SETTLE_HOURS, B.MIN_STAY_HOURS + 4);
});

// ─── the transition, against an in-memory record ─────────────────────────────

const HT = path.resolve(__dirname, '../database/homeTime.js');
const DB = path.resolve(__dirname, '../database/db.js');
const NOTICES = path.resolve(__dirname, '../services/homeTime/managerNotices.js');
const RELOAD = ['../services/homeTimeService', '../services/homeTime/stayClose', '../services/homeTime/briefVisits'];

function world({ state, since, changedAt = null, rows = [] }) {
  const cycles = rows.map((r, i) => ({
    id: i + 1, group_id: 1, folded_at: null, reopened_at: null, bonus_posted_at: null, linked_request_id: null, ...r,
  }));
  let status = { group_id: 1, state, state_since: since, state_changed_at: changedAt };
  const notices = [];
  const ht = {
    async getHomeTimeSettings() { return { enabled: true, road_allowance_weeks: 4, bonus_per_week: 100 }; },
    async getDriverHomeStatus() { return status; },
    async upsertDriverHomeStatus(p) {
      status = {
        group_id: 1, state: p.state, state_since: p.stateSince, state_changed_at: p.stateChangedAt || p.stateSince,
      };
    },
    async touchDriverHomeStatus() {},
    async insertRoadHistory(r) {
      const row = {
        id: cycles.length + 1, group_id: 1, road_started_at: r.roadStartedAt, home_arrived_at: r.homeArrivedAt,
        days_on_road: r.daysOnRoad, bonus_usd: r.bonusUsd, bonus_decision: r.bonusDecision ?? null,
        bonus_posted_at: r.bonusPostedAt ?? null, return_to_road_at: null, home_days: null,
        folded_at: null, reopened_at: null, linked_request_id: null,
      };
      cycles.push(row);
      return row;
    },
    async listOpenHomeStays() {
      return cycles.filter((c) => c.return_to_road_at == null).reverse();
    },
    async closeHomeStay(id, { returnToRoadAt, homeDays }) {
      const row = cycles.find((c) => c.id === id && c.return_to_road_at == null);
      if (!row) return null;
      Object.assign(row, { return_to_road_at: returnToRoadAt, home_days: homeDays });
      return row;
    },
    async foldHomeStay(id, { returnToRoadAt, reason }) {
      const row = cycles.find((c) => c.id === id && c.return_to_road_at == null && !c.folded_at);
      if (!row) return null;
      Object.assign(row, {
        return_to_road_at: returnToRoadAt, home_days: 0, folded_at: 'now', folded_reason: reason,
        bonus_usd: 0, bonus_decision: null,
      });
      return row;
    },
    async getLastClosedHomeStay() {
      return cycles.filter((c) => c.return_to_road_at != null && !c.folded_at).pop() || null;
    },
    async reopenHomeStay(id, { expectedReturnAt, arrivedAgainAt, note }) {
      const row = cycles.find((c) => c.id === id && c.return_to_road_at === expectedReturnAt);
      if (!row) return null;
      Object.assign(row, {
        return_to_road_at: null, home_days: null, reopened_at: arrivedAgainAt, reopened_note: note,
      });
      return row;
    },
    async findDecidedRequestNearDate() { return null; },
    async expireOpenClarificationsForGroup() {},
    async getApprovedHomeTimeRequestForGroup() { return null; },
  };
  for (const p of RELOAD) delete require.cache[require.resolve(p)];
  require.cache[HT] = { id: HT, filename: HT, loaded: true, exports: ht };
  require.cache[DB] = {
    id: DB,
    filename: DB,
    loaded: true,
    exports: {
      async getDriverProfileByGroupId() {
        return { first_name: 'Kwame', last_name: 'Asante', unit_number: '27', driver_type: 'company_driver' };
      },
    },
  };
  require.cache[NOTICES] = {
    id: NOTICES,
    filename: NOTICES,
    loaded: true,
    exports: {
      async noticeDriverIsHome(_t, args) { notices.push({ type: 'home', ...args }); },
      async noticeDriverBackOnRoad(_t, args) { notices.push({ type: 'road', ...args }); },
    },
  };
  const service = require('../services/homeTimeService');
  return {
    service, cycles, notices, status: () => status,
  };
}

const GROUP = { id: 1, telegram_group_id: -100, group_name: 'WENZE UNIT # 27 KWAME ASANTE', group_type: 'driver' };
const move = (svc, newState, eventAt) => svc.applyStateTransition({}, GROUP, { newState, eventAt, detectedBy: 'dispatcher_board' });

test.afterEach(() => {
  for (const p of [HT, DB, NOTICES, ...RELOAD.map((r) => require.resolve(r))]) delete require.cache[p];
});

test('a 40-minute HOME folds into the trip: the road clock goes on, and the real arrival records the whole trip', async () => {
  const w = world({ state: 'road', since: '2026-10-01T00:00:00Z' });
  await move(w.service, 'home', '2026-11-03T10:00:00.000Z'); // 33 days: $0 recorded yet
  await move(w.service, 'road', '2026-11-03T10:40:00.000Z');

  const [flap] = w.cycles;
  assert.ok(flap.folded_at, 'the 40 minutes are marked, not deleted');
  assert.equal(w.status().state, 'road');
  assert.equal(w.status().state_since, '2026-10-01T00:00:00.000Z', 'the road clock is the trip\'s, not the flap\'s');
  assert.equal(w.status().state_changed_at, '2026-11-03T10:40:00.000Z', 'the change itself is kept for the Board');
  const road = w.notices.find((n) => n.type === 'road');
  assert.match(road.briefNote, /Short stop \(40 min\).*trip from 2026-10-01 continues/);

  await move(w.service, 'home', '2026-11-12T10:00:00.000Z');
  const trip = w.cycles[1];
  assert.equal(trip.road_started_at, '2026-10-01T00:00:00.000Z');
  assert.equal(trip.days_on_road, 42, 'six whole weeks, not 9 days from the flap');
  assert.equal(trip.bonus_usd, 200, 'two extra weeks, not split in two');
  assert.equal(trip.bonus_decision, 'waiting_home_stay');
});

test('a stay of 12 hours or more is a stay, closed the ordinary way', async () => {
  const w = world({ state: 'road', since: '2026-10-01T00:00:00Z' });
  await move(w.service, 'home', '2026-11-03T10:00:00.000Z');
  await move(w.service, 'road', '2026-11-04T02:00:00.000Z');
  assert.equal(w.cycles[0].folded_at, null);
  assert.equal(w.cycles[0].home_days, 0);
  assert.equal(w.status().state_since, '2026-11-04T02:00:00.000Z', 'a new trip starts');
});

test('home again 3 hours after leaving REOPENS the stay: no trip, one stay counted from the first arrival', async () => {
  const w = world({ state: 'road', since: '2026-10-01T00:00:00Z' });
  await move(w.service, 'home', '2026-11-10T10:00:00.000Z');
  await move(w.service, 'road', '2026-11-12T08:00:00.000Z');
  const out = await move(w.service, 'home', '2026-11-12T11:00:00.000Z');

  assert.equal(out.transition, 'road_to_home');
  assert.equal(w.cycles.length, 1, 'no trip of three hours recorded');
  const [one] = w.cycles;
  assert.equal(one.return_to_road_at, null, 'the stay is open again');
  assert.equal(one.reopened_at, '2026-11-12T11:00:00.000Z');
  assert.equal(w.status().state, 'home');
  assert.equal(w.status().state_since, '2026-11-10T10:00:00.000Z', 'home since the FIRST arrival');

  await move(w.service, 'road', '2026-11-15T12:00:00.000Z');
  assert.equal(one.home_days, 5, 'counted from Nov 10, so the 5 days are seen — not 3 from the second arrival');

  const keys = w.notices.map((n) => `${n.type}:${n.roadHistoryId}:${n.againAt || ''}`);
  assert.deepEqual(keys, [
    'home:1:', 'road:1:', 'home:1:2026-11-12T11:00:00.000Z', 'road:1:2026-11-12T11:00:00.000Z',
  ], 'the managers hear the return home and the final departure, each under a key of its own');
  assert.match(w.notices[2].briefNote, /On the road only 3 h/);
});

test('home again after 12 hours or more is a new trip', async () => {
  const w = world({ state: 'road', since: '2026-10-01T00:00:00Z' });
  await move(w.service, 'home', '2026-11-10T10:00:00.000Z');
  await move(w.service, 'road', '2026-11-12T08:00:00.000Z');
  await move(w.service, 'home', '2026-11-12T20:00:00.000Z');
  assert.equal(w.cycles.length, 2);
  assert.equal(w.cycles[0].reopened_at, null);
});

test('a bonus already decided is never folded away — the stay closes the ordinary way', async () => {
  const w = world({
    state: 'home',
    since: '2026-11-03T10:00:00.000Z',
    rows: [{
      road_started_at: '2026-10-01T00:00:00.000Z', home_arrived_at: '2026-11-03T10:00:00.000Z',
      return_to_road_at: null, bonus_usd: 100, bonus_decision: 'needs_review',
    }],
  });
  await move(w.service, 'road', '2026-11-03T10:40:00.000Z');
  assert.equal(w.cycles[0].folded_at, null);
  assert.equal(w.cycles[0].return_to_road_at, '2026-11-03T10:40:00.000Z');
  assert.equal(w.status().state_since, '2026-11-03T10:40:00.000Z');
});
