/**
 * Static wiring guards for the operational map (admin Live Locations). The pure
 * filter logic is covered in assetMapFilters.test.js; these tests pin the
 * component wiring that unit tests can't reach: the unified endpoint, separate
 * layer groups, persistence, accessibility, and soft failure.
 *
 * This suite used to cover BOTH the admin Live Locations page and FleetView's
 * Dispatch Map. FleetView has been archived and removed (see
 * docs/ARCHIVED_FEATURES.md), so the fleet-only assertions — map lifecycle,
 * invalidateSize, auto-fit, the fleet storage key, reduced-motion CSS and the
 * "Trailer Tracking stays map-free" rule — went with it. Everything that guards
 * the surviving admin surface is kept unchanged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');
const liveLocations = read('../admin/src/pages/LiveLocationsPage.jsx');
const adminApi = read('../admin/src/api.js');

// ── unified trailer state only ──

test('Admin Live Locations uses the unified trailer states endpoint', () => {
  assert.ok(liveLocations.includes('api.getTrailerStates()'), 'must call getTrailerStates');
  assert.ok(!liveLocations.includes('api.getTrailerMapData()'), 'legacy getTrailerMapData must not be used');
  assert.ok(adminApi.includes('/trailers/states'), 'admin api client exposes the unified endpoint');
});

test('Live Locations uses the shared pure filter helper (no inline business logic)', () => {
  assert.ok(/from ['"]\.\.\/utils\/assetMapFilters['"]/.test(liveLocations), 'imports assetMapFilters');
  assert.ok(liveLocations.includes('filterTrailers('), 'filters trailers via the helper');
  assert.ok(liveLocations.includes('buildDriverPositionIndex('), 'builds the driver index once per snapshot');
});

// ── layers ──

test('trucks and trailers live in separate Leaflet layer groups', () => {
  assert.ok(liveLocations.includes('markerLayerRef'), 'live locations has a truck layer');
  assert.ok(liveLocations.includes('trailerLayerRef'), 'live locations has a trailer layer');
});

// ── persistence ──

test('filters persist to localStorage with a versioned key and sanitize on read', () => {
  assert.ok(liveLocations.includes('"admin.liveLocations.assetFilters.v1"'), 'admin storage key');
  assert.ok(liveLocations.includes('sanitizeFilters(JSON.parse('), 'stored values are validated on read');
});

// ── accessibility ──

test('trailer markers carry a text glyph and accessible labels (never color-only)', () => {
  assert.ok(liveLocations.includes('cargoGlyph('), 'glyph rendered inside the rectangle');
  assert.ok(liveLocations.includes('trailerAriaLabel('), 'aria label attached to markers/rows');
});

// ── soft failure ──

test('trailer failure degrades softly without touching trucks', () => {
  assert.ok(liveLocations.includes('keep previous trailers'), 'admin keeps last-known trailers');
});

// ── the archived surface really is gone ──

test('no FleetView Dispatch Map remains in the tree', () => {
  for (const p of ['../fleet', '../server/fleet']) {
    assert.equal(fs.existsSync(path.resolve(__dirname, p)), false, `${p} must stay removed`);
  }
});
