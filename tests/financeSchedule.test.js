'use strict';

/**
 * When the weekly report is due, and which week it reports on.
 *
 * DST IS WHERE A HAND-ROLLED WEEKLY SCHEDULE GOES WRONG. Twice a year the local
 * hour and the elapsed hours disagree, and `+ 7 * 24h` silently moves the send
 * to 07:00 or 09:00 on those two Mondays — a defect nobody reports and nobody
 * notices. Both boundaries are asserted here in LOCAL time, which is the only
 * frame in which the rule ("Monday 08:00") is even stated.
 *
 * AND THE PERIOD IS THE WEEK THAT ENDED, not the one beginning. A report sent
 * on Monday morning covering the calendar week it is in would be almost
 * entirely empty, every week, forever.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const schedule = require('../lib/finance/schedule');

const chicago = (d) => new Date(d).toLocaleString('en-US', {
  timeZone: schedule.ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

test('the run is Monday 08:00 local, whatever the day it is asked on', () => {
  for (const at of [
    '2026-09-07T13:30:00Z', // the Monday itself, after the hour
    '2026-09-09T12:00:00Z', // midweek
    '2026-09-13T23:00:00Z', // Sunday night
  ]) {
    const run = schedule.mostRecentScheduledRun(at);
    assert.match(chicago(run), /^Mon,? 08:00$/, `${at} -> ${chicago(run)}`);
    assert.ok(run <= new Date(at), 'the most recent run cannot be in the future');
  }
});

test('asked BEFORE 08:00 on a Monday, the most recent run is the week before', () => {
  // 2026-09-07 07:00 Chicago is 12:00Z. The report has not gone out yet, so
  // "the most recent scheduled run" is still 31 August.
  const run = schedule.mostRecentScheduledRun('2026-09-07T12:00:00Z');
  assert.equal(new Date(run).toISOString(), '2026-08-31T13:00:00.000Z');
});

test('the next run is always strictly in the future, and exactly a week on', () => {
  for (const at of ['2026-09-07T13:00:00Z', '2026-09-07T13:00:01Z', '2026-09-09T12:00:00Z']) {
    const next = schedule.nextScheduledRun(at);
    assert.ok(next > new Date(at), `${at} -> ${next.toISOString()} must be in the future`);
    assert.match(chicago(next), /^Mon,? 08:00$/);
  }
});

test('IT SURVIVES BOTH DST BOUNDARIES — the local hour holds, the week length does not', () => {
  // US DST ends Sunday 2026-11-01 and begins Sunday 2026-03-08.
  const cases = [
    { at: '2026-10-27T12:00:00Z', hours: 168 },  // an ordinary week
    { at: '2026-11-03T12:00:00Z', hours: 169 },  // the week the clocks went back
    { at: '2026-03-10T12:00:00Z', hours: 167 },  // the week the clocks went forward
  ];
  for (const { at, hours } of cases) {
    const run = schedule.mostRecentScheduledRun(at);
    assert.match(chicago(run), /^Mon,? 08:00$/, `${at} did not land on Monday 08:00 local`);

    const { periodStart, periodEnd } = schedule.periodFor(run);
    assert.equal((periodEnd - periodStart) / 3600000, hours,
      `${at}: a period is a WEEK, not 168 hours — that is the whole point`);
  }
});

test('the period is the week that ENDED, and the boundaries are half-open', () => {
  const run = schedule.mostRecentScheduledRun('2026-09-09T12:00:00Z');
  const { periodStart, periodEnd } = schedule.periodFor(run);

  assert.equal(periodEnd.getTime(), run.getTime(), 'the period ends at the send');
  assert.equal(new Date(periodStart).toISOString(), '2026-08-31T13:00:00.000Z');
  // Half-open: the PREVIOUS scheduled run's period ends exactly where this
  // one's begins, so a code issued on the boundary lands in precisely one
  // report rather than in two or in none. (`periodFor` takes a scheduled run,
  // so the previous one is found the same way this one was.)
  const previousRun = schedule.mostRecentScheduledRun(new Date(run.getTime() - 1));
  const previous = schedule.periodFor(previousRun);
  assert.equal(previous.periodEnd.getTime(), periodStart.getTime());
  assert.ok(previous.periodStart < previous.periodEnd);
});

test('the run key names the period, so two ticks in one week claim one thing', () => {
  const run = schedule.mostRecentScheduledRun('2026-09-09T12:00:00Z');
  const { periodStart } = schedule.periodFor(run);
  assert.equal(schedule.runKeyFor(periodStart), 'weekly:2026-08-31');

  // Asked again on a different day of the same week: the same key.
  const later = schedule.periodFor(schedule.mostRecentScheduledRun('2026-09-11T23:00:00Z'));
  assert.equal(schedule.runKeyFor(later.periodStart), 'weekly:2026-08-31');
});

test('a period that predates the monitor is a backfill and says so', () => {
  const { periodStart } = schedule.periodFor(schedule.mostRecentScheduledRun('2026-09-09T12:00:00Z'));

  // Never switched on: everything is a backfill.
  assert.equal(schedule.isBackfill(periodStart, null), true);
  // Switched on halfway through: the total would read "$0 issued" when the
  // truth is "we were not watching".
  assert.equal(schedule.isBackfill(periodStart, '2026-09-04T00:00:00Z'), true);
  // Switched on before it began: a complete week.
  assert.equal(schedule.isBackfill(periodStart, '2026-08-01T00:00:00Z'), false);
});

test('the grace covers a monitor switched on a few hours into a period', () => {
  const { periodStart } = schedule.periodFor(schedule.mostRecentScheduledRun('2026-09-09T12:00:00Z'));
  const hoursIn = (h) => new Date(periodStart.getTime() + h * 3600000);

  assert.equal(schedule.isBackfill(periodStart, hoursIn(1)), false);
  assert.equal(schedule.isBackfill(periodStart, hoursIn(schedule.BACKFILL_GRACE_HOURS - 1)), false);
  assert.equal(schedule.isBackfill(periodStart, hoursIn(schedule.BACKFILL_GRACE_HOURS + 1)), true);
});

test('the period description reads like a person wrote it', () => {
  const within = schedule.periodFor(schedule.mostRecentScheduledRun('2026-09-16T12:00:00Z'));
  assert.equal(schedule.describePeriod(within.periodStart, within.periodEnd), '7–13 September 2026');

  // A week that straddles two months names both.
  const across = schedule.periodFor(schedule.mostRecentScheduledRun('2026-09-09T12:00:00Z'));
  assert.equal(schedule.describePeriod(across.periodStart, across.periodEnd),
    '31 August – 6 September 2026');
});
