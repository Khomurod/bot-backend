'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  evaluateHours, normaliseWindow, describeSchedule, nextOpeningAfter, timeToMinutes,
} = require('../lib/recruiting/workingHours');

const CHICAGO = 'America/Chicago';
const OFFICE = [{ label: 'Weekdays', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }];

/** A Chicago wall-clock time as an instant, so the tests read as local times. */
function chicago(iso) {
  // CDT in September is UTC-5.
  return `${iso}-05:00`;
}

test('inside a weekday window the office is open', () => {
  const out = evaluateHours({ timezone: CHICAGO, windows: OFFICE }, chicago('2026-09-09T10:30:00'));
  assert.strictEqual(out.open, true);
  assert.strictEqual(out.reason, 'inside_window');
});

test('the end of a window is exclusive, the start inclusive', () => {
  const at18 = evaluateHours({ timezone: CHICAGO, windows: OFFICE }, chicago('2026-09-09T18:00:00'));
  assert.strictEqual(at18.open, false, '18:00 is when the window ends');
  const at8 = evaluateHours({ timezone: CHICAGO, windows: OFFICE }, chicago('2026-09-09T08:00:00'));
  assert.strictEqual(at8.open, true, '08:00 is when it starts');
});

test('a Saturday is outside a Monday-to-Friday schedule', () => {
  const out = evaluateHours({ timezone: CHICAGO, windows: OFFICE }, chicago('2026-09-12T10:00:00'));
  assert.strictEqual(out.open, false);
  assert.strictEqual(out.reason, 'outside_hours');
});

test('no configured hours means the office is ALWAYS open, so Wenze never speaks', () => {
  const out = evaluateHours({ timezone: CHICAGO, windows: [] }, chicago('2026-09-12T03:00:00'));
  assert.strictEqual(out.open, true);
  assert.strictEqual(out.reason, 'no_hours_configured');
});

test('an unreadable instant is not evidence the office is shut', () => {
  const out = evaluateHours({ timezone: CHICAGO, windows: OFFICE }, 'not-a-date');
  assert.strictEqual(out.open, true);
  assert.strictEqual(out.reason, 'unreadable_time');
});

test('a malformed window is dropped without taking the schedule down', () => {
  const windows = [{ days: [1], start: 'lunchtime', end: '18:00' }, ...OFFICE];
  const out = evaluateHours({ timezone: CHICAGO, windows }, chicago('2026-09-09T10:00:00'));
  assert.strictEqual(out.open, true, 'the readable window still applies');
});

// ── the overnight case, which is the one a naive implementation gets wrong ───

const NIGHT = [{ label: 'Friday night', days: [5], start: '22:00', end: '06:00' }];

test('an overnight window covers the evening of the day it starts', () => {
  const out = evaluateHours({ timezone: CHICAGO, windows: NIGHT }, chicago('2026-09-11T23:00:00'));
  assert.strictEqual(out.open, true, 'Friday 23:00 is inside Friday 22:00-06:00');
});

test('an overnight window covers the small hours of the NEXT day', () => {
  const out = evaluateHours({ timezone: CHICAGO, windows: NIGHT }, chicago('2026-09-12T02:00:00'));
  assert.strictEqual(out.open, true, 'Saturday 02:00 is the tail of the Friday window');
});

test('the tail belongs to the day the window STARTS, not to today', () => {
  // Saturday 02:00 with a SATURDAY-only overnight window must be CLOSED: the
  // Saturday window has not begun yet. An implementation that checks the time
  // span and then today's weekday reports open here.
  const saturdayNight = [{ days: [6], start: '22:00', end: '06:00' }];
  const out = evaluateHours({ timezone: CHICAGO, windows: saturdayNight }, chicago('2026-09-12T02:00:00'));
  assert.strictEqual(out.open, false);
});

test('start equal to end is a whole day, not none of it', () => {
  const allDay = [{ days: [6], start: '00:00', end: '00:00' }];
  const out = evaluateHours({ timezone: CHICAGO, windows: allDay }, chicago('2026-09-12T03:00:00'));
  assert.strictEqual(out.open, true);
});

// ── when does it open again ─────────────────────────────────────────────────

test('a Saturday afternoon points at Monday morning', () => {
  const out = evaluateHours({ timezone: CHICAGO, windows: OFFICE }, chicago('2026-09-12T14:00:00'));
  assert.ok(out.nextOpenIso, 'a closed office knows when it opens');
  const { DateTime } = require('luxon');
  const then = DateTime.fromISO(out.nextOpenIso, { setZone: true }).setZone(CHICAGO);
  assert.strictEqual(then.weekdayLong, 'Monday');
  assert.strictEqual(then.toFormat('HH:mm'), '08:00');
});

test('a weekly window that has already passed today resolves to next week', () => {
  const { DateTime } = require('luxon');
  const weekly = [normaliseWindow({ days: [3], start: '09:00', end: '10:00' })];
  // Wednesday 2026-09-09, 15:00 — after this week's window.
  const local = DateTime.fromISO(chicago('2026-09-09T15:00:00')).setZone(CHICAGO);
  const iso = nextOpeningAfter(weekly, local);
  assert.ok(iso, 'an eight-day walk finds the same weekday next week');
  const then = DateTime.fromISO(iso, { setZone: true }).setZone(CHICAGO);
  assert.strictEqual(then.weekdayLong, 'Wednesday');
  assert.strictEqual(then.toISODate(), '2026-09-16');
});

test('a schedule describes itself in words', () => {
  assert.strictEqual(
    describeSchedule({ timezone: CHICAGO, windows: OFFICE }),
    'Mon, Tue, Wed, Thu, Fri 08:00–18:00 (America/Chicago)',
  );
  assert.strictEqual(describeSchedule({ timezone: CHICAGO, windows: [] }), 'No working hours configured');
});

test('times are read tolerantly and rejected clearly', () => {
  assert.strictEqual(timeToMinutes('08:30'), 510);
  assert.strictEqual(timeToMinutes('08:30:00'), 510, 'Postgres TIME comes back with seconds');
  assert.strictEqual(timeToMinutes('24:00'), null);
  assert.strictEqual(timeToMinutes('08:70'), null);
  assert.strictEqual(timeToMinutes(''), null);
});

test('a window with no day list applies every day', () => {
  const win = normaliseWindow({ start: '08:00', end: '18:00' });
  assert.deepStrictEqual(win.days, [1, 2, 3, 4, 5, 6, 7]);
});
