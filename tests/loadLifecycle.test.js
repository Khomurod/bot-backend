/**
 * What a load is actually doing, derived from where the truck is.
 *
 * The premise under every test here: DISPATCH STATUS IS A PLAN. A load reads
 * `dispatched` the moment somebody assigns it, often days before the truck
 * moves, and frequently still reads `in_transit` long after delivery because
 * nobody went back to change it. Asking the board what a driver is doing
 * answers a different question from the one being asked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { PHASES, derivePhase, boardSays } = require('../lib/loads/lifecycle');

const NOW = '2026-09-20T18:00:00Z';
const at = (mins) => new Date(Date.parse(NOW) - mins * 60000).toISOString();

const SHIPPER = { lat: 41.88, lng: -87.63 };
const RECEIVER = { lat: 39.10, lng: -84.50 };
const MIDWAY = { lat: 40.50, lng: -86.00 };

const LOAD = {
  loadIdentifier: 'L1', status: 'dispatched',
  pickupLat: SHIPPER.lat, pickupLng: SHIPPER.lng,
  deliveryLat: RECEIVER.lat, deliveryLng: RECEIVER.lng,
};

const pos = (p, speedMph = 0, mins = 5) => ({ ...p, speedMph, at: at(mins) });
const run = (over = {}) => derivePhase({ nowIso: NOW, load: LOAD, ...over });

// ── the normal journey ───────────────────────────────────────────────────────

test('no load at all is empty, and says so with confidence', () => {
  const v = derivePhase({ nowIso: NOW, load: null });
  assert.equal(v.phase, PHASES.EMPTY);
  assert.equal(v.confidence, 'high');
});

test('parked at the shipper is at pickup', () => {
  const v = run({ position: pos(SHIPPER) });
  assert.equal(v.phase, PHASES.AT_PICKUP);
  assert.equal(v.confidence, 'high');
});

test('away from the shipper after being there is loaded and moving', () => {
  const v = run({ position: pos(MIDWAY, 62), remembered: { wasAtPickup: true } });
  assert.equal(v.phase, PHASES.IN_TRANSIT);
  assert.ok(v.signals.includes('left_pickup_after_arriving'));
});

test('parked at the receiver is at delivery', () => {
  const v = run({ position: pos(RECEIVER), remembered: { wasAtPickup: true } });
  assert.equal(v.phase, PHASES.AT_DELIVERY);
});

test('away from the receiver after being there is delivered', () => {
  const v = run({
    position: pos({ lat: 39.9, lng: -83.0 }, 58),
    remembered: { wasAtPickup: true, wasAtDelivery: true },
  });
  assert.equal(v.phase, PHASES.DELIVERED);
  assert.equal(v.confidence, 'high');
});

// ── arrival is observed, departure is remembered ─────────────────────────────

test('a truck far from the receiver that was never SEEN there is not delivered', () => {
  // The whole load could still be ahead of it. Without the arrival, "it is not
  // at the receiver" and "it has delivered" are the same observation.
  const v = run({ position: pos(MIDWAY, 60), remembered: { wasAtPickup: true } });
  assert.notEqual(v.phase, PHASES.DELIVERED);
  assert.equal(v.phase, PHASES.IN_TRANSIT);
});

test('a moving truck with no remembered pickup is going TO get the load, not carrying it', () => {
  const v = run({ position: pos(MIDWAY, 60), remembered: {} });
  assert.equal(v.phase, PHASES.HEADING_TO_PICKUP);
  assert.equal(v.confidence, 'medium', 'an unwitnessed pickup is worth a person looking');
});

test('the board CAN corroborate a pickup nobody watched', () => {
  const v = derivePhase({
    nowIso: NOW, load: { ...LOAD, status: 'in_transit' },
    position: pos(MIDWAY, 60), remembered: {},
  });
  assert.equal(v.phase, PHASES.IN_TRANSIT, 'two weak sources agreeing is stronger than one');
});

// ── the board is a plan, not an observation ──────────────────────────────────

test('a board running BEHIND the truck is normal and is not reported', () => {
  // Almost every delivered load still says "dispatched" on the board. Flagging
  // that would make this check pure noise.
  for (const [position, remembered] of [
    [pos(SHIPPER), {}],
    [pos(MIDWAY, 60), { wasAtPickup: true }],
    [pos(RECEIVER), { wasAtPickup: true }],
  ]) {
    const v = run({ position, remembered });
    assert.deepEqual(v.conflicts, [], `${v.phase} should not conflict with a lagging board`);
    assert.equal(v.confidence, 'high');
  }
});

test('a board running AHEAD of the truck IS reported — somebody recorded work that has not happened', () => {
  const v = derivePhase({
    nowIso: NOW, load: { ...LOAD, status: 'in_transit' }, position: pos(SHIPPER),
  });
  assert.equal(v.phase, PHASES.AT_PICKUP, 'the coordinates decide');
  assert.deepEqual(v.conflicts, ['board_says_loaded_but_the_truck_is_still_at_the_shipper']);
  assert.equal(v.confidence, 'medium', 'medium means a person looks — it does not move the state');
});

// ── a board ahead is not, by itself, a conflict ──────────────────────────────
//
// This was the first rule and production answered it: 75 of 235 loads came back
// "conflicted" — a third of the fleet — which is not a list anybody reads. A
// conflict now needs POSITIVE evidence that contradicts the board, and each of
// the three cases below is the absence of it.

test('a truck at the receiver with the board marked delivered is a delivery, not a disagreement', () => {
  const v = derivePhase({
    nowIso: NOW, load: { ...LOAD, status: 'delivered' },
    position: pos(RECEIVER), remembered: { wasAtPickup: true },
  });
  assert.equal(v.phase, PHASES.AT_DELIVERY);
  assert.deepEqual(v.conflicts, [],
    'the truck is physically at the receiver and the board says delivered — that '
    + 'is what a load that just delivered looks like');
});

test('a loaded truck parked mid-trip is not "still at the shipper"', () => {
  // Nowhere near either end, stopped, and nothing remembered because this
  // watcher did not exist when the load started.
  const v = derivePhase({
    nowIso: NOW, load: { ...LOAD, status: 'in_transit' },
    position: pos({ lat: 38, lng: -88.5 }, 0),
  });
  assert.deepEqual(v.conflicts, [],
    'trucks park; the old rule said "has not left the shipper" about a truck '
    + 'three hundred miles from it');
  assert.ok(v.signals.includes('board_ahead_of_what_has_been_observed'),
    'recorded as a signal, so the confidence stays honest without making it a question');
  assert.equal(v.confidence, 'medium');
});

test('a delivered load we started watching late is not evidence of anything', () => {
  const v = derivePhase({
    nowIso: NOW, load: { ...LOAD, status: 'delivered' },
    position: pos({ lat: 34, lng: -91 }, 62),
  });
  assert.deepEqual(v.conflicts, [],
    'nothing saw the arrival because nothing was watching — absence of memory '
    + 'is not evidence that the delivery did not happen');
});

test('with memory, a load that was never seen at the receiver IS a conflict', () => {
  const v = derivePhase({
    nowIso: NOW, load: { ...LOAD, status: 'delivered' },
    position: pos({ lat: 34, lng: -91 }, 62),
    remembered: { phase: PHASES.IN_TRANSIT, wasAtPickup: true, wasAtDelivery: false },
  });
  assert.deepEqual(v.conflicts, ['board_says_delivered_but_this_load_was_never_seen_at_the_receiver'],
    'we have been watching this one, it never reached the receiver, and the '
    + 'board says it is done');
});

test('a conflict never moves the phase — picking a side propagates the wrong status', () => {
  const v = derivePhase({
    nowIso: NOW, load: { ...LOAD, status: 'delivered' }, position: pos(SHIPPER),
  });
  assert.equal(v.phase, PHASES.AT_PICKUP, 'where the truck IS, not where the board wishes it were');
  assert.deepEqual(v.conflicts, ['board_says_delivered_but_the_truck_is_at_the_shipper'],
    'the strongest case in the set: a completed delivery recorded for a truck '
    + 'standing at the shipper');
});

// ── when the coordinates cannot answer ───────────────────────────────────────

test('stale GPS falls back to the board and says plainly that is what it did', () => {
  const v = derivePhase({
    nowIso: NOW, load: { ...LOAD, status: 'in_transit' }, position: pos(RECEIVER, 0, 300),
  });
  assert.equal(v.confidence, 'low');
  assert.ok(v.signals.includes('gps_stale'));
  assert.match(v.summary, /no fresh position/);
});

test('no GPS at all keeps the last known phase rather than resetting the load', () => {
  const v = run({ position: null, remembered: { phase: PHASES.IN_TRANSIT } });
  assert.equal(v.phase, PHASES.IN_TRANSIT);
  assert.equal(v.confidence, 'low');
  assert.ok(v.signals.includes('no_gps'));
});

test('a load with no stop coordinates can still be reported, at lower confidence', () => {
  const v = derivePhase({
    nowIso: NOW,
    load: { loadIdentifier: 'L9', status: 'dispatched' },
    position: pos(MIDWAY, 60),
  });
  assert.equal(v.confidence, 'medium');
  assert.equal(v.facts.hasPickupCoords, false);
});

test('a parked truck with no history is assigned, not invented into a phase', () => {
  const v = run({ position: pos(MIDWAY, 0) });
  assert.equal(v.phase, PHASES.ASSIGNED);
});

// ── the board reader ─────────────────────────────────────────────────────────

test('the board vocabulary maps only what it can actually mean', () => {
  assert.equal(boardSays('In Transit'), PHASES.IN_TRANSIT);
  assert.equal(boardSays('LOADED'), PHASES.IN_TRANSIT);
  assert.equal(boardSays('Delivered'), PHASES.DELIVERED);
  assert.equal(boardSays('completed'), PHASES.DELIVERED);
  assert.equal(boardSays('assigned'), PHASES.ASSIGNED);
  assert.equal(boardSays('dispatched'), PHASES.ASSIGNED);
  assert.equal(boardSays('something new'), null, 'an unknown word is not a guess');
  assert.equal(boardSays(null), null);
});

// ── the facts a person needs ─────────────────────────────────────────────────

test('the facts carry the distances and ages a person would ask for next', () => {
  const v = run({ position: pos(MIDWAY, 60), remembered: { wasAtPickup: true } });
  assert.equal(v.facts.loadIdentifier, 'L1');
  assert.equal(v.facts.gpsAgeMinutes, 5);
  assert.equal(v.facts.moving, true);
  assert.ok(v.facts.milesToDelivery > 0);
  assert.match(v.summary, /mi from the receiver/);
});
