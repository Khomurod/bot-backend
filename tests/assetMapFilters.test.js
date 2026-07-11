/**
 * Pure asset-map filter helpers (fleet/src/utils/assetMapFilters.js and its
 * admin mirror). These drive BOTH the Dispatch Map markers and the side list,
 * so every filter dimension is tested here. The helpers must only hide/show
 * backend-decided state — never reclassify it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const FLEET_PATH = path.resolve(__dirname, '../fleet/src/utils/assetMapFilters.js');
const ADMIN_PATH = path.resolve(__dirname, '../admin/src/utils/assetMapFilters.js');

let m; // fleet module (admin copy is byte-identical — asserted below)
test.before(async () => {
  m = await import(pathToFileURL(FLEET_PATH).href);
});

test('admin helper is an exact mirror of the fleet helper', () => {
  assert.equal(fs.readFileSync(ADMIN_PATH, 'utf8'), fs.readFileSync(FLEET_PATH, 'utf8'));
});

// ── fixtures ──

const TRUCKS = [
  { load_id: 'L1', driver_name: 'John Driver', unit: 'T100', load_number: '9492869', status: 'in_transit', condition: 'loaded', latitude: 40.0, longitude: -75.0 },
  { load_id: 'L2', driver_name: 'Maria Haul', unit: 'T200', load_number: '555', status: 'dispatched', condition: 'empty', latitude: 41.5, longitude: -80.2 },
  { load_id: 'L3', driver_name: 'No Gps', unit: 'T300', load_number: '777', status: 'in_transit', condition: 'loaded', latitude: null, longitude: null },
];

const TRAILERS = [
  { trailer_id: 1, unit_number: 'SWFZ233611', possession_status: 'with_driver', cargo_status: 'loaded', display_status: 'With driver / Loaded', current_driver_name: 'John Driver', lat: null, lng: null, location_source: null, needs_review: false, location_text: null },
  { trailer_id: 2, unit_number: '403279', possession_status: 'dropped', cargo_status: 'empty', display_status: 'Dropped / Empty', current_driver_name: 'Maria Haul', lat: 39.9, lng: -76.3, location_source: 'exact', needs_review: false, location_text: 'Lancaster PA' },
  { trailer_id: 3, unit_number: '171847', possession_status: 'dropped', cargo_status: 'loaded', display_status: 'Dropped / Loaded', current_driver_name: null, lat: 33.7, lng: -84.4, location_source: 'approximate_state', needs_review: true, location_text: 'Georgia' },
  { trailer_id: 4, unit_number: 'VT700669', possession_status: 'dropped', cargo_status: 'empty', display_status: 'Dropped / Empty', current_driver_name: null, lat: null, lng: null, location_source: 'text_only', needs_review: false, location_text: 'Home Depot MDO/DFC #5829' },
  { trailer_id: 5, unit_number: 'ST508998', possession_status: 'with_driver', cargo_status: 'unknown', display_status: 'With driver / Unknown cargo', current_driver_name: 'Ghost Driver', lat: 35.2, lng: -90.0, location_source: 'geocoded', location_confidence: 40, needs_review: false, location_text: 'Memphis TN' },
  { trailer_id: 6, unit_number: 'AB1001', possession_status: 'unknown', cargo_status: 'unknown', display_status: 'Unknown', current_driver_name: null, lat: 36.1, lng: -86.7, location_source: 'geocoded', location_confidence: 75, needs_review: false, location_text: 'Nashville TN' },
];

function driverIndex() {
  return m.buildDriverPositionIndex(TRUCKS.map((t) => ({ names: [t.driver_name], lat: t.latitude, lng: t.longitude, unit: t.unit })));
}
const F = (patch = {}) => ({ ...m.DEFAULT_FILTERS, ...patch });

// ── asset view ──

test('all assets shows trucks and trailers', () => {
  const trucks = m.filterTrucks(TRUCKS, F());
  const trailers = m.filterTrailers(TRAILERS, F(), { driverIndex: driverIndex() });
  assert.equal(trucks.length, 3);
  assert.equal(trailers.length, 6);
});

test('trucks only hides trailers', () => {
  assert.equal(m.filterTrailers(TRAILERS, F({ assetView: 'trucks' }), { driverIndex: driverIndex() }).length, 0);
  assert.equal(m.filterTrucks(TRUCKS, F({ assetView: 'trucks' })).length, 3);
});

test('trailers only hides truck markers', () => {
  assert.equal(m.filterTrucks(TRUCKS, F({ assetView: 'trailers' })).length, 0);
  assert.equal(m.filterTrailers(TRAILERS, F({ assetView: 'trailers' }), { driverIndex: driverIndex() }).length, 6);
});

test('with-driver trailer in trailers-only mode still uses derived truck coordinates', () => {
  const entries = m.filterTrailers(TRAILERS, F({ assetView: 'trailers' }), { driverIndex: driverIndex() });
  const swfz = entries.find((e) => e.trailer.unit_number === 'SWFZ233611');
  assert.equal(swfz.position.derived, true);
  assert.equal(swfz.position.lat, 40.0); // John Driver's truck
  assert.equal(swfz.position.derivedFromUnit, 'T100');
});

test('hidden truck data remains available for coordinate derivation (index includes all trucks)', () => {
  // Even though trucks are filtered OUT of the view, the index built from the
  // raw snapshot still derives the trailer position.
  const idx = driverIndex();
  assert.ok(idx.get(m.normalizeDriverName('John Driver')));
  const pos = m.resolveTrailerPosition(TRAILERS[0], idx);
  assert.equal(pos.derived, true);
});

// ── trailer status filters ──

test('loaded shows all loaded trailers (with driver AND dropped)', () => {
  const got = m.filterTrailers(TRAILERS, F({ trailerCargo: 'loaded' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number).sort(), ['171847', 'SWFZ233611']);
});

test('empty shows all empty trailers', () => {
  const got = m.filterTrailers(TRAILERS, F({ trailerCargo: 'empty' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number).sort(), ['403279', 'VT700669']);
});

test('with_driver possession filter works', () => {
  const got = m.filterTrailers(TRAILERS, F({ trailerPossession: 'with_driver' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number).sort(), ['ST508998', 'SWFZ233611']);
});

test('dropped possession filter works', () => {
  const got = m.filterTrailers(TRAILERS, F({ trailerPossession: 'dropped' }), { driverIndex: driverIndex() });
  assert.equal(got.length, 3);
});

test('dropped + empty combination (AND logic)', () => {
  const got = m.filterTrailers(TRAILERS, F({ trailerPossession: 'dropped', trailerCargo: 'empty' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number).sort(), ['403279', 'VT700669']);
});

test('dropped + loaded combination', () => {
  const got = m.filterTrailers(TRAILERS, F({ trailerPossession: 'dropped', trailerCargo: 'loaded' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number), ['171847']);
});

test('unknown cargo filter works', () => {
  const got = m.filterTrailers(TRAILERS, F({ trailerCargo: 'unknown' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number).sort(), ['AB1001', 'ST508998']);
});

test('needs_review filter works', () => {
  const got = m.filterTrailers(TRAILERS, F({ trailerReview: 'needs_review' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number), ['171847']);
});

test('confirmed filter excludes review items', () => {
  const got = m.filterTrailers(TRAILERS, F({ trailerReview: 'confirmed' }), { driverIndex: driverIndex() });
  assert.equal(got.length, 5);
  assert.ok(!got.some((e) => e.trailer.unit_number === '171847'));
});

// ── location quality ──

test('exact location filter works (exact source + confident geocode)', () => {
  const got = m.filterTrailers(TRAILERS, F({ locationQuality: 'exact' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number).sort(), ['403279', 'AB1001']);
});

test('derived location filter works', () => {
  const got = m.filterTrailers(TRAILERS, F({ locationQuality: 'derived_from_driver' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number), ['SWFZ233611']);
});

test('approximate filter works (approximate_state + low-confidence geocode)', () => {
  const got = m.filterTrailers(TRAILERS, F({ locationQuality: 'approximate' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number).sort(), ['171847', 'ST508998']);
});

test('missing filter works', () => {
  // SWFZ233611 has no own coords but IS derivable → not missing.
  // VT700669 has no coords at all → missing.
  const got = m.filterTrailers(TRAILERS, F({ locationQuality: 'missing' }), { driverIndex: driverIndex() });
  assert.deepEqual(got.map((e) => e.trailer.unit_number), ['VT700669']);
});

test('missing-location trailer appears in results but with no mappable point', () => {
  const got = m.filterTrailers(TRAILERS, F({ locationQuality: 'missing' }), { driverIndex: driverIndex() });
  assert.equal(got.length, 1);
  assert.equal(got[0].position.lat, null);
  assert.deepEqual(m.getVisibleMapPoints([], got), []); // never an invalid marker point
});

test('frontend never reclassifies backend business state', () => {
  // A trailer the backend says is loaded stays loaded regardless of any
  // frontend condition text; classifyLocationQuality reads location_source
  // read-only and the trailer object is not mutated.
  const t = { ...TRAILERS[2] };
  const before = JSON.stringify(t);
  m.filterTrailers([t], F({ trailerCargo: 'loaded', locationQuality: 'approximate' }), { driverIndex: driverIndex() });
  m.classifyLocationQuality(t, m.resolveTrailerPosition(t, driverIndex()));
  assert.equal(JSON.stringify(t), before);
});

// ── search ──

test('search by trailer unit', () => {
  const got = m.filterTrailers(TRAILERS, F(), { driverIndex: driverIndex(), search: '403279' });
  assert.deepEqual(got.map((e) => e.trailer.unit_number), ['403279']);
});

test('search by driver matches trucks and trailers', () => {
  const trucks = m.filterTrucks(TRUCKS, F(), { search: 'john' });
  const trailers = m.filterTrailers(TRAILERS, F(), { driverIndex: driverIndex(), search: 'john' });
  assert.deepEqual(trucks.map((t) => t.unit), ['T100']);
  assert.deepEqual(trailers.map((e) => e.trailer.unit_number), ['SWFZ233611']);
});

test('search by location text', () => {
  const got = m.filterTrailers(TRAILERS, F(), { driverIndex: driverIndex(), search: 'lancaster' });
  assert.deepEqual(got.map((e) => e.trailer.unit_number), ['403279']);
});

test('search respects active filters (AND logic)', () => {
  // 'Lancaster' matches 403279 (dropped/empty) — but a loaded-only filter hides it.
  const got = m.filterTrailers(TRAILERS, F({ trailerCargo: 'loaded' }), { driverIndex: driverIndex(), search: 'lancaster' });
  assert.equal(got.length, 0);
});

test('truck search by load number and status', () => {
  assert.deepEqual(m.filterTrucks(TRUCKS, F(), { search: '9492869' }).map((t) => t.unit), ['T100']);
  assert.deepEqual(m.filterTrucks(TRUCKS, F(), { search: 'dispatched' }).map((t) => t.unit), ['T200']);
});

// ── counts ──

test('snapshot counts are correct and need no extra API calls', () => {
  const counts = m.calculateAssetCounts({ trucks: TRUCKS, trailers: TRAILERS, driverIndex: driverIndex() });
  assert.deepEqual(counts, {
    trucks: 3,
    trailers: 6,
    withDriver: 2,
    dropped: 3,
    unknownPossession: 1,
    loaded: 2,
    empty: 2,
    unknownCargo: 2,
    needsReview: 1,
    locationMissing: 1, // only VT700669 — SWFZ233611 derives from its truck
  });
});

test('visible-result count updates with the filters', () => {
  const idx = driverIndex();
  const all = m.filterTrailers(TRAILERS, F(), { driverIndex: idx });
  const filtered = m.filterTrailers(TRAILERS, F({ trailerPossession: 'dropped', trailerCargo: 'empty' }), { driverIndex: idx });
  assert.equal(all.length, 6);
  assert.equal(filtered.length, 2);
});

// ── fit visible ──

test('fit-visible points use only currently visible filtered markers', () => {
  const idx = driverIndex();
  const filters = F({ assetView: 'trailers', trailerPossession: 'dropped', trailerCargo: 'empty' });
  const trucks = m.filterTrucks(TRUCKS, filters);
  const trailers = m.filterTrailers(TRAILERS, filters, { driverIndex: idx });
  const pts = m.getVisibleMapPoints(trucks, trailers);
  // Trucks hidden (trailers view); of dropped/empty only 403279 is mappable.
  assert.deepEqual(pts, [[39.9, -76.3]]);
});

test('no visible markers yields an empty point list (never throws)', () => {
  assert.deepEqual(m.getVisibleMapPoints([], []), []);
  assert.deepEqual(m.getVisibleMapPoints(undefined, undefined), []);
});

test('trucks without GPS never contribute map points but survive filtering', () => {
  const trucks = m.filterTrucks(TRUCKS, F());
  const pts = m.getVisibleMapPoints(trucks, []);
  assert.equal(trucks.length, 3);
  assert.equal(pts.length, 2); // T300 has no GPS
});

test('location-quality filter applies to trucks too (missing lists no-GPS trucks)', () => {
  assert.deepEqual(m.filterTrucks(TRUCKS, F({ locationQuality: 'missing' })).map((t) => t.unit), ['T300']);
  assert.deepEqual(m.filterTrucks(TRUCKS, F({ locationQuality: 'exact' })).map((t) => t.unit), ['T100', 'T200']);
});

// ── persistence / sanitize ──

test('valid stored filters restore unchanged', () => {
  const stored = { assetView: 'trailers', trailerPossession: 'dropped', trailerCargo: 'loaded', trailerReview: 'needs_review', locationQuality: 'approximate' };
  assert.deepEqual(m.sanitizeFilters(stored), stored);
});

test('invalid stored filters fall back safely to defaults', () => {
  assert.deepEqual(m.sanitizeFilters({ assetView: 'spaceships', trailerCargo: 'ambiguous', bogus: 1 }), m.DEFAULT_FILTERS);
  assert.deepEqual(m.sanitizeFilters(null), m.DEFAULT_FILTERS);
  assert.deepEqual(m.sanitizeFilters('junk'), m.DEFAULT_FILTERS);
});

test('quick filters only patch the underlying dimensions', () => {
  const de = m.QUICK_FILTERS.find((q) => q.key === 'dropped_empty');
  const applied = m.sanitizeFilters({ ...m.DEFAULT_FILTERS, ...de.patch });
  assert.equal(applied.assetView, 'trailers');
  assert.equal(applied.trailerPossession, 'dropped');
  assert.equal(applied.trailerCargo, 'empty');
  // clearing = defaults
  assert.deepEqual(m.sanitizeFilters({}), m.DEFAULT_FILTERS);
});

// ── accessibility ──

test('cargo state has a text glyph, not color only (E/L/?/!)', () => {
  assert.equal(m.cargoGlyph({ cargo_status: 'empty' }), 'E');
  assert.equal(m.cargoGlyph({ cargo_status: 'loaded' }), 'L');
  assert.equal(m.cargoGlyph({ cargo_status: 'unknown' }), '?');
  assert.equal(m.cargoGlyph({ cargo_status: 'loaded', needs_review: true }), '!');
});

test('trailer markers get a useful accessible label', () => {
  const label = m.trailerAriaLabel(TRAILERS[2], 'approximate');
  assert.match(label, /Trailer 171847/);
  assert.match(label, /Dropped \/ Loaded/);
  assert.match(label, /needs review/);
  assert.match(label, /location approximate/);
});
