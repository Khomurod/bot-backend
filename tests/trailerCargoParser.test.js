/**
 * Parser possession + cargo status (unified trailer state).
 * Core business rule: a DROPPED trailer defaults to EMPTY unless the message
 * clearly says loaded; a PICKED-UP trailer's cargo is UNKNOWN unless stated.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../services/trailerMessageParser');

function one(msg) { return p.parseTrailerMessage(msg); }

test('dropped without loaded → dropped / empty', () => {
  const r = one('TRL# 171847 dropped');
  assert.equal(r.eventType, 'dropoff');
  assert.equal(r.possessionStatus, 'dropped');
  assert.equal(r.cargoStatus, 'empty');
});

test('dropped off → dropped / empty', () => {
  const r = one('TRL# 171847 dropped off');
  assert.equal(r.possessionStatus, 'dropped');
  assert.equal(r.cargoStatus, 'empty');
});

test('dropped loaded → dropped / loaded', () => {
  const r = one('TRL# 171847 dropped loaded');
  assert.equal(r.possessionStatus, 'dropped');
  assert.equal(r.cargoStatus, 'loaded');
});

test('loaded trailer dropped → dropped / loaded', () => {
  const r = one('TRL# 171847 loaded trailer dropped');
  assert.equal(r.possessionStatus, 'dropped');
  assert.equal(r.cargoStatus, 'loaded');
});

test('dropped with load → dropped / loaded', () => {
  const r = one('TRL# 171847 dropped with load');
  assert.equal(r.possessionStatus, 'dropped');
  assert.equal(r.cargoStatus, 'loaded');
});

test('sealed dropoff → dropped / loaded', () => {
  const r = one('TRL# 171847 dropped, sealed');
  assert.equal(r.cargoStatus, 'loaded');
});

test('picked up → with_driver / unknown', () => {
  const r = one('TRL# 403279 picked up');
  assert.equal(r.eventType, 'pickup');
  assert.equal(r.possessionStatus, 'with_driver');
  assert.equal(r.cargoStatus, 'unknown');
});

test('picked up empty → with_driver / empty', () => {
  const r = one('TRL# 403279 picked up empty');
  assert.equal(r.possessionStatus, 'with_driver');
  assert.equal(r.cargoStatus, 'empty');
});

test('picked up loaded → with_driver / loaded', () => {
  const r = one('TRL# 403279 picked up loaded');
  assert.equal(r.possessionStatus, 'with_driver');
  assert.equal(r.cargoStatus, 'loaded');
});

test('picked up MT → with_driver / empty', () => {
  const r = one('TRL# 403279 picked up mt');
  assert.equal(r.cargoStatus, 'empty');
});

test('condition "no pictures" does NOT affect cargo (still dropped/empty default)', () => {
  const r = one('trl # ST508998\nDropped\nLocation: Lancaster PA\nCondition: no pictures');
  assert.equal(r.possessionStatus, 'dropped');
  assert.equal(r.cargoStatus, 'empty');
  assert.equal(r.conditionText, 'no pictures');
});

test('conflicting cargo wording (loaded + empty) → unknown + review', () => {
  const r = one('TRL# 403279 picked up loaded but empty');
  assert.equal(r.cargoStatus, 'unknown');
  assert.equal(r.needsReview, true);
});

test('mention only (no action) → possession unknown, cargo unknown', () => {
  const r = one('trailer TRL# 403279 at the yard');
  assert.equal(r.eventType, 'mention_only');
  assert.equal(r.possessionStatus, 'unknown');
  assert.equal(r.cargoStatus, 'unknown');
});

test('never crashes on messy text', () => {
  for (const junk of ['', '   ', '🚚🚚🚚', 'lorem ipsum', 'TRL#', '#### dropped loaded empty mt']) {
    assert.doesNotThrow(() => one(junk));
    assert.doesNotThrow(() => p.parseTrailerMessageEvents(junk));
  }
});

test('multi-trailer message: independent possession + cargo per unit', () => {
  const events = p.parseTrailerMessageEvents('TRL# 403279 picked up empty\nTRL# 171847 dropped loaded');
  assert.equal(events.length, 2);
  const byUnit = Object.fromEntries(events.map((e) => [e.trailerUnit, e]));
  assert.equal(byUnit['403279'].possessionStatus, 'with_driver');
  assert.equal(byUnit['403279'].cargoStatus, 'empty');
  assert.equal(byUnit['171847'].possessionStatus, 'dropped');
  assert.equal(byUnit['171847'].cargoStatus, 'loaded');
});

test('multi-trailer default: pickup unknown cargo, dropoff empty cargo', () => {
  const events = p.parseTrailerMessageEvents('TRL# 403279 picked up\nTRL# 171847 dropped');
  const byUnit = Object.fromEntries(events.map((e) => [e.trailerUnit, e]));
  assert.equal(byUnit['403279'].cargoStatus, 'unknown');
  assert.equal(byUnit['171847'].cargoStatus, 'empty');
});

test('resolveCargoPossession helper is pure and matches the rule', () => {
  assert.deepEqual(
    p.resolveCargoPossession('dropped', 'dropoff'),
    { possessionStatus: 'dropped', cargoStatus: 'empty', cargoAmbiguous: false }
  );
  assert.deepEqual(
    p.resolveCargoPossession('picked up', 'pickup'),
    { possessionStatus: 'with_driver', cargoStatus: 'unknown', cargoAmbiguous: false }
  );
});
