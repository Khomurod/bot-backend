/**
 * Pairing lifecycle rules that need a clock: code expiry, code burning, session
 * idle expiry, and eviction. Every entry point takes an explicit `now`, so this
 * suite moves time forward by argument rather than by waiting or faking timers.
 *
 * The over-the-wire behaviour is covered by tests/qbqRemoteControl.test.js.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sessions = require('../services/qbq/remoteSessions');

const T0 = 1_800_000_000_000;

test.beforeEach(() => sessions.__resetForTests());

test('a pairing code is six characters from an unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    sessions.__resetForTests();
    const { code } = sessions.createSession(T0);
    assert.equal(code.length, sessions.CODE_LENGTH);
    // 0/O and 1/I/L are excluded: this gets read aloud and typed on a phone.
    assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/, code);
  }
});

test('a code expires, and an expired code cannot pair', () => {
  const session = sessions.createSession(T0);
  const justBefore = T0 + sessions.CODE_TTL_MS - 1000;
  const justAfter = T0 + sessions.CODE_TTL_MS + 1000;

  assert.throws(() => sessions.pair(session.code, justAfter), /not valid/);

  // A fresh session proves the same code would have worked before the TTL.
  sessions.__resetForTests();
  const other = sessions.createSession(T0);
  assert.ok(sessions.pair(other.code, justBefore).remoteToken);
});

test('a code is consumed on the first successful pair', () => {
  const session = sessions.createSession(T0);
  assert.ok(sessions.pair(session.code, T0 + 1000).remoteToken);
  assert.throws(() => sessions.pair(session.code, T0 + 2000), /not valid/);
});

test('wrong guesses are refused without ever affecting the presenter live code', () => {
  const session = sessions.createSession(T0);
  // A stranger grinding at codes must NOT be able to knock out a real
  // presenter's pairing mid-talk. Guessing is stopped by entropy, the 5-minute
  // TTL and the route layer's per-IP limit — never by penalizing a session the
  // attacker never actually identified.
  const guesses = ['AAAAAA', 'BBBBBB', '234567', 'ZZZZZZ', 'HJKMNP', 'QRSTUV', '999999'];
  for (const guess of guesses) {
    if (guess === session.code) continue;
    assert.throws(() => sessions.pair(guess, T0 + 1000), /not valid/);
  }
  assert.ok(
    sessions.pair(session.code, T0 + 2000).remoteToken,
    'the presenter code must still work after strangers guessed wrongly',
  );
});

test('a malformed code is refused without a lookup', () => {
  sessions.createSession(T0);
  for (const bad of ['', 'ABC', 'TOOLONGCODE', null, undefined, 42, {}]) {
    assert.throws(() => sessions.pair(bad, T0 + 1000), /not valid/);
  }
});

test('codes are accepted as read aloud — lower case, spaces and dashes', () => {
  const session = sessions.createSession(T0);
  const spoken = session.code.toLowerCase().split('').join(' ');
  assert.ok(sessions.pair(spoken, T0 + 1000).remoteToken, `"${spoken}" should pair`);
});

test('issuing a new code invalidates the previous one', () => {
  const session = sessions.createSession(T0);
  const first = session.code;
  const second = sessions.issueCode(session.presenterToken, T0 + 1000).code;
  assert.notEqual(first, second);
  assert.throws(() => sessions.pair(first, T0 + 2000), /not valid/);
  assert.ok(sessions.pair(second, T0 + 2000).remoteToken);
});

test('an idle session expires and its tokens stop working', () => {
  const session = sessions.createSession(T0);
  const paired = sessions.pair(session.code, T0 + 1000);
  const afterIdle = T0 + sessions.SESSION_IDLE_TTL_MS + 60_000;

  assert.equal(sessions.authenticate(paired.remoteToken, afterIdle), null);
  assert.equal(sessions.authenticate(session.presenterToken, afterIdle), null);
  assert.throws(
    () => sessions.submitCommand(paired.remoteToken, { action: 'next', seq: 1 }, afterIdle),
    /not active/,
  );
});

test('activity keeps a session alive past the idle window', () => {
  const session = sessions.createSession(T0);
  const paired = sessions.pair(session.code, T0 + 1000);

  // Tap once every hour for eight hours — well past the 6h idle TTL, but never
  // idle for 6h at a stretch.
  let now = T0 + 1000;
  for (let hour = 1; hour <= 8; hour++) {
    now = T0 + hour * 60 * 60 * 1000;
    const result = sessions.submitCommand(paired.remoteToken, { action: 'next', seq: hour }, now);
    assert.equal(result.applied, true, `hour ${hour}`);
  }
});

test('re-pairing replaces the previous remote outright', () => {
  const session = sessions.createSession(T0);
  const first = sessions.pair(session.code, T0 + 1000);
  const second = sessions.pair(
    sessions.issueCode(session.presenterToken, T0 + 2000).code,
    T0 + 3000,
  );

  assert.notEqual(first.remoteToken, second.remoteToken);
  assert.equal(sessions.authenticate(first.remoteToken, T0 + 4000), null,
    'a handed-off phone must not keep control');
  assert.ok(sessions.authenticate(second.remoteToken, T0 + 4000));
});

test('the sequence counter resets for a newly paired remote', () => {
  const session = sessions.createSession(T0);
  const first = sessions.pair(session.code, T0 + 1000);
  for (let seq = 1; seq <= 5; seq++) {
    sessions.submitCommand(first.remoteToken, { action: 'next', seq }, T0 + 1000 + seq);
  }

  const second = sessions.pair(
    sessions.issueCode(session.presenterToken, T0 + 2000).code,
    T0 + 3000,
  );
  // A new phone starts its own counter at 1 and must not be treated as stale.
  const result = sessions.submitCommand(second.remoteToken, { action: 'next', seq: 1 }, T0 + 4000);
  assert.equal(result.applied, true);
});

test('presenter state is clamped to sane values before it reaches a remote', () => {
  const session = sessions.createSession(T0);
  const state = sessions.updateState(session.presenterToken, {
    slide: -5, total: 28.9, zoom: 99,
  }, T0 + 1000);
  assert.equal(state.slide, 0, 'a negative slide is floored');
  assert.equal(state.total, 28, 'a fractional total is truncated');
  assert.ok(state.zoom <= 4, 'an absurd zoom is capped');

  const ignored = sessions.updateState(session.presenterToken, { slide: 'x', zoom: null }, T0 + 2000);
  assert.equal(ignored.slide, 0, 'garbage is ignored rather than stored');
});

test('a remote token cannot push state and a presenter token cannot send commands', () => {
  const session = sessions.createSession(T0);
  const paired = sessions.pair(session.code, T0 + 1000);

  assert.throws(
    () => sessions.updateState(paired.remoteToken, { slide: 9 }, T0 + 2000),
    (err) => err.code === 'WRONG_ROLE' && err.status === 403,
  );
  assert.throws(
    () => sessions.submitCommand(session.presenterToken, { action: 'next', seq: 1 }, T0 + 2000),
    (err) => err.code === 'WRONG_ROLE' && err.status === 403,
  );
});

test('the session map is bounded, evicting the least recently active', () => {
  const first = sessions.createSession(T0);
  for (let i = 1; i <= sessions.MAX_SESSIONS; i++) {
    sessions.createSession(T0 + i * 1000);
  }
  assert.equal(sessions.authenticate(first.presenterToken, T0 + 1000), null,
    'the oldest session is evicted rather than growing the map without bound');
});

test('subscribers only receive events for their own role', () => {
  const session = sessions.createSession(T0);
  const paired = sessions.pair(session.code, T0 + 1000);

  const toPresenter = [];
  const toRemote = [];
  sessions.subscribe(session.presenterToken, (e) => toPresenter.push(e), T0 + 2000);
  sessions.subscribe(paired.remoteToken, (e) => toRemote.push(e), T0 + 2000);

  sessions.submitCommand(paired.remoteToken, { action: 'next', seq: 1 }, T0 + 3000);
  sessions.updateState(session.presenterToken, { slide: 1, total: 28 }, T0 + 4000);

  assert.equal(toPresenter.filter((e) => e.type === 'command').length, 1);
  assert.equal(toRemote.filter((e) => e.type === 'command').length, 0,
    'a remote must never be told about its own command as if it were the deck');
  assert.equal(toRemote.filter((e) => e.type === 'state').length, 1);
});

test('a listener that throws cannot stop a command reaching the deck', () => {
  const session = sessions.createSession(T0);
  const paired = sessions.pair(session.code, T0 + 1000);
  const delivered = [];
  sessions.subscribe(session.presenterToken, () => { throw new Error('broken stream'); }, T0 + 2000);
  sessions.subscribe(session.presenterToken, (e) => delivered.push(e), T0 + 2000);

  const result = sessions.submitCommand(paired.remoteToken, { action: 'next', seq: 1 }, T0 + 3000);
  assert.equal(result.applied, true);
  assert.equal(delivered.filter((e) => e.type === 'command').length, 1);
});
