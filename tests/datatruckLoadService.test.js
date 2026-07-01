const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadService({ configured = true, fetchActiveOrderForDriver } = {}) {
  const servicePath = path.resolve(__dirname, '../services/datatruckLoadService.js');
  const apiPath = path.resolve(__dirname, '../services/datatruckApiService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  delete require.cache[servicePath];
  delete require.cache[apiPath];
  delete require.cache[configPath];

  const realApi = require(apiPath);
  require.cache[apiPath] = {
    exports: {
      ...realApi,
      isConfigured: () => configured,
      fetchActiveOrderForDriver:
        fetchActiveOrderForDriver || (async () => null),
    },
  };
  const svc = require(servicePath);
  svc.clearCache();
  return svc;
}

const SAMPLE_ORDER = {
  id: 4021,
  order_number: 'W-77',
  status: 'in_transit',
  pickup_location: 'Charlotte, NC 28273',
  delivery_location: '5151 E Raines Rd, Memphis, TN 38118',
  pickup_time: '2026-07-01T14:00:00.000Z',
  delivery_time: '2026-07-02T13:00:00.000Z',
  shipper: 'ACME Shipper',
  receiver: 'Memphis DC',
  trip: { driver__full_name: 'John Doe', mile: 620 },
};

test('extractLoadFromOrder maps a Datatruck order to the load-context shape', () => {
  const svc = loadService();
  const load = svc.extractLoadFromOrder(SAMPLE_ORDER);
  assert.equal(load.source, 'datatruck');
  assert.equal(load.orderId, '4021');
  assert.equal(load.loadIdentifier, 'W-77');
  assert.equal(load.status, 'in_transit');
  assert.equal(load.miles, 620);
  assert.equal(load.pickupSummary, 'Charlotte, NC 28273 | 2026-07-01T14:00:00.000Z');
  assert.equal(load.destinationQuery, '5151 E Raines Rd, Memphis, TN 38118');
  assert.equal(load.loadInfoComplete, true);
  assert.ok(load.pickupWindowStart instanceof Date);
  assert.ok(load.deliveryWindowEnd instanceof Date);
});

test('extractLoadFromOrder returns null for a null order', () => {
  const svc = loadService();
  assert.equal(svc.extractLoadFromOrder(null), null);
});

test('resolveActiveLoadForDriver no-ops when Datatruck is not configured', async () => {
  let called = false;
  const svc = loadService({
    configured: false,
    fetchActiveOrderForDriver: async () => {
      called = true;
      return SAMPLE_ORDER;
    },
  });
  assert.equal(await svc.resolveActiveLoadForDriver('John Doe'), null);
  assert.equal(called, false);
});

test('resolveActiveLoadForDriver fetches, maps, and caches per driver', async () => {
  let calls = 0;
  const svc = loadService({
    fetchActiveOrderForDriver: async () => {
      calls += 1;
      return SAMPLE_ORDER;
    },
  });
  const first = await svc.resolveActiveLoadForDriver('John Doe', { nowMs: 1_000 });
  const second = await svc.resolveActiveLoadForDriver('John Doe', { nowMs: 2_000 });
  assert.equal(first.orderId, '4021');
  assert.equal(second.orderId, '4021');
  assert.equal(calls, 1, 'second call within TTL should be served from cache');
});

test('resolveActiveLoadForGroup derives the driver name from the group title', async () => {
  const seen = [];
  const svc = loadService({
    fetchActiveOrderForDriver: async (name) => {
      seen.push(name);
      return SAMPLE_ORDER;
    },
  });
  const load = await svc.resolveActiveLoadForGroup({
    group_name: 'WENZE UNIT # 2908 JOHN DOE (COMPANY DRIVER)',
  });
  assert.equal(load.orderId, '4021');
  assert.equal(seen[0], 'JOHN DOE');
});

test('resolveActiveLoadForDriver returns null (not throw) when the API errors', async () => {
  const svc = loadService({
    fetchActiveOrderForDriver: async () => {
      throw new Error('Datatruck API 500');
    },
  });
  assert.equal(await svc.resolveActiveLoadForDriver('John Doe'), null);
});

test('getAdminRecentLoadsForGroup returns the admin recentLoads row shape', async () => {
  const svc = loadService({ fetchActiveOrderForDriver: async () => SAMPLE_ORDER });
  const rows = await svc.getAdminRecentLoadsForGroup({
    group_name: 'WENZE UNIT # 2908 JOHN DOE (COMPANY DRIVER)',
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, '4021');
  assert.equal(row.telegramMessageId, null);
  assert.equal(row.loadIdentifier, 'W-77');
  assert.equal(row.pickupSummary, 'Charlotte, NC 28273 | 2026-07-01T14:00:00.000Z');
  assert.equal(row.destinationQuery, '5151 E Raines Rd, Memphis, TN 38118');
  assert.equal(typeof row.deliveryWindowEnd, 'string');
  assert.equal(row.aiModel, '');
});

test('getAdminRecentLoadsForGroup returns [] when no active order matches', async () => {
  const svc = loadService({ fetchActiveOrderForDriver: async () => null });
  const rows = await svc.getAdminRecentLoadsForGroup({ group_name: 'WENZE UNIT # 1 JANE ROE' });
  assert.deepEqual(rows, []);
});
