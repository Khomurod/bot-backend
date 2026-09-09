/**
 * A parsed window has to survive POLICY, not just the calendar.
 *
 * `isReasonableWindow` asks whether two dates are plausible — valid, in order,
 * not in the past, inside a year. Production shows that is not enough. Request
 * 132 stored `home_from 2026-08-15 → home_to 2026-09-14`: a **thirty-day home
 * stay** against a four-day allowance, still `pending`. Request 139 stored a
 * `home_from` of `2027-01-02`. Both passed every check the code had, because
 * nothing compared them to the settings the whole feature is configured by.
 *
 * The point is NOT to reject the driver. It is to stop silently persisting a
 * number nobody agreed to and calling it a request: an out-of-policy answer is a
 * clarification, and this says which half of it to ask about again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyWindowAgainstPolicy } = require('../services/homeTimeDateResolver');

const REF = '2026-08-15';
const opts = (over = {}) => ({
  referenceIso: REF, homeAllowanceDays: 4, maxFutureDays: 120, ...over,
});

test('a window inside the allowance is accepted', () => {
  const v = classifyWindowAgainstPolicy('2026-08-15', '2026-08-19', opts());
  assert.equal(v.ok, true);
  assert.equal(v.reason, null);
  assert.equal(v.days, 4, 'home days are start→return exclusive of the return day');
});

test('exactly the allowance is inside it', () => {
  assert.equal(classifyWindowAgainstPolicy('2026-08-15', '2026-08-19', opts()).ok, true);
});

test('request 132 — a thirty-day stay against a four-day allowance', () => {
  const v = classifyWindowAgainstPolicy('2026-08-15', '2026-09-14', opts());
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'too_long');
  assert.equal(v.days, 30);
  assert.equal(v.allowanceDays, 4);
  assert.equal(v.disputedField, 'return_to_road',
    'the START is fine; it is the return date that has to be asked about again');
});

test('request 139 — a home start in January of next year', () => {
  const v = classifyWindowAgainstPolicy('2027-01-02', '2027-01-05', opts());
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'too_far_ahead');
  assert.equal(v.disputedField, 'home_start');
  assert.equal(v.maxFutureDays, 120);
});

test('too long AND too far ahead reports the START first', () => {
  // Asking about a return date whose start is nonsense wastes the driver's turn.
  const v = classifyWindowAgainstPolicy('2027-01-02', '2027-03-02', opts());
  assert.equal(v.reason, 'too_far_ahead');
  assert.equal(v.disputedField, 'home_start');
});

test('a calendar-invalid window is rejected as invalid, not as a policy breach', () => {
  // The distinction matters: 'invalid' is a parse that failed, 'too_long' is a
  // driver who asked for something the company does not grant. They deserve
  // different answers.
  for (const [from, to] of [['nonsense', '2026-08-19'], ['2026-08-19', '2026-08-15'],
    ['2026-08-19', '2026-08-19'], ['2020-01-01', '2020-01-05']]) {
    const v = classifyWindowAgainstPolicy(from, to, opts());
    assert.equal(v.ok, false, `${from} → ${to}`);
    assert.equal(v.reason, 'invalid', `${from} → ${to}`);
    assert.equal(v.disputedField, null);
  }
});

test('a missing or nonsensical allowance does not become a licence', () => {
  // A settings row with a NULL or zero allowance must not make every window
  // legal; the code-side default of 4 is the same one the rest of the subsystem
  // falls back to.
  for (const allowance of [null, undefined, 0, -3, 'x']) {
    const v = classifyWindowAgainstPolicy('2026-08-15', '2026-09-14',
      opts({ homeAllowanceDays: allowance }));
    assert.equal(v.ok, false, `allowance ${allowance}`);
    assert.equal(v.allowanceDays, 4);
  }
});

test('an operator who raises the allowance is obeyed', () => {
  const v = classifyWindowAgainstPolicy('2026-08-15', '2026-09-14',
    opts({ homeAllowanceDays: 30 }));
  assert.equal(v.ok, true, 'the numbers are settings, not constants');
});

test('a grace day is allowed on the start, as the calendar check already does', () => {
  assert.equal(classifyWindowAgainstPolicy('2026-08-14', '2026-08-17', opts()).ok, true);
});

// ─── what the first version of this missed ───────────────────────────────────

test('a far-ahead window disputes BOTH dates, not just the start', () => {
  // Clearing only the start left the equally far-future return in place. The
  // driver answers with a corrected near-term start, the resolver merges it with
  // the stale return, and the result is a `too_long` window — which this design
  // deliberately accepts. The mis-parsed year would have survived the very
  // clarification that existed to catch it.
  //
  // Both ends are safe to clear because `too_far_ahead` implies it: the return
  // is always on or after the start, and a return BEFORE the start is already
  // rejected as `invalid`. So a far-out start means a far-out return too.
  const v = classifyWindowAgainstPolicy('2027-01-02', '2027-01-05', opts());
  assert.equal(v.reason, 'too_far_ahead');
  assert.deepEqual(v.disputedFields, ['home_start', 'return_to_road']);
});

test('an over-allowance window disputes only the return', () => {
  const v = classifyWindowAgainstPolicy('2026-08-15', '2026-09-14', opts());
  assert.deepEqual(v.disputedFields, ['return_to_road']);
});

test('an accepted window disputes nothing', () => {
  assert.deepEqual(classifyWindowAgainstPolicy('2026-08-15', '2026-08-19', opts()).disputedFields, []);
});

test('a PARTIAL window with only a far-ahead start is still caught', () => {
  // `windowFieldToReask` returned null for anything incomplete, so a driver who
  // gave only "home 2027-01-02" had it persisted by `createClarification`, which
  // then asked politely for the return date — with the mis-parsed year already
  // written down.
  const v = classifyWindowAgainstPolicy('2027-01-02', null, opts());
  assert.equal(v.reason, 'too_far_ahead');
  assert.deepEqual(v.disputedFields, ['home_start']);
});

test('a partial window with a near-term start is fine', () => {
  const v = classifyWindowAgainstPolicy('2026-08-20', null, opts());
  assert.equal(v.ok, true);
  assert.deepEqual(v.disputedFields, []);
});

test('a partial window with only a return date is not judged on a missing start', () => {
  const v = classifyWindowAgainstPolicy(null, '2026-08-20', opts());
  assert.equal(v.ok, true);
});
