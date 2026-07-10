/**
 * Trailer geocoding service. etaRoutingService.geocodePlace is mocked via the
 * module cache so no network is touched; the cascade / state-centroid / cache /
 * fail-soft behavior is asserted deterministically.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function load({ geocodePlace } = {}) {
  const modPath = path.resolve(__dirname, '../services/trailerGeocodeService.js');
  const etaPath = path.resolve(__dirname, '../services/etaRoutingService.js');
  delete require.cache[modPath];
  require.cache[etaPath] = { exports: { geocodePlace: geocodePlace || (async () => null) } };
  return require(modPath);
}

test('city/state geocodes via geocodePlace (mocked)', async () => {
  let calls = 0;
  const svc = load({ geocodePlace: async () => { calls += 1; return { lat: 40.03, lng: -76.3 }; } });
  svc.clearGeocodeCache();
  const r = await svc.geocodeTrailerLocation('Lancaster, PA');
  assert.equal(r.source, 'geocoded');
  assert.equal(r.lat, 40.03);
  assert.equal(calls, 1);
});

test('facility name uses the geocodePlace path (mocked)', async () => {
  const svc = load({ geocodePlace: async () => ({ lat: 33.9, lng: -84.5 }) });
  svc.clearGeocodeCache();
  const r = await svc.geocodeTrailerLocation('Home Depot MDO/DFC #5829');
  assert.equal(r.source, 'geocoded');
  assert.ok(Number.isFinite(r.lat));
});

test('state-only input resolves to a state centroid (approximate, no network)', async () => {
  let calls = 0;
  const svc = load({ geocodePlace: async () => { calls += 1; return { lat: 1, lng: 1 }; } });
  svc.clearGeocodeCache();
  const r = await svc.geocodeTrailerLocation('PA');
  assert.equal(r.source, 'approximate_state');
  assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lng));
  assert.equal(calls, 0, 'state-only must not call the network geocoder');
});

test('failed geocode never throws; falls back to state centroid when a state is present', async () => {
  const svc = load({ geocodePlace: async () => { throw new Error('network down'); } });
  svc.clearGeocodeCache();
  const r = await svc.geocodeTrailerLocation('Somewhere weird, TX');
  assert.equal(r.source, 'approximate_state');
  assert.ok(Number.isFinite(r.lat));
});

test('unmappable input returns text_only (lat/lng null), never throws', async () => {
  const svc = load({ geocodePlace: async () => null });
  svc.clearGeocodeCache();
  const r = await svc.geocodeTrailerLocation('the usual spot');
  assert.equal(r.source, 'text_only');
  assert.equal(r.lat, null);
});

test('results are cached — the same text is not geocoded twice', async () => {
  let calls = 0;
  const svc = load({ geocodePlace: async () => { calls += 1; return { lat: 5, lng: 6 }; } });
  svc.clearGeocodeCache();
  await svc.geocodeTrailerLocation('Reno NV');
  await svc.geocodeTrailerLocation('reno nv');   // normalized to the same key
  await svc.geocodeTrailerLocation('Reno,  NV'); // normalized to the same key
  assert.equal(calls, 1);
});

test('disabled geocoding returns text_only and does not cache', async () => {
  let calls = 0;
  const svc = load({ geocodePlace: async () => { calls += 1; return { lat: 5, lng: 6 }; } });
  svc.clearGeocodeCache();
  const off = await svc.geocodeTrailerLocation('Lancaster PA', { enabled: false });
  assert.equal(off.source, 'text_only');
  assert.equal(calls, 0);
  const on = await svc.geocodeTrailerLocation('Lancaster PA', { enabled: true });
  assert.equal(on.source, 'geocoded');
  assert.equal(calls, 1);
});
