const test = require('node:test');
const assert = require('node:assert/strict');

// config.js validates required secrets at require time; provide harmless values
// so requiring the service (transitively) does not exit the test process.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:5432/db';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '1:test';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '2:test';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY = process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef';

const {
  heuristicPhase,
  phaseToStopType,
  nextCheckMinutes,
} = require('../services/driverLocationMonitorService');
const {
  normalizeNameForMatch,
  orderDriverCandidates,
} = require('../services/datatruckApiService');

test('heuristicPhase heads to pickup while the pickup appointment is still ahead', () => {
  const now = Date.now();
  assert.equal(
    heuristicPhase({
      pickupTime: new Date(now + 3600_000).toISOString(),
      deliveryTime: new Date(now + 7200_000).toISOString(),
      nowMs: now,
    }),
    'heading_pickup'
  );
});

test('heuristicPhase switches to delivery once the pickup is well in the past', () => {
  const now = Date.now();
  assert.equal(
    heuristicPhase({
      pickupTime: new Date(now - 7200_000).toISOString(),
      deliveryTime: new Date(now + 7200_000).toISOString(),
      nowMs: now,
    }),
    'heading_delivery'
  );
});

test('heuristicPhase falls back to delivery when only a delivery time is known', () => {
  const now = Date.now();
  assert.equal(
    heuristicPhase({ pickupTime: '', deliveryTime: new Date(now + 7200_000).toISOString(), nowMs: now }),
    'heading_delivery'
  );
});

test('heuristicPhase honors a small grace window around the pickup appointment', () => {
  const now = Date.now();
  // Pickup 5 minutes ago is still within the on-time grace → keep heading to pickup.
  assert.equal(
    heuristicPhase({ pickupTime: new Date(now - 5 * 60_000).toISOString(), deliveryTime: '', nowMs: now }),
    'heading_pickup'
  );
});

test('phaseToStopType maps phases to shipper/receiver', () => {
  assert.equal(phaseToStopType('heading_pickup'), 'shipper');
  assert.equal(phaseToStopType('heading_delivery'), 'receiver');
});

test('nextCheckMinutes tightens as ETA shrinks and respects the interval cap', () => {
  assert.equal(nextCheckMinutes({ etaMinutes: 60, intervalCap: 30 }), 20); // far → loose
  assert.equal(nextCheckMinutes({ etaMinutes: 15, intervalCap: 30 }), 5);
  assert.equal(nextCheckMinutes({ etaMinutes: 6, intervalCap: 30 }), 2);   // close → tight
  assert.equal(nextCheckMinutes({ etaMinutes: 600, intervalCap: 30 }), 30); // never exceed cap
  assert.equal(nextCheckMinutes({ etaMinutes: 1, intervalCap: 30 }), 2);    // never below floor
});

test('normalizeNameForMatch lowercases and strips punctuation/accents-as-symbols', () => {
  assert.equal(normalizeNameForMatch("  John   O'Brien-Smith "), 'john o brien smith');
  assert.equal(normalizeNameForMatch('JOHN  DOE'), 'john doe');
  assert.equal(normalizeNameForMatch(null), '');
});

test('orderDriverCandidates collects assigned and team drivers', () => {
  const order = {
    trip: { driver__full_name: 'John Doe', team_driver__full_name: 'Jane Roe' },
    assigned_driver: 'Backup Bob',
  };
  const candidates = orderDriverCandidates(order);
  assert.ok(candidates.includes('John Doe'));
  assert.ok(candidates.includes('Jane Roe'));
  assert.ok(candidates.includes('Backup Bob'));
});

test('orderDriverCandidates is safe on empty orders', () => {
  assert.deepEqual(orderDriverCandidates({}), []);
  assert.deepEqual(orderDriverCandidates({ trip: {} }), []);
});
