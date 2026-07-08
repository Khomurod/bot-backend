/**
 * Tests for services/documentLoadMatcher.js — matching a document batch to the
 * correct Datatruck load and deciding a confidence tier. scoreMatch is pure
 * (distances via an injected haversine); matchLoadForBatch is tested with
 * injected resolvers so no Datatruck/Samsara calls happen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const matcher = require('../services/documentLoadMatcher');

// Deterministic haversine for tests: 0 when identical, else rough great-circle.
function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const LOAD = {
  orderId: 13367,
  loadIdentifier: '9188060',
  unitNumber: '771',
  pickupAddress: '123 Shipper Rd, Savannah, GA 31401',
  pickupLat: 32.1175, pickupLng: -81.2245,
  deliveryAddress: '9 Consignee Ave, Edison, NJ 08817',
  deliveryLat: 40.5068, deliveryLng: -74.3234,
  loadInfoComplete: true,
};

test('no load found → confidence none (does not upload)', () => {
  const res = matcher.scoreMatch({ classification: { type: 'pod' }, load: null, haversineMiles });
  assert.equal(res.confidence, 'none');
});

test('load-number match on the document → high confidence', () => {
  const res = matcher.scoreMatch({
    classification: { type: 'pod', loadNumbers: ['9188060'] }, load: LOAD, haversineMiles,
  });
  assert.equal(res.confidence, 'high');
  assert.equal(res.loadReference, '9188060');
});

test('driver/unit match with no conflict → medium', () => {
  const res = matcher.scoreMatch({ classification: { type: 'pod', loadNumbers: [] }, load: LOAD, haversineMiles });
  assert.equal(res.confidence, 'medium');
});

test('incomplete load details → low (weak driver match)', () => {
  const res = matcher.scoreMatch({
    classification: { type: 'bol' }, load: { ...LOAD, loadInfoComplete: false }, haversineMiles,
  });
  assert.equal(res.confidence, 'low');
});

test('near pickup favors BOL (docTypeHint=bol)', () => {
  const res = matcher.scoreMatch({
    classification: { type: 'bol' },
    load: LOAD,
    location: { latitude: LOAD.pickupLat, longitude: LOAD.pickupLng },
    haversineMiles,
  });
  assert.equal(res.stageHint, 'pickup');
  assert.equal(res.docTypeHint, 'bol');
});

test('near delivery favors POD (docTypeHint=pod)', () => {
  const res = matcher.scoreMatch({
    classification: { type: 'pod' },
    load: LOAD,
    location: { latitude: LOAD.deliveryLat, longitude: LOAD.deliveryLng },
    haversineMiles,
  });
  assert.equal(res.stageHint, 'delivery');
  assert.equal(res.docTypeHint, 'pod');
});

test('classified POD but near pickup → contradiction downgrades confidence', () => {
  const res = matcher.scoreMatch({
    classification: { type: 'pod', loadNumbers: ['9188060'] }, // would be high on number match
    load: LOAD,
    location: { latitude: LOAD.pickupLat, longitude: LOAD.pickupLng },
    haversineMiles,
  });
  assert.equal(res.docTypeHint, 'bol');
  assert.notEqual(res.confidence, 'high'); // capped down by the contradiction
});

test('AI belongs_to_other_load → mismatch', () => {
  const res = matcher.scoreMatch({
    classification: { type: 'pod', belongsToOtherLoad: true }, load: LOAD, haversineMiles,
  });
  assert.equal(res.confidence, 'mismatch');
  assert.equal(res.mismatch, true);
});

test('document load number that does not match the active load → mismatch', () => {
  const res = matcher.scoreMatch({
    classification: { type: 'pod', loadNumbers: ['77777777'] }, load: LOAD, haversineMiles,
  });
  assert.equal(res.confidence, 'mismatch');
});

test('address overlap (shared ZIP) → high confidence', () => {
  const res = matcher.scoreMatch({
    classification: { type: 'pod', addresses: ['Signed at 9 Consignee Ave, Edison NJ 08817'] },
    load: LOAD, haversineMiles,
  });
  assert.equal(res.confidence, 'high');
});

test('matchLoadForBatch resolves by group first, then falls back to unit', async () => {
  const calls = [];
  const currentLoad = {
    async getCurrentLoadByGroup(g) { calls.push('group'); return null; },
    async getCurrentLoadByUnit(u) { calls.push(`unit:${u}`); return LOAD; },
    async getCurrentLoadByDriver() { calls.push('driver'); return null; },
  };
  const res = await matcher.matchLoadForBatch({
    group: { group_name: 'WENZE 771 JOHN' },
    driverProfile: { unit_number: '771', full_name: 'John Doe' },
    classification: { type: 'pod', loadNumbers: ['9188060'] },
  }, {
    currentLoad,
    resolveLocation: async () => null, // no GPS
    haversineMiles,
  });
  assert.deepEqual(calls, ['group', 'unit:771']);
  assert.equal(res.confidence, 'high');
});

test('matchLoadForBatch tolerates a throwing location resolver', async () => {
  const res = await matcher.matchLoadForBatch({
    group: { group_name: 'WENZE 771 JOHN' },
    driverProfile: { unit_number: '771' },
    classification: { type: 'pod', loadNumbers: [] },
  }, {
    currentLoad: { async getCurrentLoadByGroup() { return LOAD; }, async getCurrentLoadByUnit() { return null; }, async getCurrentLoadByDriver() { return null; } },
    resolveLocation: async () => { throw new Error('UNIT_NOT_FOUND_IN_GROUP_TITLE'); },
    haversineMiles,
  });
  assert.equal(res.confidence, 'medium'); // still matched by group, location just absent
});
