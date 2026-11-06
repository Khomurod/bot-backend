'use strict';

/**
 * lib/truckPhotos/chunk.js — more than sixty photos become several PDFs, each
 * under Telegram's 50 MB document limit. The boundaries the owner will see:
 * 60 is one PDF, 61 is two, 120 is two, 121 is three.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { chunk, DEFAULT_PART_SIZE } = require('../lib/truckPhotos/chunk');

const n = (count) => Array.from({ length: count }, (_, i) => i + 1);
const sizes = (parts) => parts.map((p) => p.length);

test('60 / 61 / 120 / 121 photos', () => {
  assert.equal(DEFAULT_PART_SIZE, 60);
  assert.deepEqual(sizes(chunk(n(60))), [60]);
  assert.deepEqual(sizes(chunk(n(61))), [60, 1]);
  assert.deepEqual(sizes(chunk(n(120))), [60, 60]);
  assert.deepEqual(sizes(chunk(n(121))), [60, 60, 1]);
});

test('every photo is in exactly one part, in order', () => {
  const parts = chunk(n(121));
  assert.deepEqual(parts.flat(), n(121));
});

test('a smaller part size is honoured; a nonsense one falls back to 60', () => {
  assert.deepEqual(sizes(chunk(n(10), 4)), [4, 4, 2]);
  for (const bad of [0, -3, 2.5, '8', null]) assert.deepEqual(sizes(chunk(n(61), bad)), [60, 1], String(bad));
});

test('no photos are no parts', () => {
  assert.deepEqual(chunk([]), []);
  assert.deepEqual(chunk(undefined), []);
});
