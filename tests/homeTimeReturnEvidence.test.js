/**
 * "Did this driver go back to work?" — the rules, as tests.
 *
 * The scenarios below are the ones the business actually asked for, and the
 * load-bearing one is SCENARIO 5: dispatch assigns loads to drivers who are
 * still at home. If a load alone could mean "he left", Wenze would close a
 * cycle every time a planner did their job a day early.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreReturnToRoad, summariseMovement, loadIsWorking, DEFAULTS, CONFIDENCE,
} = require('../lib/homeTime/returnEvidence');

const NOW = '2026-09-20T18:00:00Z';
const HOME = { lat: 41.88, lng: -87.63 };          // where the truck was parked
const NEARBY = { lat: 41.90, lng: -87.60 };        // ~2 miles away
const FAR = { lat: 42.50, lng: -88.60 };           // ~66 miles away
const at = (mins) => new Date(Date.parse(NOW) - mins * 60000).toISOString();

const parked = (p, mins) => ({ ...p, speedMph: 0, at: at(mins) });
const rolling = (p, mins, mph = 58) => ({ ...p, speedMph: mph, at: at(mins) });

test('SCENARIO 5: a load assigned while the truck sits at home is NOT a departure', () => {
  const v = scoreReturnToRoad({
    nowIso: NOW,
    load: { status: 'assigned', loadIdentifier: 'L1' },
    anchor: HOME,
    observations: [parked(HOME, 40), parked(HOME, 5)],
  });
  assert.equal(v.confidence, CONFIDENCE.LOW);
  assert.ok(v.blockers.includes('parked_at_home'));
  assert.equal(v.facts.movementProven, false);
});

test('SCENARIO 6: a load plus movement away from home is a return', () => {
  const v = scoreReturnToRoad({
    nowIso: NOW,
    load: { status: 'dispatched', loadIdentifier: 'L1' },
    anchor: HOME,
    observations: [rolling(NEARBY, 40), rolling(FAR, 5)],
  });
  assert.equal(v.confidence, CONFIDENCE.HIGH);
  assert.ok(v.signals.includes('left_home_area'));
  assert.ok(v.signals.includes('truck_moving'));
  assert.ok(v.facts.movementProven);
  assert.match(v.summary, /active load/);
  assert.match(v.summary, /mi from home/);
});

test('SCENARIO 7: a load with GPS showing the truck at home, pickup already passed, asks a person', () => {
  const v = scoreReturnToRoad({
    nowIso: NOW,
    load: { status: 'dispatched', loadIdentifier: 'L1', pickupTime: at(360) },
    anchor: HOME,
    observations: [parked(HOME, 5)],
  });
  assert.equal(v.confidence, CONFIDENCE.MEDIUM, 'a question, not a state change');
  assert.ok(v.blockers.includes('pickup_passed_still_home'));
});

test('movement with no load at all never reaches high', () => {
  const v = scoreReturnToRoad({
    nowIso: NOW, load: null, anchor: HOME,
    observations: [rolling(NEARBY, 40), rolling(FAR, 5)],
  });
  assert.equal(v.confidence, CONFIDENCE.MEDIUM);
  assert.equal(v.facts.hasLoad, false);
});

test('a load in transit with no GPS at all is worth a look, not a change', () => {
  const v = scoreReturnToRoad({ nowIso: NOW, load: { status: 'in_transit' }, anchor: HOME, observations: [] });
  assert.equal(v.confidence, CONFIDENCE.MEDIUM);
  assert.ok(v.blockers.includes('no_gps'));
});

test('stale GPS can never carry a high verdict, however far the truck once went', () => {
  const v = scoreReturnToRoad({
    nowIso: NOW,
    load: { status: 'in_transit' },
    anchor: HOME,
    observations: [rolling(FAR, 600)], // ten hours old
  });
  assert.ok(v.blockers.includes('gps_stale'));
  assert.notEqual(v.confidence, CONFIDENCE.HIGH);
});

test('one moving sighting is a glitch; two make a trip', () => {
  const once = scoreReturnToRoad({
    nowIso: NOW, load: { status: 'dispatched' }, anchor: HOME,
    observations: [parked(HOME, 40), rolling(NEARBY, 5)],
  });
  assert.notEqual(once.confidence, CONFIDENCE.HIGH, 'moving nearby, once, is not a departure');

  const twice = scoreReturnToRoad({
    nowIso: NOW, load: { status: 'dispatched' }, anchor: HOME,
    observations: [rolling(NEARBY, 40), rolling(NEARBY, 5)],
  });
  assert.ok(twice.facts.movingSightings >= 2);
});

test('a truck that drove out and came home again is not on the road', () => {
  const v = scoreReturnToRoad({
    nowIso: NOW,
    load: { status: 'dispatched' },
    anchor: HOME,
    observations: [parked(NEARBY, 5)],
    remembered: { maxMilesFromAnchor: 66, movingSightings: 4 },
  });
  assert.equal(v.confidence, CONFIDENCE.LOW);
  assert.ok(v.blockers.includes('parked_at_home'));
});

test('what the watch remembers survives a gap in the sightings', () => {
  const move = summariseMovement([], null, DEFAULTS, { maxMilesFromAnchor: 66, movingSightings: 3 });
  assert.equal(move.milesFromAnchor, 66);
  assert.equal(move.sustained, true);
});

test('with no anchor, Wenze asks rather than decides', () => {
  // No anchor means the truck was never seen parked during this stay, so
  // "it left home" cannot be said at all — only "it is moving with a load".
  // That is a good reason to raise it with a person and a poor one to close a
  // driver's cycle unattended.
  const v = scoreReturnToRoad({
    nowIso: NOW, load: { status: 'dispatched' }, anchor: null,
    observations: [rolling(NEARBY, 40), rolling(FAR, 5)],
  });
  assert.equal(v.facts.milesFromHome, null);
  assert.equal(v.facts.movementProven, true, 'the hard gate is met…');
  assert.equal(v.confidence, CONFIDENCE.MEDIUM, '…but the case is still short of automatic');

  const parkedNoAnchor = scoreReturnToRoad({
    nowIso: NOW, load: { status: 'dispatched' }, anchor: null,
    observations: [parked(FAR, 5)],
  });
  assert.notEqual(parkedNoAnchor.confidence, CONFIDENCE.HIGH);
});

test('a driver saying they are rolling helps, but never on its own', () => {
  const v = scoreReturnToRoad({ nowIso: NOW, load: null, anchor: HOME, observations: [parked(HOME, 5)], driverSaidRoad: true });
  assert.notEqual(v.confidence, CONFIDENCE.HIGH);
});

test('load statuses that mean work, and ones that do not', () => {
  for (const status of ['assigned', 'dispatched', 'in_transit', 'In Transit']) {
    assert.equal(loadIsWorking({ status }), true, status);
  }
  for (const status of ['cancelled', 'delivered', 'completed', 'quote']) {
    assert.equal(loadIsWorking({ status }), false, status);
  }
  assert.equal(loadIsWorking(null), false);
});

test('the thresholds are settings, not constants baked into the rules', () => {
  const observations = [rolling(NEARBY, 40), rolling(NEARBY, 5)];
  const tight = scoreReturnToRoad({
    nowIso: NOW, load: { status: 'dispatched' }, anchor: HOME, observations,
    options: { homeRadiusMiles: 1 },
  });
  assert.ok(tight.signals.includes('left_home_area'), 'a 1-mile home radius is left immediately');
  const loose = scoreReturnToRoad({
    nowIso: NOW, load: { status: 'dispatched' }, anchor: HOME, observations,
    options: { homeRadiusMiles: 500 },
  });
  assert.equal(loose.signals.includes('left_home_area'), false);
});

test('every verdict explains itself in one short phrase', () => {
  const v = scoreReturnToRoad({
    nowIso: NOW, load: { status: 'in_transit' }, anchor: HOME,
    observations: [rolling(NEARBY, 40), rolling(FAR, 5)],
  });
  assert.ok(v.summary.length > 0 && v.summary.length < 160, v.summary);
  assert.equal(/undefined|NaN|null/.test(v.summary), false);
});
