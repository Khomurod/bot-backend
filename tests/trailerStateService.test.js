/**
 * Unified TrailerStateService — pure normalization, display status, and map
 * marker rules. No DB required for these (the DB-backed getters are covered by
 * the PG integration test); here we exercise the deterministic mappers.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token-2';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-key';
process.env.CORS_ALLOW_ALL ||= 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../services/trailerStateService');

test('display status: dropped defaults to empty label', () => {
  assert.equal(svc.buildDisplayStatus('dropped', 'empty', false), 'Dropped / Empty');
  assert.equal(svc.buildDisplayStatus('dropped', 'loaded', false), 'Dropped / Loaded');
  assert.equal(svc.buildDisplayStatus('with_driver', 'unknown', false), 'With driver / Unknown cargo');
  assert.equal(svc.buildDisplayStatus('with_driver', 'empty', false), 'With driver / Empty');
  assert.equal(svc.buildDisplayStatus('with_driver', 'loaded', false), 'With driver / Loaded');
});

test('display status: unknown possession + review → Needs review', () => {
  assert.equal(svc.buildDisplayStatus('unknown', 'unknown', true), 'Unknown / Needs review');
  assert.equal(svc.buildDisplayStatus('unknown', 'unknown', false), 'Unknown');
});

test('marker color distinguishes dropped empty vs dropped loaded', () => {
  const empty = svc.markerColor('dropped', 'empty');
  const loaded = svc.markerColor('dropped', 'loaded');
  assert.notEqual(empty, loaded);
  assert.equal(empty, svc.COLOR.droppedEmpty);
  assert.equal(loaded, svc.COLOR.droppedLoaded);
});

test('normalizeState builds a full state object with a rectangle map marker', () => {
  const s = svc.normalizeState({
    trailer_id: 7, unit_number: '171847',
    possession_status: 'dropped', cargo_status: 'empty',
    current_lat: 40.0, current_lng: -76.3, location_source: 'geocoded',
    status_needs_review: false, current_driver_name: null,
  });
  assert.equal(s.unit_number, '171847');
  assert.equal(s.display_status, 'Dropped / Empty');
  assert.equal(s.map_marker.shape, 'rectangle');
  assert.equal(s.map_marker.color, svc.COLOR.droppedEmpty);
  assert.equal(s.map_marker.attached_to_driver, false);
  assert.equal(s.mappable, true);
});

test('with_driver trailer is mappable (derives from truck) and marker attaches', () => {
  const s = svc.normalizeState({
    trailer_id: 8, unit_number: '403279',
    possession_status: 'with_driver', cargo_status: 'unknown',
    current_lat: null, current_lng: null,
    status_needs_review: false, current_driver_name: 'John Doe',
  });
  assert.equal(s.mappable, true);
  assert.equal(s.map_marker.attached_to_driver, true);
});

test('needs_review sets a red outline', () => {
  const s = svc.normalizeState({
    trailer_id: 9, unit_number: 'X', possession_status: 'unknown',
    cargo_status: 'unknown', status_needs_review: true,
  });
  assert.equal(s.map_marker.outline, '#ef4444');
  assert.equal(s.needs_review, true);
  assert.equal(s.review_status, 'pending');
});

test('approximate_state source renders a dashed marker', () => {
  const s = svc.normalizeState({
    trailer_id: 10, unit_number: 'Y', possession_status: 'dropped',
    cargo_status: 'empty', current_lat: 41, current_lng: -80,
    location_source: 'approximate_state', status_needs_review: false,
  });
  assert.equal(s.map_marker.dashed, true);
});
