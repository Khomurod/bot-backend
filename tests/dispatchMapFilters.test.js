/**
 * Static wiring guards for the operational-map filtering (fleet Dispatch Map +
 * admin Live Locations). The pure filter logic is covered in
 * assetMapFilters.test.js; these tests pin the component wiring that unit
 * tests can't reach: unified endpoints, separate layer groups, persistence,
 * responsive sizing, accessibility, and the no-second-map architecture rule.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');
const dispatchMap = read('../fleet/src/pages/DispatchMap.jsx');
const liveLocations = read('../admin/src/pages/LiveLocationsPage.jsx');
const fleetTrailerPage = read('../fleet/src/pages/TrailerTrackingPage.jsx');
const fleetCss = read('../fleet/src/styles.css');
const adminApi = read('../admin/src/api.js');

// ── unified trailer state only ──

test('Dispatch Map uses the unified trailer-state endpoint, never the legacy map payload', () => {
  assert.ok(dispatchMap.includes("api('/trailer-state/map')"), 'must call /trailer-state/map');
  assert.ok(!dispatchMap.includes("'/trailers/map'"), 'legacy /trailers/map must not be used');
});

test('Admin Live Locations uses the unified trailer states endpoint', () => {
  assert.ok(liveLocations.includes('api.getTrailerStates()'), 'must call getTrailerStates');
  assert.ok(!liveLocations.includes('api.getTrailerMapData()'), 'legacy getTrailerMapData must not be used');
  assert.ok(adminApi.includes('/trailers/states'), 'admin api client exposes the unified endpoint');
});

test('both surfaces use the shared pure filter helper (no inline business logic)', () => {
  for (const [name, src] of [['DispatchMap', dispatchMap], ['LiveLocations', liveLocations]]) {
    assert.ok(/from ['"]\.\.\/utils\/assetMapFilters['"]/.test(src), `${name} imports assetMapFilters`);
    assert.ok(src.includes('filterTrailers('), `${name} filters trailers via the helper`);
    assert.ok(src.includes('buildDriverPositionIndex('), `${name} builds the driver index once per snapshot`);
  }
});

// ── layers / map lifecycle ──

test('trucks and trailers live in separate Leaflet layer groups', () => {
  assert.ok(dispatchMap.includes('truckLayerRef'), 'dispatch map has a truck layer');
  assert.ok(dispatchMap.includes('trailerLayerRef'), 'dispatch map has a trailer layer');
  assert.ok(liveLocations.includes('markerLayerRef'), 'live locations has a truck layer');
  assert.ok(liveLocations.includes('trailerLayerRef'), 'live locations has a trailer layer');
});

test('the Leaflet map is created once and cleaned up (not recreated per filter change)', () => {
  assert.equal((dispatchMap.match(/L\.map\(/g) || []).length, 1, 'exactly one L.map call');
  assert.ok(dispatchMap.includes('mapObj.current.remove()'), 'map removed on unmount');
  assert.ok(dispatchMap.includes('clearInterval'), 'trailer polling interval cleared on unmount');
});

test('map re-measures with invalidateSize after resize and layout changes', () => {
  assert.ok((dispatchMap.match(/invalidateSize\(\)/g) || []).length >= 2, 'resize + layout invalidateSize');
  assert.ok(dispatchMap.includes("addEventListener('resize'"), 'window resize listener');
  assert.ok(dispatchMap.includes("removeEventListener('resize'"), 'resize listener removed');
});

test('auto-fit happens once on first load; Fit visible uses only filtered markers', () => {
  assert.ok(dispatchMap.includes('fittedRef'), 'first-load fit guard exists');
  assert.ok(dispatchMap.includes('getVisibleMapPoints(visibleTrucks, mappableTrailers)'), 'fit uses the visible filtered dataset');
  assert.ok(dispatchMap.includes('Fit visible'), 'Fit visible control exists');
});

// ── persistence ──

test('filters persist to localStorage with a versioned key and sanitize on read', () => {
  assert.ok(dispatchMap.includes("'fleet.dispatchMap.assetFilters.v1'"), 'fleet storage key');
  assert.ok(liveLocations.includes('"admin.liveLocations.assetFilters.v1"'), 'admin storage key');
  for (const src of [dispatchMap, liveLocations]) {
    assert.ok(src.includes('sanitizeFilters(JSON.parse('), 'stored values are validated on read');
  }
});

// ── accessibility ──

test('trailer markers carry a text glyph and accessible labels (never color-only)', () => {
  for (const src of [dispatchMap, liveLocations]) {
    assert.ok(src.includes('cargoGlyph('), 'glyph rendered inside the rectangle');
    assert.ok(src.includes('trailerAriaLabel('), 'aria label attached to markers/rows');
  }
});

test('reduced-motion preference is respected', () => {
  assert.ok(dispatchMap.includes('prefers-reduced-motion'), 'JS checks prefers-reduced-motion');
  assert.ok(fleetCss.includes('prefers-reduced-motion'), 'CSS disables transitions under reduced motion');
});

// ── architecture rules ──

test('Trailer Tracking (fleet) stays map-free — Dispatch Map is the only operational map', () => {
  assert.ok(!/from ['"]leaflet['"]/.test(fleetTrailerPage), 'no Leaflet in fleet Trailer Tracking');
  assert.ok(!fleetTrailerPage.includes('assetMapFilters'), 'operational map filters stay on Dispatch Map');
});

test('side list and markers consume the same filtered variables', () => {
  // Both the marker effect and the JSX list iterate visibleTrucks/visibleTrailers.
  assert.ok((dispatchMap.match(/visibleTrailers/g) || []).length >= 3, 'trailer list + count + markers share visibleTrailers');
  assert.ok((dispatchMap.match(/visibleTrucks/g) || []).length >= 3, 'truck list + fit + markers share visibleTrucks');
});

test('trailer failure degrades softly without touching trucks', () => {
  assert.ok(dispatchMap.includes('setTrailerError(true)'), 'trailer error tracked');
  assert.ok(dispatchMap.includes('keep previous data'), 'stale trailer data kept on failure');
  assert.ok(liveLocations.includes('keep previous trailers'), 'admin keeps last-known trailers');
});
