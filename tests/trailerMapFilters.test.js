/**
 * Pure Trailer Map filter helpers (§3): one predicate set drives both markers
 * and the side list, and location sources are labelled truthfully (driver-
 * derived is never presented as live trailer GPS).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.resolve(__dirname, '../admin/src/pages/trailer/a11y/mapFilters.js');
let m;
test.before(async () => { m = await import(pathToFileURL(MODULE).href); });

const ROWS = [
  { trailer_id: 1, unit_number: '1045', physical_status: 'available', current_lat: 41.8, current_lng: -87.6, location_source: 'manual', current_company_name: null, invoice_status: null, outstanding_balance: 0, needs_review: false },
  { trailer_id: 2, unit_number: '1088', physical_status: 'rented', current_lat: 42.3, current_lng: -83.0, location_source: 'ai', current_company_name: 'Acme', invoice_status: 'overdue', outstanding_balance: 500, needs_review: true, expected_return_at: '2026-07-01T00:00:00Z' },
  { trailer_id: 3, unit_number: '2044', physical_status: 'maintenance', current_lat: null, current_lng: null, location_source: null, current_company_name: null, invoice_status: 'paid', outstanding_balance: 0, status_needs_review: false },
];

test('no filters returns everything', () => {
  assert.equal(m.filterMapRows(ROWS, {}).length, 3);
});

test('condition, rental_state and company filters narrow', () => {
  assert.deepEqual(m.filterMapRows(ROWS, { condition: 'available' }).map((r) => r.trailer_id), [1]);
  assert.deepEqual(m.filterMapRows(ROWS, { rental_state: 'rented' }).map((r) => r.trailer_id), [2]);
  assert.deepEqual(m.filterMapRows(ROWS, { rental_state: 'available' }).map((r) => r.trailer_id).sort(), [1, 3]);
  assert.deepEqual(m.filterMapRows(ROWS, { company: 'acme' }).map((r) => r.trailer_id), [2]);
});

test('missing location, needs attention, outstanding and invoice status filters', () => {
  assert.deepEqual(m.filterMapRows(ROWS, { missing_location: 'true' }).map((r) => r.trailer_id), [3]);
  assert.deepEqual(m.filterMapRows(ROWS, { needs_attention: 'true' }).map((r) => r.trailer_id), [2]);
  assert.deepEqual(m.filterMapRows(ROWS, { outstanding_only: 'true' }).map((r) => r.trailer_id), [2]);
  assert.deepEqual(m.filterMapRows(ROWS, { invoice_status: 'overdue' }).map((r) => r.trailer_id), [2]);
});

test('location source filter matches, unknown covers null', () => {
  assert.deepEqual(m.filterMapRows(ROWS, { location_source: 'manual' }).map((r) => r.trailer_id), [1]);
  assert.deepEqual(m.filterMapRows(ROWS, { location_source: 'unknown' }).map((r) => r.trailer_id), [3]);
});

test('return_before keeps only returns on/before the date', () => {
  assert.deepEqual(m.filterMapRows(ROWS, { return_before: '2026-07-15' }).map((r) => r.trailer_id).sort(), [1, 2, 3]);
  assert.deepEqual(m.filterMapRows(ROWS, { return_before: '2026-06-01' }).map((r) => r.trailer_id).sort(), [1, 3]);
});

test('location labels never call driver-derived data live GPS', () => {
  assert.equal(m.locationSourceLabel('gps', true), 'Trailer GPS');
  assert.equal(m.locationSourceLabel('manual', true), 'Manual location');
  assert.match(m.locationSourceLabel('ai', true), /Driver-derived/);
  assert.match(m.locationSourceLabel('derived_from_driver', true), /not trailer GPS/);
  assert.equal(m.locationSourceLabel('gps', false), 'No location');
});
