'use strict';

/**
 * A truck number is not a number.
 *
 * Production carries ten unit numbers on more than one active driver group,
 * `001` on four of them. Anything that reduces `001` to `1` before comparing
 * will merge people, which is the one outcome this whole programme forbids —
 * so the strong key keeps leading zeros and letters, and the weak one is
 * allowed to suggest and never to act.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeBoardTruck, digitsOnlyTruck, truckComparisonKeys, compareTrucks,
} = require('../lib/board/truck');

test('the prefixes a dispatcher types are stripped, the identity is not', () => {
  assert.equal(normalizeBoardTruck('#310'), '310');
  assert.equal(normalizeBoardTruck('UNIT 27'), '27');
  assert.equal(normalizeBoardTruck('unit # 7'), '7');
  assert.equal(normalizeBoardTruck('  001A '), '001A');
  assert.equal(normalizeBoardTruck('001 A'), '001A');
});

test('leading zeros and letter suffixes survive the strong key', () => {
  assert.equal(normalizeBoardTruck('001'), '001');
  assert.notEqual(normalizeBoardTruck('001'), normalizeBoardTruck('1'));
  assert.notEqual(normalizeBoardTruck('001'), normalizeBoardTruck('001A'));
});

test('the weak key is the one the location service already uses', () => {
  assert.equal(digitsOnlyTruck('001'), '1');
  assert.equal(digitsOnlyTruck('001A'), '1');
  assert.equal(digitsOnlyTruck('#310'), '310');
  assert.equal(digitsOnlyTruck('no truck'), null);
});

test('nothing in, nothing out — never an empty-string key', () => {
  for (const input of [null, undefined, '', '   ', '#', 'UNIT', 'unit # ']) {
    assert.equal(truckComparisonKeys(input).exact, null, JSON.stringify(input));
  }
});

test('a match says HOW it matched, so only the exact one may act', () => {
  assert.equal(compareTrucks('#310', 'UNIT 310'), 'exact');
  assert.equal(compareTrucks('001', '1'), 'digits');
  assert.equal(compareTrucks('001', '001A'), 'digits');
  assert.equal(compareTrucks('001', '002'), 'none');
  assert.equal(compareTrucks('', '001'), 'none');
});
