'use strict';

/**
 * The load-lifecycle pass's dependencies, with the load board and the fleet
 * replaced. Shared by the watch's own tests and the retirement tests, so a
 * dependency the pass gains is added in one place.
 */
const NOW = Date.parse('2026-09-20T18:00:00Z');
const at = (mins) => new Date(NOW - mins * 60000).toISOString();
const SHIPPER = { lat: 41.88, lng: -87.63 };
const RECEIVER = { lat: 39.10, lng: -84.50 };

function harness({
  orders = [], position = null, stored = null, groups = [{ id: 7, group_name: 'WENZE UNIT # 310 A DRIVER' }],
  holders = [{ personId: 11, unitNumber: '310' }], orderError = null,
} = {}) {
  const calls = {
    fleets: 0, orders: 0, findings: [], written: [], resolved: [], pruned: 0, windows: [], notified: [],
    retireCalls: [],
  };
  const deps = {
    store: {
      async getLoadState() { return stored; },
      async retireMissingLoads(seen) { calls.retireCalls.push(seen); return { retired: 0, delivered: 0 }; },
      async recordLoadObservation(orderId, patch) {
        calls.written.push({ orderId, ...patch });
        return { orderId, ...patch };
      },
      async pruneFinishedLoads() { calls.pruned += 1; return 0; },
    },
    groups: { async getDriverGroupsByActiveFilter() { return groups; } },
    people: {
      async getOpenHoldersForUnit() {
        if (holders instanceof Error) throw holders;
        return holders;
      },
    },
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
      async getActiveOrders() { calls.orders += 1; return { orders, error: orderError }; },
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

module.exports = {
  NOW, at, SHIPPER, RECEIVER, ORDER, harness,
};
