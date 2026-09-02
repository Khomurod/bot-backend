'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { deriveAgreementStatus } = require('../lib/trailers/statusDerivation');

const items = (...s) => s.map((item_status) => ({ item_status }));

test('no items → draft', () => {
  assert.equal(deriveAgreementStatus([]), 'draft');
});

test('all draft → draft', () => {
  assert.equal(deriveAgreementStatus(items('draft', 'draft')), 'draft');
});

test('all scheduled → scheduled', () => {
  assert.equal(deriveAgreementStatus(items('scheduled', 'scheduled')), 'scheduled');
});

test('scheduled + draft → scheduled', () => {
  assert.equal(deriveAgreementStatus(items('scheduled', 'draft')), 'scheduled');
});

test('all active → active', () => {
  assert.equal(deriveAgreementStatus(items('active', 'active')), 'active');
});

test('active + scheduled → partially_active', () => {
  assert.equal(deriveAgreementStatus(items('active', 'scheduled')), 'partially_active');
});

test('active + draft → partially_active', () => {
  assert.equal(deriveAgreementStatus(items('active', 'draft')), 'partially_active');
});

test('returned + active → partially_returned', () => {
  assert.equal(deriveAgreementStatus(items('returned', 'active')), 'partially_returned');
});

test('returned + scheduled → partially_returned', () => {
  assert.equal(deriveAgreementStatus(items('returned', 'scheduled')), 'partially_returned');
});

test('all returned → returned', () => {
  assert.equal(deriveAgreementStatus(items('returned', 'returned')), 'returned');
});

test('explicit closed overrides everything', () => {
  assert.equal(deriveAgreementStatus(items('active', 'returned'), { explicitClosed: true }), 'closed');
});

test('any disputed item → disputed', () => {
  assert.equal(deriveAgreementStatus(items('active', 'disputed')), 'disputed');
});

test('cancelled/removed/replaced items are ignored as terminal', () => {
  assert.equal(deriveAgreementStatus(items('active', 'cancelled', 'replaced')), 'active');
});

test('only terminal items → cancelled', () => {
  assert.equal(deriveAgreementStatus(items('cancelled', 'removed_before_pickup')), 'cancelled');
});

test('returned + removed(terminal) → returned', () => {
  assert.equal(deriveAgreementStatus(items('returned', 'removed_before_pickup')), 'returned');
});
