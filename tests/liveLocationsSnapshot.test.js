/**
 * The dispatch-map snapshot cache: does it actually cache?
 *
 * This is both a correctness test and a BANDWIDTH test. The Live Locations page
 * polls while it is open, several admins may have it open at once, and each
 * uncached build reads the canonical driver groups from the database and fans
 * out to every location provider. The TTL cache and the single-flight slot are
 * what keep that at one read per window instead of one per poll per tab.
 *
 * WHY IT EXISTS. services/liveLocations/caches.js used to export its four cache
 * slots as `let` bindings. `module.exports = { snapshotCache, … }` copies their
 * values (both `null`), and snapshot.js destructured them — binding consts —
 * then assigned to them. Every uncached request threw "TypeError: Assignment to
 * constant variable", so the live map answered 500 and the cache never held a
 * thing. Nothing covered getSnapshot, so the whole feature was dark. The slots
 * are objects now, and these tests pin the behaviour that was missing.
 *
 * Collaborators are stubbed through require.cache, so this runs with no
 * database, no secrets and no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SERVICES = path.resolve(__dirname, '..', 'services');
const LIVE = path.join(SERVICES, 'liveLocations');

const MODULE_PATHS = {
  snapshot: path.join(LIVE, 'snapshot.js'),
  caches: path.join(LIVE, 'caches.js'),
  orders: path.join(LIVE, 'orders.js'),
  providers: path.join(LIVE, 'providers.js'),
  eta: path.join(LIVE, 'eta.js'),
  eldSettings: path.resolve(__dirname, '..', 'database', 'eldSettings.js'),
  directory: path.join(SERVICES, 'driverGroupDirectoryService.js'),
  datatruckApi: path.join(SERVICES, 'datatruckApiService.js'),
  datatruckLoads: path.join(SERVICES, 'datatruckLoadService.js'),
};

/** Install a fake module so the next require of that path returns it. */
function stub(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

/**
 * Fresh snapshot module with counting stubs. `calls` records how many times the
 * expensive collaborators were reached — the whole point of the cache.
 */
function loadSnapshotModule({ failBuild = false } = {}) {
  for (const p of Object.values(MODULE_PATHS)) delete require.cache[p];

  const calls = { fleets: 0, groups: 0, orders: 0 };

  stub(MODULE_PATHS.eldSettings, { getEldConfig: async () => ({}) });
  stub(MODULE_PATHS.directory, {
    listCanonicalDriverGroups: async () => {
      calls.groups += 1;
      if (failBuild) throw new Error('database is not available');
      return [{
        group_id: 1, group_name: 'Unit 101 John Doe', raw_group_title: 'Unit 101 John Doe',
        group_type: 'driver', unit_number: '101', inactive: false, operational_visible: true,
      }];
    },
  });
  stub(MODULE_PATHS.providers, {
    fetchProviderFleets: async () => {
      calls.fleets += 1;
      return { fleets: {}, errors: [] };
    },
    resolveLocationForUnit: () => ({
      provider: 'samsara',
      location: { lat: 41.8, lng: -87.6, at: new Date().toISOString(), stale: false },
      ambiguous: false,
      matchWarning: null,
    }),
  });
  stub(MODULE_PATHS.orders, {
    getActiveOrders: async () => {
      calls.orders += 1;
      return { orders: [], error: null };
    },
    indexOrdersByDriver: () => new Map(),
    indexOrdersByUnit: () => new Map(),
    computeNextStop: () => null,
  });
  stub(MODULE_PATHS.eta, { computeStraightLineEta: async () => ({ status: 'unavailable' }) });
  stub(MODULE_PATHS.datatruckApi, {
    isConfigured: () => false,
    normalizeNameForMatch: (s) => String(s || '').toLowerCase(),
    normalizeUnitForMatch: (s) => String(s || '').toLowerCase(),
  });
  stub(MODULE_PATHS.datatruckLoads, { extractLoadFromOrder: () => null });

  const snapshot = require(MODULE_PATHS.snapshot);
  const caches = require(MODULE_PATHS.caches);
  caches.clearCaches();
  return { snapshot, caches, calls };
}

test.afterEach(() => {
  for (const p of Object.values(MODULE_PATHS)) delete require.cache[p];
});

test('a first request builds the snapshot, and does not throw', async () => {
  // The regression: this threw "Assignment to constant variable" — a 500 from
  // the live map on every request, because the cache could never be written.
  const { snapshot, calls } = loadSnapshotModule();
  const data = await snapshot.getSnapshot();
  assert.equal(calls.fleets, 1);
  assert.equal(data.servedFromCache, false);
  assert.equal(data.units.length, 1);
  assert.equal(data.units[0].unit, '101');
});

test('a second request inside the TTL is served from memory, not rebuilt', async () => {
  const { snapshot, calls } = loadSnapshotModule();
  await snapshot.getSnapshot();
  const second = await snapshot.getSnapshot();
  assert.equal(calls.fleets, 1, 'the provider fan-out must happen once per TTL window');
  assert.equal(calls.groups, 1, 'the database read must happen once per TTL window');
  assert.equal(second.servedFromCache, true);
  assert.equal(second.isStale, false);
  assert.equal(typeof second.cacheAgeSeconds, 'number');
});

test('concurrent requests share one build, so tabs polling together cost one', async () => {
  const { snapshot, calls } = loadSnapshotModule();
  const [a, b, c] = await Promise.all([
    snapshot.getSnapshot(), snapshot.getSnapshot(), snapshot.getSnapshot(),
  ]);
  assert.equal(calls.fleets, 1, 'single-flight must collapse concurrent callers');
  assert.equal(calls.groups, 1);
  assert.deepEqual(a.units, b.units);
  assert.deepEqual(b.units, c.units);
});

test('force: true rebuilds, for the explicit Refresh button', async () => {
  const { snapshot, calls } = loadSnapshotModule();
  await snapshot.getSnapshot();
  const forced = await snapshot.getSnapshot({ force: true });
  assert.equal(calls.fleets, 2);
  assert.equal(forced.servedFromCache, false);
});

test('clearCaches drops the cached snapshot', async () => {
  const { snapshot, caches, calls } = loadSnapshotModule();
  await snapshot.getSnapshot();
  caches.clearCaches();
  await snapshot.getSnapshot();
  assert.equal(calls.fleets, 2);
});

test('a failed rebuild keeps serving the last good snapshot, flagged stale', async () => {
  const { snapshot } = loadSnapshotModule();
  const good = await snapshot.getSnapshot();
  assert.equal(good.units.length, 1);

  // Break the database read the way a Supabase outage would.
  stub(MODULE_PATHS.directory, {
    listCanonicalDriverGroups: async () => { throw new Error('database is not available'); },
  });
  delete require.cache[MODULE_PATHS.snapshot];
  const brokenSnapshot = require(MODULE_PATHS.snapshot);

  const stale = await brokenSnapshot.getSnapshot({ force: true });
  assert.equal(stale.isStale, true, 'the page must be told the data is old');
  assert.equal(stale.units.length, 1, 'the last good snapshot is NOT wiped');
  assert.match(stale.warning || '', /last successful snapshot/i);
  assert.ok(
    (stale.errors || []).some((e) => e.code === 'BUILD_FAILED'),
    'the real failure is reported, not hidden',
  );
});

test('the first-ever request cannot hide a failure behind an empty snapshot', async () => {
  // With no cached data there is nothing honest to show, so the error must
  // propagate and the page must say so — never an empty map that looks normal.
  const { snapshot } = loadSnapshotModule({ failBuild: true });
  await assert.rejects(() => snapshot.getSnapshot(), /database is not available/);
});

test('the cache slots are shared state with one owner', () => {
  // The mechanism itself: a slot written through one reference is visible
  // through the exported one. This is what `let` exports could not do.
  const { caches } = loadSnapshotModule();
  const slot = caches.snapshotSlot;
  slot.set({ at: 123, data: { units: [] } });
  assert.equal(caches.snapshotSlot.get().at, 123);
  caches.clearCaches();
  assert.equal(caches.snapshotSlot.get(), null);
});

// ─── the order window, same slot mechanism ───────────────────────────────────

/** Fresh orders module with a counting Datatruck stub. */
function loadOrdersModule() {
  for (const p of [MODULE_PATHS.orders, MODULE_PATHS.caches, MODULE_PATHS.datatruckApi]) {
    delete require.cache[p];
  }
  const calls = { fetch: 0 };
  stub(MODULE_PATHS.datatruckApi, {
    isConfigured: () => true,
    fetchOrdersByDocumentWindow: async () => {
      calls.fetch += 1;
      return [{ id: 1 }];
    },
    orderDriverCandidates: () => [],
    normalizeNameForMatch: (s) => String(s || '').toLowerCase(),
    normalizeUnitForMatch: (s) => String(s || '').toLowerCase(),
  });
  const orders = require(MODULE_PATHS.orders);
  const caches = require(MODULE_PATHS.caches);
  caches.clearCaches();
  return { orders, caches, calls };
}

test('the order window is fetched once per TTL, and concurrent calls share it', async () => {
  const { orders, calls } = loadOrdersModule();
  const now = Date.now();
  const [a, b] = await Promise.all([orders.getActiveOrders(now), orders.getActiveOrders(now)]);
  assert.equal(calls.fetch, 1, 'single-flight must collapse concurrent callers');
  assert.deepEqual(a.orders, b.orders);

  const cached = await orders.getActiveOrders(now + 1000);
  assert.equal(calls.fetch, 1, 'a call inside the TTL must not refetch');
  assert.equal(cached.error, null);
});

test('a failed order fetch reuses the last good window and reports the error', async () => {
  const { orders, calls } = loadOrdersModule();
  const now = Date.now();
  await orders.getActiveOrders(now);
  assert.equal(calls.fetch, 1);

  stub(MODULE_PATHS.datatruckApi, {
    isConfigured: () => true,
    fetchOrdersByDocumentWindow: async () => { throw new Error('upstream down'); },
  });
  delete require.cache[MODULE_PATHS.orders];
  const brokenOrders = require(MODULE_PATHS.orders);

  const result = await brokenOrders.getActiveOrders(now + 10 * 60_000);
  assert.deepEqual(result.orders, [{ id: 1 }], 'the last good window is kept');
  assert.equal(result.error.provider, 'datatruck');
  assert.match(result.error.message, /upstream down/);
});
