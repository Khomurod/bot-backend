/**
 * The load-lifecycle pass, with the load board and the fleet replaced.
 *
 * Three promises the pure rules cannot make on their own: a pass costs the same
 * for ninety loads as for one, a load whose phase is unclear becomes a question
 * for a person rather than a guess, and the driver on a load is the PERSON, not
 * the chat — so a truck change does not detach a load from its history.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const watcher = require('../services/loads/lifecycleWatch');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const at = (mins) => new Date(NOW - mins * 60000).toISOString();
const SHIPPER = { lat: 41.88, lng: -87.63 };
const RECEIVER = { lat: 39.10, lng: -84.50 };

function harness({
  orders = [], position = null, stored = null, groups = [{ id: 7, group_name: 'WENZE UNIT # 310 A DRIVER' }],
  person = { personId: 11, unitNumber: '310' },
} = {}) {
  const calls = { fleets: 0, orders: 0, findings: [], written: [], resolved: [], pruned: 0 };
  const deps = {
    store: {
      async getLoadState() { return stored; },
      async recordLoadObservation(orderId, patch) {
        calls.written.push({ orderId, ...patch });
        return { orderId, ...patch };
      },
      async pruneFinishedLoads() { calls.pruned += 1; return 0; },
    },
    groups: { async getDriverGroupsByActiveFilter() { return groups; } },
    people: { async getOpenPersonForUnit() { return person; } },
    findings: {
      async upsertFinding(f) { calls.findings.push(f); return { id: calls.findings.length, ...f }; },
      async resolveClearedFindings(keys, keep) { calls.resolved.push({ keys, keep }); return 0; },
    },
    eldSettings: { async getEldConfig() { return { samsaraEnabled: true }; } },
    providers: {
      async fetchProviderFleets() {
        calls.fleets += 1;
        return { fleets: { samsara: [] }, errors: [] };
      },
      resolveLocationForUnit() {
        return position ? { location: { ...position, lastUpdated: position.at } } : { location: null };
      },
    },
    orders: {
      async getActiveOrders() { calls.orders += 1; return { orders, error: null }; },
    },
    loads: {
      extractLoadFromOrder(o) { return o; },
    },
    notify: async () => ({ delivered: true }),
  };
  return { deps, calls };
}

const ORDER = {
  orderId: 'ORD-1', loadIdentifier: 'L1', unitNumber: '310', status: 'dispatched',
  pickupLat: SHIPPER.lat, pickupLng: SHIPPER.lng,
  deliveryLat: RECEIVER.lat, deliveryLng: RECEIVER.lng,
};

// ── cost ─────────────────────────────────────────────────────────────────────

test('one pass reads each source exactly once, however many loads there are', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ ...ORDER, orderId: `ORD-${i}` }));
  const { deps, calls } = harness({
    orders: many, position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.checked, 40);
  assert.equal(calls.fleets, 1, 'one fleet fetch for forty loads');
  assert.equal(calls.orders, 1);
});

test('an empty board costs nothing and still tidies up', async () => {
  const { deps, calls } = harness({ orders: [] });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.skipped, 'no_active_orders');
  assert.equal(summary.checked, 0);
  assert.equal(calls.pruned, 1, 'a delivered load still ages out on a quiet day');
});

// ── the phase is written down ────────────────────────────────────────────────

test('a truck at the shipper is recorded at pickup, with the arrival witnessed', async () => {
  const { deps, calls } = harness({
    orders: [ORDER], position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  const w = calls.written[0];
  assert.equal(w.phase, 'at_pickup');
  assert.equal(w.atPickup, true);
  assert.equal(w.confidence, 'high');
  assert.equal(w.boardStatus, 'dispatched');
});

test('the driver on a load is the PERSON, so a truck change does not orphan it', async () => {
  const { deps, calls } = harness({
    orders: [ORDER], position: { ...SHIPPER, speedMph: 0, at: at(5) },
    person: { id: 999, personId: 11, unitNumber: '310' },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(calls.written[0].personId, 11,
    'the driver_units row id is the ASSIGNMENT, not the human');
  assert.equal(calls.written[0].groupId, 7);
});

test('a unit on two active groups takes the first, deterministically', async () => {
  const { deps, calls } = harness({
    orders: [ORDER], position: { ...SHIPPER, speedMph: 0, at: at(5) },
    groups: [
      { id: 7, group_name: 'WENZE UNIT # 310 A DRIVER' },
      { id: 99, group_name: 'WENZE UNIT # 310 SOMEONE ELSE' },
    ],
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(calls.written[0].groupId, 7,
    'otherwise a load\'s driver depends on the order a SELECT happened to return');
});

test('a remembered arrival reaches the rules, so a departure can be read', async () => {
  const { deps, calls } = harness({
    orders: [ORDER],
    position: { lat: 40.5, lng: -86.0, speedMph: 62, at: at(5) },
    stored: { phase: 'at_pickup', wasAtPickup: true, wasAtDelivery: false },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(calls.written[0].phase, 'in_transit');
});

// ── an unclear load is a question, never a guess ─────────────────────────────

test('a board running ahead of the truck files a finding NO action can apply', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'in_transit' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.unclear, 1);
  const f = calls.findings[0];
  assert.equal(f.checkKey, 'load.phase_unclear');
  assert.equal(f.tier, 'warning', 'a warning tier has no registered action by construction');
  assert.equal(f.proposedChange, null, 'nothing to apply, so nothing can be applied');
  assert.match(f.title, /disagree/);
});

test('the finding is keyed on the ORDER, so a driver\'s second load is its own question', async () => {
  const { deps, calls } = harness({
    orders: [
      { ...ORDER, orderId: 'ORD-1', status: 'in_transit' },
      { ...ORDER, orderId: 'ORD-2', status: 'in_transit' },
    ],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.deepEqual(calls.findings.map((f) => f.subjectId), ['ORD-1', 'ORD-2']);
});

test('a confident load files nothing at all', async () => {
  const { deps, calls } = harness({
    orders: [ORDER], position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(calls.findings.length, 0);
  assert.equal(summary.unclear, 0);
});

test('a load that became clear has its old question resolved', async () => {
  const { deps, calls } = harness({
    orders: [ORDER], position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.deepEqual(calls.resolved[0], { keys: ['load.phase_unclear'], keep: [] });
});

// ── nothing here changes a driver's record ───────────────────────────────────

test('the pass writes only to its own table', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'delivered' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  // A load's phase is a derived fact. If this ever needs to change a driver's
  // state it must go through the audited correction registry, like Home Time.
  assert.equal(calls.written.length, 1);
  assert.ok(calls.written[0].phase);
});

// ── it never throws ──────────────────────────────────────────────────────────

test('one unreadable order does not stop the pass', async () => {
  const { deps, calls } = harness({
    orders: [ORDER, { ...ORDER, orderId: 'BAD' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  deps.loads.extractLoadFromOrder = (o) => {
    if (o.orderId === 'BAD') throw new Error('malformed order');
    return o;
  };
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.checked, 1);
  assert.equal(calls.written.length, 1);
});

test('a provider outage is counted, not thrown', async () => {
  const { deps } = harness({ orders: [ORDER] });
  deps.providers.fetchProviderFleets = async () => ({ fleets: {}, errors: [{ provider: 'samsara' }] });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.providerErrors, 1);
  assert.equal(summary.checked, 1, 'the board alone still says something, at low confidence');
});

test('a database that is down returns a summary with the reason', async () => {
  const { deps } = harness({ orders: [ORDER] });
  deps.groups.getDriverGroupsByActiveFilter = async () => { throw new Error('connection refused'); };
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.checked, 1, 'a load with no matched group is still a load');
});
