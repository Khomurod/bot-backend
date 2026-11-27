'use strict';

/**
 * Accounting's verdicts read the record as VISITS (lib/homeTime/ownViolations.js,
 * the 12-hour rule of 27 November 2026), the same way the record is now
 * written (services/homeTime/briefVisits.js):
 *
 *   - a few hours on the road between two stays is no trip: one visit, its
 *     home days counted from the FIRST arrival, and the second arrival is not
 *     "came home early after 0 days on the road" (production: two such alerts
 *     went to accounting in November and moved the card to EARLY);
 *   - a flap at the very start of the record does not cut the road leg;
 *   - a stay Wenze folded into its trip is never a stay, whatever its times;
 *   - home days are counted exactly as the road bonus counts them.
 * Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { violationsFor, homeVisits } = require('../lib/homeTime/ownViolations');
const { wholeDaysBetween } = require('../services/homeTimeConstants');

const T = (iso) => new Date(iso).getTime();
const cycle = (road, home, back, over = {}) => ({
  roadStartedAt: road, homeArrivedAt: home, returnToRoadAt: back, driverType: 'company_driver', driverName: 'Yaw Boateng', ...over,
});
const SINCE = T('2026-11-01T00:00:00Z');
const NOW = T('2026-11-30T00:00:00Z');

test('A FEW HOURS ON THE ROAD between two stays: one visit, judged from the first arrival', () => {
  const rows = [
    cycle('2026-10-05T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-14T00:00:00Z'), // 2 days home
    cycle('2026-11-14T00:00:00Z', '2026-11-14T03:00:00Z', '2026-11-17T06:00:00Z'), // 3 hours out, 3 more days
  ];
  const out = violationsFor(rows, { now: NOW, since: SINCE });
  assert.deepEqual(out.map((s) => [s.homeFrom, s.violations, s.roadDays, s.homeDays]), [
    ['2026-11-11', ['overstay'], 38, 5],
  ], 'one overstay of 5 days — not two stays of 2 and 3, and no "early after 0 days"');
  assert.equal(homeVisits(rows, NOW).length, 1);
});

test('the second part is joined even when it is itself short — the way the record reopens the stay', () => {
  const rows = [
    cycle('2026-10-05T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-16T20:00:00Z'), // 4 days 20 h
    cycle('2026-11-16T20:00:00Z', '2026-11-16T23:00:00Z', '2026-11-17T04:00:00Z'), // 3 h out, 5 h home
  ];
  const [visit] = violationsFor(rows, { now: NOW, since: SINCE });
  assert.equal(visit.homeDays, 5, 'Nov 12 00:00 → Nov 17 04:00');
  assert.deepEqual(visit.violations, ['overstay']);
});

test('12 hours or more on the road is a trip: the next stay is its own, and early is judged', () => {
  const rows = [
    cycle('2026-10-05T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-14T00:00:00Z'),
    cycle('2026-11-14T00:00:00Z', '2026-11-14T13:00:00Z', '2026-11-16T00:00:00Z'),
  ];
  const out = violationsFor(rows, { now: NOW, since: SINCE });
  assert.deepEqual(out.map((s) => [s.violations, s.roadDays]), [[['early'], 0]]);
});

test('A FLAP AT THE START of the record does not cut the road leg (the November false "early")', () => {
  // The shape behind the two false alerts: the window begins with a flap, and
  // the real arrival's road start is the flap's return.
  const rows = [
    cycle('2026-10-10T00:00:00Z', '2026-11-03T09:00:00Z', '2026-11-03T09:50:00Z'),
    cycle('2026-11-03T09:50:00Z', '2026-11-12T00:00:00Z', '2026-11-15T00:00:00Z'),
  ];
  assert.deepEqual(violationsFor(rows, { now: NOW, since: SINCE }), [],
    '32 days on the road from Oct 10 — not 8 from the flap');
});

test('A FOLDED stay is never a stay, whatever its recorded times say', () => {
  const rows = [
    cycle('2026-10-10T00:00:00Z', '2026-11-03T09:00:00Z', '2026-11-04T09:00:00Z', { folded: true }),
    cycle('2026-10-10T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-15T00:00:00Z'),
  ];
  assert.deepEqual(violationsFor(rows, { now: NOW, since: SINCE }), []);
  assert.equal(homeVisits(rows, NOW).length, 1);
});

test('HOME DAYS are the bonus\'s days: the same stay, the same number', () => {
  // Across the clock change on 1 November: 5 days and 30 minutes of real time.
  const arrived = '2026-10-29T15:00:00Z';
  const back = '2026-11-03T15:30:00Z';
  const [visit] = violationsFor([cycle('2026-09-01T00:00:00Z', arrived, back)], { now: NOW, since: T('2026-10-01T00:00:00Z') });
  assert.deepEqual(visit.violations, ['overstay']);
  assert.equal(visit.homeDays, 5);
  assert.equal(visit.homeDays, wholeDaysBetween(arrived, back), 'the bonus would forfeit on the same count');
});
