'use strict';

/**
 * lib/truckPhotos/trigger.js — which messages mark a hand-over, and which of
 * them are bare enough to need no model. "outbound load from Chicago" is the
 * case the owner named: the word is there, and it is not about the truck, so it
 * must never be treated as bare.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { readTrigger } = require('../lib/truckPhotos/trigger');

test('the bare word, in any case, with "truck", "#", emoji and punctuation, is bare', () => {
  for (const text of [
    'outbound', 'OUTBOUND', 'Inbound', '#outbound', '#Inbound', 'outbound truck', 'Truck outbound!',
    'outbound ✅', 'inbound 🚛👍🏽', '  Outbound.  ', 'outbound — truck', '🇺🇸 inbound', 'outbound trucks',
  ]) {
    const got = readTrigger(text);
    assert.ok(got, `${text} is a trigger`);
    assert.equal(got.bare, true, `${text} is bare`);
  }
  assert.deepEqual(readTrigger('outbound'), { kind: 'outbound', bare: true });
  assert.deepEqual(readTrigger('#INBOUND'), { kind: 'inbound', bare: true });
});

test('"outbound load from Chicago" is a trigger that is NOT bare — a model must look at it', () => {
  assert.deepEqual(readTrigger('outbound load from Chicago'), { kind: 'outbound', bare: false });
  assert.deepEqual(readTrigger('Inbound shipment at the dock'), { kind: 'inbound', bare: false });
  assert.deepEqual(readTrigger('inbound 562'), { kind: 'inbound', bare: false }, 'a number is more than the word');
  assert.deepEqual(readTrigger('truck 562 outbound to Mike today'), { kind: 'outbound', bare: false });
});

test('only a whole word counts', () => {
  for (const text of ['outbounds', 'inboundcall', 'outbound_load', 'reinbound', 'out bound', 'in-bound']) {
    assert.equal(readTrigger(text), null, text);
  }
  assert.ok(readTrigger('(outbound)'), 'brackets are not letters');
});

test('both words in one message ask for two different PDFs, so neither is made', () => {
  assert.equal(readTrigger('inbound/outbound inspection'), null);
  assert.equal(readTrigger('Outbound and inbound'), null);
  assert.deepEqual(readTrigger('outbound outbound'), { kind: 'outbound', bare: true }, 'the same word twice is one word');
});

test('no text, or no word, is no trigger', () => {
  for (const value of [undefined, null, '', '   ', 42, 'Status: Home', 'on my way']) {
    assert.equal(readTrigger(value), null, String(value));
  }
});
