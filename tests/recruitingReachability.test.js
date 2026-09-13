'use strict';

/**
 * Whether Wenze can EVER answer a candidate — not whether somebody saved a form.
 *
 * THE DEFECT. `afterHoursReadiness` asked `hoursConfigured`, a boolean meaning
 * "a working-hours row exists". But a reply needs two things true at the same
 * moment: the office is closed AND it is not quiet hours. Nothing checked what
 * those two settings MEANT together, and nothing looked at quiet hours at all.
 * So a schedule covering the whole week reported READY and `/api/health` said
 * OK, while no candidate could ever be answered.
 *
 * Two facts come out of the sweep and they are deliberately kept apart:
 *
 *   REACHABLE AT ALL — zero minutes in the whole week. The feature cannot work.
 *   That is a blocker.
 *
 *   DAYS WITH NO WINDOW — works at weekends, never on a Tuesday night. The
 *   feature does work, and a candidate texting on the wrong evening is still
 *   never answered. That is worth saying and is NOT a blocker.
 *
 * Conflating those two is the mistake this file was written around: the obvious
 * "Mon–Fri 08:00–21:00 with quiet hours from 21:00" leaves every WEEKDAY empty
 * and the weekend open, which is a real problem and not a broken feature.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { effectiveReachability } = require('../lib/recruiting/reachability');
const { afterReadyState, afterHoursReadiness } = (() => {
  const r = require('../lib/recruiting/readiness');
  return { afterHoursReadiness: r.afterHoursReadiness, afterReadyState: null };
})();

const QUIET = { quietStartLocal: '21:00', quietEndLocal: '08:00' };
const win = (days, start, end) => ({ days, start, end });

// ── the sweep ──────────────────────────────────────────────────────────────

test('working hours and quiet hours covering the week leave nothing reachable', () => {
  const r = effectiveReachability({ windows: [win([1, 2, 3, 4, 5, 6, 7], '08:00', '21:00')], ...QUIET });
  assert.equal(r.reachable, false);
  assert.equal(r.minutesPerWeek, 0);
  assert.equal(r.conflict, 'working_hours_and_quiet_hours_cover_the_week');
  assert.match(r.summary, /no moment in the week/i);
});

test('an all-day window every day leaves nothing reachable', () => {
  const r = effectiveReachability({ windows: [win([1, 2, 3, 4, 5, 6, 7], '00:00', '00:00')], ...QUIET });
  assert.equal(r.reachable, false, 'start == end is a full day, not a zero-length window');
});

/**
 * NO WINDOWS IS NOT "ALWAYS CLOSED", and getting this backwards is how a second
 * implementation of a rule starts. `evaluateHours` returns OPEN for an
 * unconfigured schedule on purpose, so the after-hours turn never arrives. The
 * first draft of the sweep read "no window covers this minute" as "the office is
 * shut" and scored an empty schedule at 5 460 reachable minutes a week — a
 * confident, precise, completely wrong number.
 */
test('NO WORKING HOURS MEANS THE OFFICE NEVER CLOSES, so nothing is reachable', () => {
  const r = effectiveReachability({ windows: [], ...QUIET });
  assert.equal(r.reachable, false);
  assert.equal(r.minutesPerWeek, 0);
  assert.equal(r.conflict, 'no_working_hours');
  assert.match(r.summary, /never counts as closed/i);
});

test('an ordinary schedule leaves a real window, and names when', () => {
  const r = effectiveReachability({ windows: [win([1, 2, 3, 4, 5], '08:00', '17:00')], ...QUIET });
  assert.equal(r.reachable, true);
  assert.equal(r.minutesPerWeek, 2760, '4h each weekday evening + 13h each weekend day');
  assert.deepEqual(r.zeroDays, []);
  assert.match(r.summary, /46 hours a week/);
});

/** The case that looks fine and is not: reachable overall, dead on weekdays. */
test('weekday evenings can be entirely unreachable while the week is not', () => {
  const r = effectiveReachability({ windows: [win([1, 2, 3, 4, 5], '08:00', '21:00')], ...QUIET });
  assert.equal(r.reachable, true, 'the weekends are still open');
  assert.deepEqual(r.zeroDays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
});

test('the sweep asks the same coverage rule the live path asks', () => {
  // An overnight window belongs to the day it STARTS — Fri 22:00-06:00 covers
  // Saturday's small hours. If the sweep re-implemented that it would drift.
  const r = effectiveReachability({ windows: [win([5], '22:00', '06:00')], quietStartLocal: '00:00', quietEndLocal: '00:00' });
  const sat = r.byDay.find((d) => d.day === 'Sat');
  assert.equal(sat.minutes, 24 * 60 - 6 * 60, 'Saturday loses its first six hours to Friday night');
});

// ── readiness ──────────────────────────────────────────────────────────────

const READY = {
  afterHoursEnabled: true, hoursConfigured: true, approvedStatements: 5,
  capabilityEnabled: true, aiProviderEnabled: true, recruitersWithSms: 2,
};

test('A SCHEDULE NOBODY CAN BE ANSWERED IN IS NOT READY', () => {
  const verdict = afterHoursReadiness({
    ...READY,
    schedule: { windows: [win([1, 2, 3, 4, 5, 6, 7], '08:00', '21:00')], ...QUIET },
  });
  assert.equal(verdict.ready, false, 'every other check passes; this is the only one that can see it');
  assert.deepEqual(verdict.blockers.map((b) => b.key), ['no_reachable_window']);
  assert.match(verdict.blockers[0].what, /no moment in the week/i);
  assert.match(verdict.blockers[0].where, /Working hours/);
});

test('a workable schedule stays ready, and reports the gap it found', () => {
  const verdict = afterHoursReadiness({
    ...READY, schedule: { windows: [win([1, 2, 3, 4, 5], '08:00', '17:00')], ...QUIET },
  });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.reachability.minutesPerWeek, 2760);
});

test('days nobody can be answered on are reported WITHOUT blocking', () => {
  const verdict = afterHoursReadiness({
    ...READY, schedule: { windows: [win([1, 2, 3, 4, 5], '08:00', '21:00')], ...QUIET },
  });
  assert.equal(verdict.ready, true, 'the weekends work, so the feature is not broken');
  assert.deepEqual(verdict.unreachableDays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    'and a candidate texting on a Tuesday night is still never answered');
});

/** A caller that has not wired the schedule loses the ANSWER, never gains a false blocker. */
test('no schedule supplied means no reachability verdict, not a failure', () => {
  const verdict = afterHoursReadiness(READY);
  assert.equal(verdict.ready, true);
  assert.equal(verdict.reachability, null);
  assert.deepEqual(verdict.unreachableDays, []);
});
