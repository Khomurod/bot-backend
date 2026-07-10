/**
 * Multi-trailer message parsing (services/trailerMessageParser.parseTrailerMessageEvents).
 * A single driver message may name several trailers; each becomes its own event.
 * Pure functions — no env / DB / network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../services/trailerMessageParser');

test('single-unit message still returns exactly one event (backward compatible)', () => {
  const out = p.parseTrailerMessageEvents('trl # ST508998 dropped off. Location: Lancaster PA');
  assert.equal(out.length, 1);
  assert.equal(out[0].eventType, 'dropoff');
  assert.equal(out[0].trailerUnit, 'ST508998');
  assert.equal(out[0].locationText, 'Lancaster PA');
});

test('non-trailer message returns one non-trailer result', () => {
  const out = p.parseTrailerMessageEvents('good morning team');
  assert.equal(out.length, 1);
  assert.equal(out[0].isTrailerRelated, false);
});

test('two trailers on two lines → two events (pickup + dropoff)', () => {
  const out = p.parseTrailerMessageEvents('TRL# 403279 picked up\nTRL# 171847 dropped');
  assert.equal(out.length, 2);
  assert.equal(out[0].trailerUnit, '403279');
  assert.equal(out[0].eventType, 'pickup');
  assert.equal(out[0].eventIndex, 0);
  assert.equal(out[1].trailerUnit, '171847');
  assert.equal(out[1].eventType, 'dropoff');
  assert.equal(out[1].eventIndex, 1);
});

test('two trailers each with their own location line', () => {
  const out = p.parseTrailerMessageEvents(
    'trl # VT700669 picked up by ENICSON JEAN\nlocation Lancaster PA\n'
    + 'trl # ST508998 dropped by ENICSON JEAN\nlocation Reno NV'
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].trailerUnit, 'VT700669');
  assert.equal(out[0].eventType, 'pickup');
  assert.equal(out[0].locationText, 'Lancaster PA');
  assert.equal(out[1].trailerUnit, 'ST508998');
  assert.equal(out[1].eventType, 'dropoff');
  assert.equal(out[1].locationText, 'Reno NV');
});

test('a shared leading location backfills segments that lack their own', () => {
  const out = p.parseTrailerMessageEvents(
    'Location: Dallas TX\ntrl # AB1001 picked up\ntrl # CD2002 picked up'
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].locationText, 'Dallas TX');
  assert.equal(out[1].locationText, 'Dallas TX');
});

test('ambiguous bare units with no label collapse to the single-event path', () => {
  // No "trl"/"trailer"/"#" label → not split into two; safe single-event result.
  const out = p.parseTrailerMessageEvents('403279 picked up, 171847 dropped');
  assert.equal(out.length, 1);
  // Not trailer-related (no keyword/label) → caller ignores; never guesses.
  assert.equal(out[0].isTrailerRelated, false);
});

test('findUnitTokens only collects labelled / # units', () => {
  const toks = p.findUnitTokens('TRL# 403279 picked up TRL# 171847 dropped');
  assert.equal(toks.length, 2);
  assert.deepEqual(toks.map((t) => t.unit), ['403279', '171847']);
});
