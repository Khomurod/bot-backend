/**
 * How long a provider stays out of rotation. PURE.
 *
 * The failures these pin are the ones that cost money or availability:
 *
 *   Cooling a spent free tier for 30 seconds means hammering a provider that
 *   already said no, for the rest of the day.
 *
 *   Cooling it for a week means throwing away hours of an allowance nobody paid
 *   for.
 *
 *   Cooling a dead credential on a timer means a provider silently returning to
 *   rotation to fail identically, forever.
 *
 *   And a `freeOnly` mode that is a preference rather than a filter guarantees
 *   nothing at all, which is the opposite of what an operator turned it on for.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { FAILURE } = require('../lib/ai/classify');
const {
  INDEFINITE, cooldownFor, isAvailable, unavailableReason, eligibleProviders, nextUtcMidnight,
} = require('../lib/ai/cooldown');

const NOW = Date.parse('2026-09-09T15:30:00Z');

// ─── duration by class ───────────────────────────────────────────────────────

test('a dead credential is indefinite, not a long timer', () => {
  const { until, reason } = cooldownFor({ kind: FAILURE.CREDENTIAL, now: NOW });

  assert.equal(until, INDEFINITE,
    'no elapsed time makes an expired key work; only a person does');
  assert.match(reason, /administrator/);
});

test('a spent allowance with no stated reset waits for the next UTC day', () => {
  const { until, reason } = cooldownFor({ kind: FAILURE.QUOTA, now: NOW });

  assert.equal(until, Date.parse('2026-09-10T00:00:00Z'));
  assert.match(reason, /UTC day/);
});

test('...but a provider that names its own reset is believed', () => {
  const { until } = cooldownFor({ kind: FAILURE.QUOTA, retryAfterMs: 90_000, now: NOW });
  assert.equal(until, NOW + 90_000);
});

test('a provider cannot claim a week', () => {
  const { until } = cooldownFor({
    kind: FAILURE.QUOTA, retryAfterMs: 7 * 24 * 3600 * 1000, now: NOW,
  });
  assert.equal(until, NOW + 24 * 3600 * 1000, 'capped at a day');
});

test('transient backoff climbs and then holds', () => {
  const waits = [1, 2, 3, 4, 9].map(
    (n) => cooldownFor({ kind: FAILURE.TRANSIENT, consecutiveFailures: n, now: NOW }).until - NOW
  );

  assert.deepEqual(waits, [30_000, 60_000, 180_000, 300_000, 300_000]);
});

test('a transient failure that asked for longer gets it', () => {
  const { until } = cooldownFor({
    kind: FAILURE.TRANSIENT, consecutiveFailures: 1, retryAfterMs: 120_000, now: NOW,
  });
  assert.equal(until - NOW, 120_000, 'the ladder is a floor, not a ceiling');
});

test('our own bad request cools nobody', () => {
  for (const kind of [FAILURE.FATAL_REQUEST, FAILURE.INVALID_RESPONSE, FAILURE.UNKNOWN]) {
    assert.equal(cooldownFor({ kind, now: NOW }).until, null, kind);
  }
});

test('the UTC boundary is the next day, not 24 hours out', () => {
  assert.equal(nextUtcMidnight(Date.parse('2026-09-09T23:59:00Z')),
    Date.parse('2026-09-10T00:00:00Z'));
  assert.equal(nextUtcMidnight(Date.parse('2026-12-31T12:00:00Z')),
    Date.parse('2027-01-01T00:00:00Z'));
});

// ─── availability ────────────────────────────────────────────────────────────

const provider = (over = {}) => ({
  providerKey: 'groq', enabled: true, isFree: true, priority: 1, cooledUntil: null, ...over,
});

test('the three unavailable states are distinguishable, because they need different words', () => {
  assert.equal(unavailableReason(provider({ enabled: false }), NOW), 'Turned off by an administrator.');
  assert.match(
    unavailableReason(provider({ cooledUntil: INDEFINITE, cooldownReason: 'Key rejected.' }), NOW),
    /Key rejected/
  );
  assert.match(
    unavailableReason(provider({ cooledUntil: NOW + 45_000, cooldownReason: 'Busy' }), NOW),
    /45s remaining/
  );
  assert.equal(unavailableReason(provider(), NOW), null, 'available says nothing');
});

test('a cooldown that has passed is over', () => {
  assert.equal(isAvailable(provider({ cooledUntil: NOW - 1 }), NOW), true);
  assert.equal(isAvailable(provider({ cooledUntil: NOW + 1 }), NOW), false);
});

test('an unreadable cooldown must not strand a provider forever', () => {
  assert.equal(isAvailable(provider({ cooledUntil: 'not a date' }), NOW), true,
    'a corrupt value should degrade to available, not to permanently offline');
});

test('a Date and an ISO string mean the same thing', () => {
  assert.equal(isAvailable(provider({ cooledUntil: new Date(NOW + 60_000) }), NOW), false);
  assert.equal(isAvailable(provider({ cooledUntil: new Date(NOW + 60_000).toISOString() }), NOW), false);
});

// ─── ordering ────────────────────────────────────────────────────────────────

test('priority decides the order, and 1 goes first', () => {
  const list = eligibleProviders([
    provider({ providerKey: 'c', priority: 3 }),
    provider({ providerKey: 'a', priority: 1 }),
    provider({ providerKey: 'b', priority: 2 }),
  ], { now: NOW });

  assert.deepEqual(list.map((p) => p.providerKey), ['a', 'b', 'c']);
});

test('a cooled or disabled provider is simply not in the list', () => {
  const list = eligibleProviders([
    provider({ providerKey: 'a', priority: 1, cooledUntil: NOW + 60_000 }),
    provider({ providerKey: 'b', priority: 2, enabled: false }),
    provider({ providerKey: 'c', priority: 3 }),
  ], { now: NOW });

  assert.deepEqual(list.map((p) => p.providerKey), ['c']);
});

test('free-only is a filter, not a preference', () => {
  const list = eligibleProviders([
    provider({ providerKey: 'paid', priority: 1, isFree: false }),
    provider({ providerKey: 'free', priority: 2, isFree: true }),
  ], { now: NOW, freeOnly: true });

  assert.deepEqual(list.map((p) => p.providerKey), ['free'],
    'an operator turned this on to GUARANTEE no paid call; a preference guarantees nothing');
});

test('round-robin rotates the same order rather than shuffling it', () => {
  const providers = [
    provider({ providerKey: 'a', priority: 1 }),
    provider({ providerKey: 'b', priority: 2 }),
    provider({ providerKey: 'c', priority: 3 }),
  ];
  const at = (rotation) => eligibleProviders(providers, { now: NOW, roundRobin: true, rotation })
    .map((p) => p.providerKey);

  assert.deepEqual(at(0), ['a', 'b', 'c']);
  assert.deepEqual(at(1), ['b', 'c', 'a']);
  assert.deepEqual(at(2), ['c', 'a', 'b']);
  assert.deepEqual(at(3), ['a', 'b', 'c'], 'wraps');
  assert.deepEqual(at(-1), ['c', 'a', 'b'], 'a negative rotation must not produce an empty list');
});

test('round-robin with one provider is just that provider', () => {
  const list = eligibleProviders([provider({ providerKey: 'only' })],
    { now: NOW, roundRobin: true, rotation: 7 });
  assert.deepEqual(list.map((p) => p.providerKey), ['only']);
});

test('an empty roster is an empty list, never a crash', () => {
  assert.deepEqual(eligibleProviders([], { now: NOW }), []);
  assert.deepEqual(eligibleProviders(null, { now: NOW }), []);
  assert.deepEqual(eligibleProviders(undefined, { now: NOW, roundRobin: true, rotation: 3 }), []);
});
