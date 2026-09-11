/**
 * A model reading a chat TITLE cannot see whether a driver is working.
 *
 * `groups.active` is written from that title twice a day, for 168 of 209 groups.
 * Deactivating a working driver drops them out of Live Locations, BOL/POD
 * document routing, the dispatch roster and home-time tracking — and a renamed
 * chat or an unfamiliar spelling is enough to do it.
 *
 * These are the records that overrule the title.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { mayDeactivate, describeRefusal, DEFAULTS } = require('../lib/drivers/deactivationGuard');

const NOW = Date.parse('2026-09-20T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

test('a driver whose chat spoke this week is not deactivated', () => {
  const r = mayDeactivate({ lastMessageSeenAt: daysAgo(3) }, { now: NOW });
  assert.equal(r.allowed, false);
  assert.match(r.reasons[0], /message 3 day/);
});

test('a driver with an open home-time cycle is not deactivated', () => {
  assert.equal(mayDeactivate({ openHomeCycle: true }, { now: NOW }).allowed, false);
});

test('a driver working a load right now is not deactivated', () => {
  assert.equal(mayDeactivate({ hasActiveLoad: true }, { now: NOW }).allowed, false);
});

test('a driver with a truck assigned to them is not deactivated', () => {
  assert.equal(mayDeactivate({ openUnitAt: daysAgo(10) }, { now: NOW }).allowed, false);
});

test('home-time tracking having seen them recently is enough on its own', () => {
  assert.equal(mayDeactivate({ homeStatusAt: daysAgo(5) }, { now: NOW }).allowed, false);
});

test('a finished road leg counts, because a driver who just came home still works here', () => {
  assert.equal(mayDeactivate({ lastRoadHistoryAt: daysAgo(9) }, { now: NOW }).allowed, false);
});

test('every reason is listed, so the log says why rather than merely that', () => {
  const r = mayDeactivate({
    lastMessageSeenAt: daysAgo(2), openHomeCycle: true, hasActiveLoad: true,
  }, { now: NOW });
  assert.equal(r.reasons.length, 3);
  const sentence = describeRefusal('JOHN DOE (Unit 7)', r.reasons);
  assert.match(sentence, /^JOHN DOE \(Unit 7\) was NOT deactivated: /);
  assert.match(sentence, /open home-time cycle/);
});

test('silence is NOT evidence of leaving, so a quiet driver is not protected here', () => {
  // A genuinely departed driver goes quiet. Protecting silence would make the
  // classifier unable to ever deactivate anyone; `identity.silent_active_group`
  // is where a merely quiet driver is raised for a person.
  const r = mayDeactivate({
    lastMessageSeenAt: daysAgo(200),
    homeStatusAt: daysAgo(200),
    lastRoadHistoryAt: daysAgo(300),
    openUnitAt: daysAgo(400),
  }, { now: NOW });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.reasons, []);
});

test('nothing known at all does not block a deactivation', () => {
  assert.equal(mayDeactivate({}, { now: NOW }).allowed, true);
});

test('an unparseable timestamp is ignored rather than treated as recent', () => {
  assert.equal(mayDeactivate({ lastMessageSeenAt: 'not a date' }, { now: NOW }).allowed, true);
});

test('the windows are settings, not magic numbers', () => {
  const signals = { lastMessageSeenAt: daysAgo(30) };
  assert.equal(mayDeactivate(signals, { now: NOW }).allowed, true, `default is ${DEFAULTS.messageDays} days`);
  assert.equal(mayDeactivate(signals, { now: NOW, options: { messageDays: 60 } }).allowed, false);
});
