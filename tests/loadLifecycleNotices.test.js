/**
 * What the load-lifecycle notices actually SAY.
 *
 * Production, 2026-10: the chat read "[redacted]" where the reason belonged,
 * named drivers by order id, alarmed about trucks that were simply being
 * loaded, and reported loads whose two addresses were the same place as a
 * board disagreement. Each test here is one of those.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const watcher = require('../services/loads/lifecycleWatch');

const {
  NOW, at, SHIPPER, ORDER, harness,
} = require('./helpers/loadWatchHarness');

// ── what the chat actually reads (production, 2026-10) ──────────────────────

test('the REASON is a sentence, never a code the credential filter blanks out', async () => {
  const { composeNotice } = require('../lib/notifications/compose');
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'delivered' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  const n = calls.notified[0];
  assert.equal(n.reason.includes('_'), false, n.reason);
  assert.match(n.reason, /Datatruck says delivered/);
  const body = composeNotice({ title: n.title, lines: n.lines, reason: n.reason, action: n.action });
  assert.equal(body.includes('[redacted]'), false,
    'production showed "[redacted]" where the reason should be — the 50-character '
    + 'code looked like a credential to the composer');
});

test('the notice names the DRIVER, not just a number', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'delivered' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
    groups: [{ id: 7, group_name: 'WENZE UNIT # 310 TEST DRIVER (COMPANY DRIVER)' }],
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.match(calls.notified[0].title, /^Unit 310 — TEST DRIVER:/);
  assert.match(calls.findings[0].title, /^Unit 310 — TEST DRIVER:/);
});

test('the repeat guard reads the key the notice is ACTUALLY stored under', async () => {
  // It read `load:<id>`; every stored key starts with the category, so the
  // guard never matched anything.
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'delivered' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  const { noticeKeyFor } = require('../lib/notifications/compose');
  const n = calls.notified[0];
  const stored = noticeKeyFor(n.category, n.subjectType, n.subjectId, n.discriminator);
  assert.equal(calls.windows.length, 1);
  assert.ok(stored.startsWith(calls.windows[0].prefix), `${stored} vs ${calls.windows[0].prefix}`);
  assert.equal(calls.windows[0].prefix, 'load_lifecycle:load:ORD-1:',
    'with the trailing colon, so order 12 never matches order 123');
});

test('a truck that just arrived at the shipper under a "loaded" board is being loaded — no alarm', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'in_transit' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
    stored: {
      orderId: 'ORD-1', phase: 'at_pickup', phaseSince: at(40), wasAtPickup: true, firstAtPickupAt: at(40),
    },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.conflicts, 0);
  assert.equal(calls.notified.length, 0);
});

test('a truck that LEFT and came back starts a new loading window (review, PR #259)', async () => {
  // First visit four hours ago, but this stay began ten minutes ago: the
  // at_pickup phase started again when it returned.
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'in_transit' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
    stored: {
      orderId: 'ORD-1', phase: 'at_pickup', phaseSince: at(10), wasAtPickup: true, firstAtPickupAt: at(240),
    },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.conflicts, 0);
  assert.equal(calls.notified.length, 0);
});

test('a truck just ARRIVING (another phase before) is being loaded, not late', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'in_transit' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
    stored: { orderId: 'ORD-1', phase: 'heading_to_pickup', phaseSince: at(600), firstAtPickupAt: at(900) },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 0);
});

test('NO DRIVER NAME when the unit is on two active groups (review, PR #259)', async () => {
  // groupsByUnit keeps the first group; naming its driver would pin the load on
  // somebody who may not be carrying it.
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'delivered' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
    groups: [
      { id: 7, group_name: 'WENZE UNIT # 310 FIRST DRIVER (COMPANY DRIVER)' },
      { id: 8, group_name: 'WENZE UNIT # 310 SECOND DRIVER' },
    ],
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.match(calls.notified[0].title, /^Unit 310:/);
  assert.doesNotMatch(calls.notified[0].title, /DRIVER/);
});

test('NO DRIVER NAME when the unit has no single holder', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'delivered' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
    groups: [{ id: 7, group_name: 'WENZE UNIT # 310 TEST DRIVER (COMPANY DRIVER)' }],
    holders: [{ personId: 11, unitNumber: '310' }, { personId: 12, unitNumber: '310' }],
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.match(calls.notified[0].title, /^Unit 310:/);
});

test('the same pickup and delivery address is said ONCE, as an address problem', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, deliveryLat: SHIPPER.lat, deliveryLng: SHIPPER.lng, status: 'delivered' }],
    position: { lat: 36, lng: -95, speedMph: 60, at: at(5) },
  });
  deps.notifications.noticeSentWithin = async () => true; // irrelevant: never consulted
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.conflicts, 0, 'nothing is concluded from coordinates that cannot be right');
  assert.equal(calls.findings.length, 1);
  assert.match(calls.findings[0].title, /addresses need checking/);
  const n = calls.notified[0];
  assert.equal(n.subjectType, 'load_address');
  assert.equal(n.discriminator, null, 'one notice per load, not one a day — the key dedupes it');
  assert.match(n.title, /pickup and delivery addresses are the same/);
  assert.match(n.action, /Datatruck/);
});
