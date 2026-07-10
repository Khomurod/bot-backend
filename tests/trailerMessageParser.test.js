/**
 * Unit tests for services/trailerMessageParser.js — the deterministic trailer
 * message parser (no AI). Covers the task's canonical examples plus edge cases.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../services/trailerMessageParser');

test('example 1: trl # ST508998 dropped → dropoff with all fields', () => {
  const r = p.parseTrailerMessage(
    'trl # ST508998\nDropped by: ENICSON JEAN\nLocation: Lancaster PA\nDate: 7/10\nCondition: no pictures'
  );
  assert.equal(r.eventType, 'dropoff');
  assert.equal(r.trailerUnit, 'ST508998');
  assert.equal(r.locationText, 'Lancaster PA');
  assert.equal(r.conditionText, 'no pictures');
  assert.equal(r.eventDateText, '7/10');
  assert.equal(r.reportedDriverName, 'ENICSON JEAN');
  assert.equal(r.needsReview, false);
  assert.ok(r.confidence >= 75);
});

test('example 2: trl # VT700669 picked up → pickup', () => {
  const r = p.parseTrailerMessage(
    'trl # VT700669\nPicked up by: ENICSON JEAN\nLocation: Lancaster PA\nDate: 7/10\nCondition: no pictures'
  );
  assert.equal(r.eventType, 'pickup');
  assert.equal(r.trailerUnit, 'VT700669');
  assert.equal(r.locationText, 'Lancaster PA');
});

test('example 3: trl # VM709984 Picked up back → pickup, no location, needs review', () => {
  const r = p.parseTrailerMessage('trl # VM709984\nPicked up back');
  assert.equal(r.eventType, 'pickup');
  assert.equal(r.trailerUnit, 'VM709984');
  assert.equal(r.locationText, null);
  assert.equal(r.needsReview, true);
});

test('trailer mention with no action → unidentified', () => {
  for (const msg of ['trailer?', 'trl', 'trailer issue', 'trailer is there']) {
    const r = p.parseTrailerMessage(msg);
    assert.equal(r.isTrailerRelated, true);
    assert.equal(r.eventType, 'unidentified');
    assert.equal(r.trailerUnit, null);
  }
});

test('unit mentioned with no clear action → mention_only', () => {
  const r = p.parseTrailerMessage('trailer ST508998 is at the yard somewhere');
  assert.equal(r.eventType, 'mention_only');
  assert.equal(r.trailerUnit, 'ST508998');
  assert.equal(r.needsReview, true);
});

test('action without a unit → unidentified (cannot register)', () => {
  const r = p.parseTrailerMessage('grabbed trailer at the yard');
  assert.equal(r.eventType, 'unidentified');
  assert.equal(r.trailerUnit, null);
});

test('non-trailer message → not trailer related', () => {
  const r = p.parseTrailerMessage('running late, will be there in 2 hours');
  assert.equal(r.isTrailerRelated, false);
});

test('Cyrillic / mixed text does not crash and still parses a clear action', () => {
  const r = p.parseTrailerMessage('Привет trailer ST123 dropped off здесь');
  assert.equal(r.eventType, 'dropoff');
  assert.equal(r.trailerUnit, 'ST123');
});

test('empty / whitespace input is safe', () => {
  assert.equal(p.parseTrailerMessage('').isTrailerRelated, false);
  assert.equal(p.parseTrailerMessage('   ').isTrailerRelated, false);
  assert.equal(p.parseTrailerMessage(null).isTrailerRelated, false);
});

test('unit normalization strips # and spaces, uppercases', () => {
  assert.equal(p.normalizeUnitNumber('  st50-8998 '), 'ST50-8998');
  assert.equal(p.normalizeUnitNumber('#vt700669'), 'VT700669');
  assert.equal(p.extractUnitNumber('trailer # vt700669 picked up'), 'VT700669');
});

test('condition extraction from keyword without a Condition: label', () => {
  const r = p.parseTrailerMessage('trl 4455 dropped off, flat tire on the rear');
  assert.equal(r.eventType, 'dropoff');
  assert.equal(r.conditionText, 'flat tire');
});

test('location extraction stops at line end', () => {
  const r = p.parseTrailerMessage('trl # AB123 picked up\nLocation: Dallas TX\nDate: 1/2');
  assert.equal(r.locationText, 'Dallas TX');
});

test('reporter/sender captured from "Picked up by:"', () => {
  const r = p.parseTrailerMessage('trl # AB123\nPicked up by: John Smith\nLocation: Reno NV');
  assert.equal(r.reportedDriverName, 'John Smith');
});

test('variants: hooked / swapped / grabbed with a unit are pickups', () => {
  assert.equal(p.parseTrailerMessage('hooked trailer VT999 at yard').eventType, 'pickup');
  assert.equal(p.parseTrailerMessage('swapped trailer to AB100').eventType, 'pickup');
});

test('variants: left trailer / dropped are dropoffs', () => {
  assert.equal(p.parseTrailerMessage('left trailer ST200 empty').eventType, 'dropoff');
  assert.equal(p.parseTrailerMessage('trailer dropped ST201').eventType, 'dropoff');
});

test('shouldUseAiFallback: confident action → false, unclear → true', () => {
  const clear = p.parseTrailerMessage('trl # ST508998 picked up\nLocation: Reno NV');
  assert.equal(p.shouldUseAiFallback(clear), false);
  const vague = p.parseTrailerMessage('trailer?');
  assert.equal(p.shouldUseAiFallback(vague), true);
});
