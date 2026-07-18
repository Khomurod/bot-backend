/**
 * Pure keyboard-navigation helpers for the shared accessible components (§8):
 * focus-trap wrap-around and tablist arrow-key roving.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.resolve(__dirname, '../admin/src/pages/trailer/a11y/keys.js');
let m;
test.before(async () => { m = await import(pathToFileURL(MODULE).href); });

test('focus trap wraps forward and backward', () => {
  assert.equal(m.nextTrapIndex(0, 3, false), 1);
  assert.equal(m.nextTrapIndex(2, 3, false), 0); // wrap to first
  assert.equal(m.nextTrapIndex(0, 3, true), 2);  // shift wraps to last
  assert.equal(m.nextTrapIndex(1, 3, true), 0);
  assert.equal(m.nextTrapIndex(0, 0, false), 0); // empty container
});

test('tablist arrow keys rove with wrap, Home/End jump', () => {
  assert.equal(m.nextTabIndex(0, 4, 'ArrowRight'), 1);
  assert.equal(m.nextTabIndex(3, 4, 'ArrowRight'), 0); // wrap
  assert.equal(m.nextTabIndex(0, 4, 'ArrowLeft'), 3);  // wrap back
  assert.equal(m.nextTabIndex(2, 4, 'ArrowLeft'), 1);
  assert.equal(m.nextTabIndex(2, 4, 'Home'), 0);
  assert.equal(m.nextTabIndex(0, 4, 'End'), 3);
  assert.equal(m.nextTabIndex(1, 4, 'Enter'), 1); // unrelated key: no move
  assert.equal(m.nextTabIndex(1, 4, 'ArrowUp'), 0);
  assert.equal(m.nextTabIndex(1, 4, 'ArrowDown'), 2);
});

test('activation keys are Enter and Space only', () => {
  assert.equal(m.isActivationKey('Enter'), true);
  assert.equal(m.isActivationKey(' '), true);
  assert.equal(m.isActivationKey('Spacebar'), true);
  assert.equal(m.isActivationKey('a'), false);
  assert.equal(m.isActivationKey('Tab'), false);
});
