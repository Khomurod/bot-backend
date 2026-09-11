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
  const calls = { fleets: 0, orders: 0, findings: [], written: [], resolved: [], pruned: 0 , windows: [], notified: []};
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
    notifications: {
      async noticeSentWithin(prefix, hours) { calls.windows.push({ prefix, hours }); return false; },
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
    notify: async (n) => { calls.notified.push(n); return { recorded: true, delivered: true }; },
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

// ── which loads are actually a QUESTION ──────────────────────────────────────

/**
 * Production found this immediately: filing for every load that was not high
 * confidence produced 191 findings out of 235 loads, burying the fifteen that
 * needed somebody.
 *
 * The cause is in this module's own design. `heading_to_pickup` is ALWAYS
 * medium confidence — deliberately, because it is an inference from a truck
 * moving the right way, never an observation — so every load in that phase
 * filed a permanent "not enough evidence", for the whole trip. That is not a
 * question anybody can answer. It is what the phase means.
 */
test('a load merely heading to pickup is NOT a question — that phase is medium by design', async () => {
  // Truck well clear of the shipper and moving toward it: the ordinary case.
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'dispatched' }],
    position: { lat: 42.30, lng: -88.20, speedMph: 58, at: at(3) },
    stored: {
      orderId: 'ORD-1', phase: 'heading_to_pickup', phaseSince: at(90),
      wasAtPickup: false, wasAtDelivery: false,
    },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.unclear, 1, 'still counted as not-confident');
  assert.equal(summary.asked, 0, 'but nobody is asked about it');
  assert.deepEqual(calls.findings, []);
});

test('a disagreement is ALWAYS a question, however fresh', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'in_transit' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
    stored: { orderId: 'ORD-1', phase: 'at_pickup', phaseSince: at(2), wasAtPickup: true },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.asked, 1);
  assert.match(calls.findings[0].title, /disagree/);
});

test('a load unreadable for HALF A DAY becomes a question', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'dispatched' }],
    // No position at all: nothing can be read about it.
    position: null,
    stored: { orderId: 'ORD-1', phase: 'assigned', phaseSince: at(60 * 20), wasAtPickup: false },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.asked, 1, 'twenty hours in one unreadable phase is worth a look');
  assert.match(calls.findings[0].title, /not enough evidence/);
});

test('the same load twenty minutes in is not a question — that is a Tuesday', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'dispatched' }],
    position: null,
    stored: { orderId: 'ORD-1', phase: 'assigned', phaseSince: at(20), wasAtPickup: false },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.asked, 0);
  assert.deepEqual(calls.findings, []);
});

test('a load in one phase for forty hours with no position IS a question', async () => {
  // Worth being explicit about, because the remembered phase WINS on stale GPS
  // — that is this module's premise — so the phase has not "moved on" here. It
  // has genuinely sat in transit for forty hours with nothing reporting.
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'dispatched' }],
    position: null,
    stored: { orderId: 'ORD-1', phase: 'in_transit', phaseSince: at(60 * 40), wasAtPickup: true },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.asked, 1);
  assert.match(calls.findings[0].title, /no fresh position/);
});

test('a phase that JUST moved is never stuck, however old the previous one was', async () => {
  // Stored `assigned` since two days ago; the truck is now well on its way, so
  // the phase moves to heading_to_pickup on this pass. It cannot have been
  // stuck in a phase it has only just entered, and heading_to_pickup is
  // medium-confidence by design rather than by doubt.
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'dispatched' }],
    position: { lat: 42.30, lng: -88.20, speedMph: 58, at: at(3) },
    stored: { orderId: 'ORD-1', phase: 'assigned', phaseSince: at(60 * 48), wasAtPickup: false },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(summary.asked, 0, 'the old age belongs to the phase it left');
  assert.deepEqual(calls.findings, []);
});

test('a load that stops being a question has its finding resolved', async () => {
  // The keep-list is what does it, and it must not accidentally keep a finding
  // for a load that no longer qualifies.
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'dispatched' }],
    position: { lat: 42.30, lng: -88.20, speedMph: 58, at: at(3) },
    stored: {
      orderId: 'ORD-1', phase: 'heading_to_pickup', phaseSince: at(90), wasAtPickup: false,
    },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.deepEqual(calls.resolved[0], { keys: ['load.phase_unclear'], keep: [] });
});

// ── the category that had no sender ─────────────────────────────────────────
//
// `load_lifecycle` was configurable in the admin from the day it was written
// and NOTHING SENT IT: this module required `notify` in its dependencies and
// never called it. An administrator could point "Load status" at a Telegram
// group that would never receive anything.

test('a load whose sources CONTRADICT each other is announced', async () => {
  const { deps, calls } = harness({
    // At the shipper, with the board claiming a completed delivery.
    orders: [{ ...ORDER, status: 'delivered' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });

  assert.equal(calls.notified.length, 1);
  assert.equal(calls.notified[0].category, 'load_lifecycle');
  assert.match(calls.notified[0].title, /the load board and the truck disagree/);
  assert.match(calls.notified[0].action, /will not pick a side/);
  assert.equal(calls.notified[0].subjectType, 'load');
});

test('a load that is merely UNREADABLE is filed and not announced', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'assigned' }],
    position: { lat: 38, lng: -88.5, speedMph: 55, at: at(5) },
    stored: { phase: 'heading_to_pickup', phaseSince: at(60 * 30) },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });

  assert.equal(calls.notified.length, 0,
    'a stuck load is a finding to look at when convenient; a contradiction is '
    + 'somebody’s afternoon');
});

test('the same contradiction is not announced every ten minutes', async () => {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'delivered' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  deps.notifications.noticeSentWithin = async () => true;
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 0);
});

test('a missing notification dependency costs the notice, never the pass', async () => {
  const { deps, calls } = harness({
    orders: [
      { ...ORDER, orderId: 'ORD-1', status: 'delivered' },
      { ...ORDER, orderId: 'ORD-2', status: 'delivered' },
    ],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  delete deps.notifications;
  delete deps.notify;
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });

  assert.equal(summary.checked, 2, 'both orders were still examined');
  assert.equal(calls.findings.length, 2, 'and both findings were still filed');
});
