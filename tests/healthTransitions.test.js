'use strict';

/**
 * When a subsystem's health is worth telling somebody about.
 *
 * The property this file exists to hold is a NEGATIVE one: silence. Wenze has
 * always recovered from most of its own integration failures — token refresh,
 * provider cooldowns, outbox backoff — and a naive "announce every recovery"
 * would turn that into a stream nobody reads, at which point the one outage
 * that needed a person is in it and invisible.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { observe, describeDuration, initialState } = require('../lib/operations/healthTransitions');

const OPTS = { failuresBeforeAlert: 3, flapWindowHours: 6, flapThreshold: 4 };
const at = (mins) => new Date(Date.parse('2026-09-11T00:00:00Z') + mins * 60000).toISOString();

/** Feed a sequence of observations, collecting whatever was announced. */
function run(sequence, options = OPTS) {
  let state = null;
  const announced = [];
  sequence.forEach(([ok, mins, detail]) => {
    const out = observe(state, { ok, detail, component: 'ringcentral' }, { ...options, now: at(mins) });
    state = out.state;
    if (out.announce) announced.push({ ...out.announce, at: at(mins) });
  });
  return { state, announced };
}

test('a healthy component announces nothing, ever', () => {
  const { announced, state } = run([[true, 0], [true, 15], [true, 30]]);
  assert.deepEqual(announced, []);
  assert.equal(state.status, 'ok');
});

test('one failure says nothing — integrations blip', () => {
  const { announced } = run([[true, 0], [false, 15, '503'], [true, 30]]);
  assert.deepEqual(announced, [], 'a blip is not an outage');
});

test('A BLIP THAT SELF-CORRECTS PRODUCES ZERO MESSAGES, NOT ONE', () => {
  // The rule that keeps the channel readable. Two failures then a recovery is
  // Wenze working, and "Wenze fixed itself" about something nobody was told
  // was broken is how a channel becomes unread.
  const { announced } = run([[true, 0], [false, 15], [false, 30], [true, 45]]);
  assert.deepEqual(announced, []);
});

test('a real outage is announced once, not on every tick', () => {
  const { announced } = run([
    [true, 0], [false, 15, 'invalid_grant'], [false, 30], [false, 45],
    [false, 60], [false, 75], [false, 90],
  ]);
  assert.equal(announced.length, 1);
  assert.equal(announced[0].kind, 'broke');
  assert.equal(announced[0].detail, 'invalid_grant', 'the first error is the one that explains it');
});

test('recovery is announced only to people who heard about the failure', () => {
  const { announced } = run([
    [true, 0], [false, 15, 'invalid_grant'], [false, 30], [false, 45], [true, 60],
  ]);
  assert.deepEqual(announced.map((a) => a.kind), ['broke', 'healed']);
  assert.match(describeDuration(announced[1].downForMs), /minute/);
});

test('a component that recovers and breaks again does not re-announce the same state', () => {
  const { announced } = run([
    [true, 0],
    [false, 15], [false, 30], [false, 45],   // broke
    [true, 60],                              // healed
    [false, 75], [false, 90], [false, 105],  // broke again
  ]);
  assert.deepEqual(announced.map((a) => a.kind), ['broke', 'healed', 'broke']);
});

test('a component that cannot stay up is ONE problem, announced once', () => {
  // Four transitions inside the window. Past that it is flapping, and a
  // commentary on each recovery helps nobody.
  const { announced } = run([
    [true, 0],
    [false, 10], [false, 20], [false, 30],
    [true, 40],
    [false, 50], [false, 60], [false, 70],
    [true, 80],
    [false, 90], [false, 100], [false, 110],
    [true, 120],
    [false, 130], [false, 140],
  ]);
  const kinds = announced.map((a) => a.kind);
  assert.equal(kinds.filter((k) => k === 'flapping').length, 1, 'flapping is said once');
  assert.ok(kinds.indexOf('flapping') > 0, 'and only after it has actually flapped');
  // After the flapping notice, nothing more while it lasts.
  const afterFlap = kinds.slice(kinds.indexOf('flapping') + 1);
  assert.deepEqual(afterFlap, [], 'no further commentary while it flaps');
});

test('a settled component may speak again once the flap window has emptied', () => {
  const flapped = run([
    [true, 0],
    [false, 10], [false, 20], [false, 30], [true, 40],
    [false, 50], [false, 60], [false, 70], [true, 80],
    [false, 90], [false, 100], [false, 110], [true, 120],
  ]);
  assert.ok(flapped.announced.some((a) => a.kind === 'flapping'));

  // Eight hours later, outside the six-hour window, a genuine outage speaks.
  let state = flapped.state;
  const announced = [];
  for (const mins of [600, 615, 630, 645]) {
    const out = observe(state, { ok: false, detail: 'gone' }, { ...OPTS, now: at(mins) });
    state = out.state;
    if (out.announce) announced.push(out.announce);
  }
  assert.equal(announced.length, 1);
  assert.equal(announced[0].kind, 'broke');
});

test('a first sighting that is already broken still needs the threshold', () => {
  const { announced } = run([[false, 0, 'down'], [false, 15], [false, 30]]);
  assert.deepEqual(announced.map((a) => a.kind), ['broke']);
});

test('the last error is cleared when the component comes back', () => {
  const { state } = run([
    [true, 0], [false, 15, 'invalid_grant'], [false, 30], [false, 45], [true, 60],
  ]);
  assert.equal(state.lastError, null, 'a stale error must not hang off a healthy component');
});

test('the transition list is bounded, so a long-lived row cannot grow forever', () => {
  const sequence = [];
  for (let i = 0; i < 60; i += 1) sequence.push([i % 2 === 0, i * 10]);
  const { state } = run(sequence, { ...OPTS, keepTransitions: 12 });
  assert.ok(state.transitions.length <= 12);
});

test('durations read as a sentence', () => {
  assert.equal(describeDuration(30 * 1000), 'under a minute');
  assert.equal(describeDuration(60 * 1000), '1 minute');
  assert.equal(describeDuration(45 * 60 * 1000), '45 minutes');
  assert.equal(describeDuration(3 * 3600 * 1000), '3 hours');
  assert.equal(describeDuration(3 * 86400 * 1000), '3 days');
  assert.equal(describeDuration(null), null);
});

test('an unobserved component has a state that reads as unknown, not as healthy', () => {
  const fresh = initialState('samsara');
  assert.equal(fresh.status, null, 'null is not "ok" — nothing has been checked yet');
  assert.equal(fresh.announcedStatus, null);
});

// ── switched off is not broken ───────────────────────────────────────────────

/**
 * THE INTENT THIS MODULE WAS LOSING.
 *
 * `runHealth.js` has always said a worker waiting on configuration "is NOT
 * broken, and painting it red is how a real outage gets lost among things that
 * were never switched on." Production disagreed: `/api/health` read
 * `systems: { failed: 3, down: [...] }` for three features nobody had switched
 * on, and each was three passes away from announcing itself as "not working".
 */
test('a component waiting on a setting is BLOCKED, never failed, and never announced', () => {
  let state = null;
  const announced = [];
  for (const mins of [0, 15, 30, 45, 60]) {
    const out = observe(
      state,
      { ok: false, blocked: true, detail: 'the Dispatcher Board is switched off in Settings', component: 'dispatch_board_poll' },
      { ...OPTS, now: at(mins) },
    );
    state = out.state;
    if (out.announce) announced.push(out.announce);
  }

  assert.equal(state.status, 'blocked');
  assert.equal(state.consecutiveFailures, 0, 'a switch nobody flipped starts no failure count');
  assert.deepEqual(announced, [], 'and nothing is ever said about it');
  assert.equal(state.lastError, 'the Dispatcher Board is switched off in Settings',
    'the reason is kept, because the workers block still names it');
});

/**
 * And switching a broken thing OFF is not a recovery. "Working again" about
 * something nobody switched back on would be a lie, so the announcement record
 * is cleared silently instead.
 */
test('switching a failed component off says nothing, and does not claim a recovery', () => {
  let state = null;
  const announced = [];
  for (const mins of [0, 15, 30]) {
    const out = observe(state, { ok: false, detail: 'boom', component: 'x' }, { ...OPTS, now: at(mins) });
    state = out.state;
    if (out.announce) announced.push(out.announce);
  }
  assert.equal(announced.length, 1, 'the real failure was announced');
  assert.equal(announced[0].kind, 'broke');

  const off = observe(state, { ok: false, blocked: true, detail: 'switched off', component: 'x' },
    { ...OPTS, now: at(45) });
  assert.equal(off.announce, null, 'turning it off is not a recovery');
  assert.equal(off.state.status, 'blocked');
  assert.equal(off.state.announcedStatus, null);
});

/** Coming back from blocked to working still announces nothing it never said. */
test('a blocked component that starts working says nothing either', () => {
  const blocked = observe(null, { ok: false, blocked: true, detail: 'off', component: 'x' },
    { ...OPTS, now: at(0) });
  const on = observe(blocked.state, { ok: true, component: 'x' }, { ...OPTS, now: at(15) });
  assert.equal(on.announce, null, 'Wenze never said it broke, so it does not say it healed');
  assert.equal(on.state.status, 'ok');
});
