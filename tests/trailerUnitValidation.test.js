/**
 * Strict trailer-unit validation (services/trailerUnitValidation.js) — the
 * gatekeeper for what may become a trailer unit in the responsibility ledger.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const v = require('../services/trailerUnitValidation');
const p = require('../services/trailerMessageParser');

// ── reserved words ──

test('TRL is rejected (reserved word)', () => {
  assert.equal(v.isValidTrailerUnitFormat('TRL').valid, false);
  assert.equal(v.validateTrailerUnit('TRL', { currentText: 'shu TRL ni olasiz' }).valid, false);
});

test('TRAILER is rejected (reserved word)', () => {
  assert.equal(v.isValidTrailerUnitFormat('TRAILER').valid, false);
  assert.equal(v.validateTrailerUnit('trailer', { currentText: 'trailer dropped' }).valid, false);
});

test('UNIT / PICKUP / DROPPED / LOADED / EMPTY / UNKNOWN are rejected', () => {
  for (const w of ['UNIT', 'PICKUP', 'DROPPED', 'DROP', 'LOADED', 'EMPTY', 'UNKNOWN', 'TRAIL']) {
    assert.equal(v.isValidTrailerUnitFormat(w).valid, false, `${w} must be rejected`);
  }
});

// ── format rules ──

test('units without a digit are rejected', () => {
  assert.equal(v.isValidTrailerUnitFormat('ABCDEF').valid, false);
});

test('too-short and too-long units are rejected', () => {
  assert.equal(v.isValidTrailerUnitFormat('A1').valid, false);
  assert.equal(v.isValidTrailerUnitFormat('123').valid, false);
  assert.equal(v.isValidTrailerUnitFormat('A'.repeat(20) + '1').valid, false);
});

test('invalid characters are rejected', () => {
  assert.equal(v.isValidTrailerUnitFormat('AB_1234').valid, false);
  assert.equal(v.isValidTrailerUnitFormat('AB.1234').valid, false);
});

test('SWFZ233611 has a valid format', () => {
  assert.equal(v.isValidTrailerUnitFormat('SWFZ233611').valid, true);
});

// ── grounding ──

test('SWFZ233611 is accepted when grounded in replied image units', () => {
  const res = v.validateTrailerUnit('SWFZ233611', {
    currentText: 'oldim',
    repliedImageUnits: [{ value: 'SWFZ233611', exactEvidence: 'Trailer #: SWFZ233611' }],
  });
  assert.equal(res.valid, true);
  assert.equal(res.source, 'replied_image');
});

test('SWFZ233611 is rejected when not grounded anywhere', () => {
  const res = v.validateTrailerUnit('SWFZ233611', { currentText: 'oldim' });
  assert.equal(res.valid, false);
});

test('403279 is accepted when trailer-labelled in the current text', () => {
  const res = v.validateTrailerUnit('403279', { currentText: 'Picked up trailer 403279' });
  assert.equal(res.valid, true);
  assert.equal(res.source, 'current_text');
});

test('digit-only unit is NOT grounded by a longer number', () => {
  const res = v.validateTrailerUnit('5829', { currentText: 'ref 58290 dropped' });
  assert.equal(res.valid, false);
});

test('unit grounded via replied text', () => {
  const res = v.validateTrailerUnit('VT700669', { currentText: 'oldim', repliedText: 'take trl # VT700669' });
  assert.equal(res.valid, true);
  assert.equal(res.source, 'replied_text');
});

// ── facility / load / door numbers (regressions) ──

test('Home Depot MDO/DFC #5829 does not validate 5829 as a trailer', () => {
  const text = 'Trailer 403279 dropped\nLocation: Home Depot MDO/DFC #5829\nCondition: no full pictures';
  assert.equal(v.isNonTrailerContextNumber('5829', text), true);
  assert.equal(v.validateTrailerUnit('5829', { currentText: text }).valid, false);
  // The real trailer in the same message still validates.
  assert.equal(v.validateTrailerUnit('403279', { currentText: text }).valid, true);
});

test('Load #9492869 does not validate as a trailer', () => {
  const text = 'trailer picked up for Load #9492869';
  assert.equal(v.isNonTrailerContextNumber('9492869', text), true);
  assert.equal(v.validateTrailerUnit('9492869', { currentText: text }).valid, false);
});

test('Door / PO / Exit / Store numbers are facility numbers', () => {
  for (const [num, text] of [
    ['2525', 'trailer at Door #2525'],
    ['12345', 'trailer PO #12345'],
    ['1717', 'trailer near Exit #1717'],
    ['8000', 'trailer behind Store #8000'],
  ]) {
    assert.equal(v.isNonTrailerContextNumber(num, text), true, `${text} must reject ${num}`);
  }
});

test('TRL #403279 (trailer-labelled) is NOT a facility number', () => {
  assert.equal(v.isNonTrailerContextNumber('403279', 'TRL #403279 picked up'), false);
  assert.equal(v.validateTrailerUnit('403279', { currentText: 'TRL #403279 picked up' }).valid, true);
});

// ── parser integration (extraction level) ──

test('parser does not extract 5829 from "Home Depot MDO/DFC #5829"', () => {
  const events = p.parseTrailerMessageEvents(
    'Trailer 403279 dropped\nLocation: Home Depot MDO/DFC #5829\nCondition: no full pictures'
  );
  const units = events.map((e) => e.trailerUnit).filter(Boolean);
  assert.deepEqual(units, ['403279']);
});

test('parser does not extract a unit from "Load #9492869" alone', () => {
  const one = p.parseTrailerMessage('trailer update: Load #9492869');
  assert.equal(one.trailerUnit, null);
});

test('parser never extracts TRL as a unit ("shu TRL ni olasiz")', () => {
  const one = p.parseTrailerMessage('shu TRL ni olasiz');
  assert.equal(one.trailerUnit, null);
  assert.notEqual(one.eventType, 'pickup');
  assert.notEqual(one.eventType, 'dropoff');
});
