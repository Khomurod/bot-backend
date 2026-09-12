/**
 * The shared fixture for the return-to-road watcher's tests.
 *
 * Split out when `homeTimeReturnWatch.test.js` reached the 500-line cap: the
 * provider-degradation cases became a file of their own and both need this.
 * Composition only — no assertions live here.
 */
const watcher = require('../../services/homeTime/returnToRoadWatch');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const at = (mins) => new Date(NOW - mins * 60000).toISOString();
const HOME = { lat: 41.88, lng: -87.63 };
const FAR = { lat: 42.5, lng: -88.6 };

function harness({
  drivers = [], location = null, order = null, watchRow = null, reviewer = null,
  providerErrors = [], failObservationFor = null,
} = {}) {
  const calls = {
    fleets: 0, orders: 0, findings: [], observations: [], resolved: [], ensured: [],
    resolvedWith: [],
  };
  let stored = watchRow;
  const deps = {
    watch: {
      async listDriversAtHome() { return drivers; },
      async clearStaleWatches() { return []; },
      async ensureWatch(args) { calls.ensured.push(args); stored = stored || { groupId: args.groupId }; return stored; },
      async getWatch() { return stored; },
      async recordObservation(groupId, patch) {
        // One driver's write refused by the database: the case that used to
        // abandon every driver after it in the loop.
        if (failObservationFor != null && groupId === failObservationFor) {
          throw new Error('invalid input syntax for type integer: "NaN"');
        }
        calls.observations.push({ groupId, ...patch });
        // MIRRORS THE REAL STATEMENT, including its guards. A stub that counts
        // a sighting the database would refuse to count proves nothing about
        // production — and this one did: it hid the fix for an untimed reading
        // being scored as movement, because the stub incremented anyway.
        const isNewSighting = Boolean(
          patch.moving && patch.seenAt && patch.seenAt !== stored?.last?.at
        );
        stored = {
          ...(stored || { groupId }),
          anchor: stored?.anchor || (patch.anchorEligible && patch.lat != null
            ? { lat: patch.lat, lng: patch.lng, at: patch.seenAt } : null),
          last: patch.lat != null ? { lat: patch.lat, lng: patch.lng, speedMph: patch.speedMph, at: patch.seenAt } : stored?.last,
          maxMilesFromAnchor: Math.max(stored?.maxMilesFromAnchor || 0, patch.milesFromAnchor || 0),
          movingSightings: (stored?.movingSightings || 0) + (isNewSighting ? 1 : 0),
        };
        return stored;
      },
    },
    findings: {
      async upsertFinding(f) { calls.findings.push(f); return { id: calls.findings.length, ...f }; },
      async resolveClearedFindings(keys, keep) { calls.resolved.push({ keys, keep }); return 0; },
    },
    eldSettings: { async getEldConfig() { return { samsaraEnabled: true, samsaraApiKeys: ['k'] }; } },
    providers: {
      // The REAL envelopes: fetchProviderFleets returns { fleets, errors } and
      // getActiveOrders returns { orders, error }. Handing the envelope on as if
      // it were the payload made the whole pass throw on the first index.
      async fetchProviderFleets() {
        calls.fleets += 1;
        return { fleets: { samsara: [], factor: null, leader: null }, errors: providerErrors };
      },
      resolveLocationForUnit(fleets) {
        calls.resolvedWith.push(fleets);
        return { location };
      },
    },
    orders: {
      async getActiveOrders() { calls.orders += 1; return { orders: order ? [order] : [], error: null }; },
      indexOrdersByUnit(list) {
        if (!Array.isArray(list)) throw new TypeError('indexOrdersByUnit needs the orders array');
        return new Map(list.map((o) => ['7', o]));
      },
      indexOrdersByDriver(list) {
        if (!Array.isArray(list)) throw new TypeError('indexOrdersByDriver needs the orders array');
        return new Map(list.map((o) => ['a driver', o]));
      },
    },
    loadService: { extractLoadFromOrder: (o) => o.load },
    datatruck: { normalizeUnitForMatch: (u) => String(u), normalizeNameForMatch: (n) => String(n || '').toLowerCase() },
    reasoner: reviewer ? { reviewReturnEvidence: reviewer } : null,
  };
  return { deps, calls };
}

const DRIVER = {
  groupId: 3, groupName: 'WENZE UNIT # 7 A DRIVER', unitNumber: '7',
  driverName: 'A Driver', personId: 11, roadHistoryId: 412, homeSince: at(60 * 72),
};

module.exports = { harness, NOW, at, HOME, FAR, DRIVER, watcher };
