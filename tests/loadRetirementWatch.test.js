'use strict';

/**
 * The lifecycle pass retires what the board stopped returning — and only on a
 * read it can trust.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const watcher = require('../services/loads/lifecycleWatch');
const {
  NOW, at, SHIPPER, ORDER, harness,
} = require('./helpers/loadWatchHarness');

test('the orders the board returned are handed over as "still current"', async () => {
  const { deps, calls } = harness({
    orders: [ORDER, { ...ORDER, orderId: 'ORD-2' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.deepEqual(calls.retireCalls, [['ORD-1', 'ORD-2']]);
});

test('seen means what recorded means — the SAME order id extraction', async () => {
  const { deps, calls } = harness({ orders: [{ raw: 'A' }, { raw: 'B' }, { raw: null }] });
  deps.loads.extractLoadFromOrder = (o) => (o.raw ? { ...ORDER, orderId: `X-${o.raw}` } : null);
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.deepEqual(calls.retireCalls, [['X-A', 'X-B']]);
});

test('A FAILED READ RETIRES NOTHING — the order list is the last good one, not the truth', async () => {
  const { deps, calls } = harness({
    orders: [ORDER],
    orderError: { provider: 'datatruck', code: 'ETIMEDOUT', message: 'timed out' },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(calls.retireCalls.length, 0);
});

test('an empty board retires nothing either', async () => {
  const { deps, calls } = harness({ orders: [] });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.skipped, 'no_active_orders');
  assert.equal(calls.retireCalls.length, 0);
});

test('the count is reported, and a store without the call costs the retirement, not the pass', async () => {
  const counted = harness({ orders: [ORDER] });
  counted.deps.store.retireMissingLoads = async () => ({ retired: 4, delivered: 1 });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps: counted.deps });
  assert.equal(summary.retired, 4);

  const partial = harness({ orders: [ORDER] });
  delete partial.deps.store.retireMissingLoads;
  const out = await watcher.runLoadLifecycleCheck({ now: NOW, deps: partial.deps });
  assert.equal(out.checked, 1);
  assert.equal(out.error, undefined);
});
