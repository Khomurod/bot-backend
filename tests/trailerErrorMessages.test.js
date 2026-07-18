/**
 * Plain-language error mapping — routes must answer {error, code} with a human
 * sentence, never a raw pg error.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { humanMessage, errorPayload } = require('../services/trailerErrorMessages');

test('known codes map to short human sentences', () => {
  assert.match(humanMessage({ code: 'TRAILER_OVERLAP' }), /already booked/);
  assert.match(humanMessage({ code: 'VERSION_CONFLICT' }), /changed while you were editing/);
  assert.match(humanMessage({ code: '23P01' }), /already booked/);
});

test('a service-phrased 4xx message survives when unmapped', () => {
  const err = Object.assign(new Error('Pickup and return times are required.'), { status: 400 });
  assert.equal(humanMessage(err), 'Pickup and return times are required.');
});

test('500s never leak internals', () => {
  const err = new Error('relation "x" does not exist');
  const { status, payload } = errorPayload(err);
  assert.equal(status, 500);
  assert.ok(!/relation/.test(payload.error));
});

test('pg constraint codes become 409s and version conflicts carry currentVersion', () => {
  assert.equal(errorPayload(Object.assign(new Error('x'), { code: '23P01' })).status, 409);
  const conflict = errorPayload(Object.assign(new Error('x'), { status: 409, code: 'VERSION_CONFLICT', currentVersion: 7 }));
  assert.equal(conflict.payload.currentVersion, 7);
});
