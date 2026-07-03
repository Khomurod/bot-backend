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

// Mirrors the real Datatruck OpenAPI order shape: stops live in trip.pickup /
// trip.delivery (structured objects with coordinates), the load number is
// `load_id`, and the unit is on `trip.truck__unit_number`.
const LIVE_SHAPE_ORDER = {
  id: 13367,
  load_id: '2257761',
  shipment_id: 'DT-010357',
  status: 'dispatched',
  total_miles: 1190.84,
  pickup_time: '2026-07-04T02:00:00Z',
  delivery_time: '2026-07-04T19:00:00Z',
  trip: {
    status: 'assigned',
    mile: 780.67,
    driver__full_name: 'JAFAR KHALIMOV',
    truck__unit_number: '771 JAFAR',
    pickup: {
      company: 'FEDEX GROUND SVNH',
      address1: '135 COLEMAN BLVD, SAVANNAH, GA 31408',
      city: 'Savannah', state: 'Georgia', zip_code: '31408',
      latitude: 32.1175129, longitude: -81.2244581,
    },
    delivery: {
      company: 'FEDEX GROUND WOOD',
      address1: '6000 RIVERSIDE DRIVE, KEASBEY, NJ 08832',
      city: 'Woodbridge Township', state: 'New Jersey', zip_code: '08832',
      latitude: 40.5068324, longitude: -74.3234346,
    },
  },
};

test('extractLoadFromOrder maps the LIVE Datatruck order shape (trip.pickup/delivery, load_id, unit)', () => {
  const svc = loadService();
  const load = svc.extractLoadFromOrder(LIVE_SHAPE_ORDER);
  assert.equal(load.loadIdentifier, '2257761', 'load_id is preferred over the numeric id');
  assert.equal(load.unitNumber, '771 JAFAR');
  assert.equal(load.status, 'dispatched');
  assert.equal(load.pickupAddress, '135 COLEMAN BLVD, SAVANNAH, GA 31408');
  assert.equal(load.deliveryAddress, '6000 RIVERSIDE DRIVE, KEASBEY, NJ 08832');
  assert.equal(load.shipperName, 'FEDEX GROUND SVNH');
  assert.equal(load.receiverName, 'FEDEX GROUND WOOD');
  assert.equal(load.pickupLat, 32.1175129);
  assert.equal(load.deliveryLng, -74.3234346);
  assert.equal(load.destinationQuery, '6000 RIVERSIDE DRIVE, KEASBEY, NJ 08832');
  assert.equal(load.loadInfoComplete, true, 'a live order must be considered complete so Datatruck stays primary');
});

test('extractLoadFromOrder reads stops[] when trip.pickup/delivery is absent', () => {
  const svc = loadService();
  const load = svc.extractLoadFromOrder({
    id: 5,
    load_id: 'L-5',
    status: 'in_transit',
    pickup_time: '2026-07-04T02:00:00Z',
    delivery_time: '2026-07-05T02:00:00Z',
    stops: [
      { stop_type: 'delivery', ordering: 2, location: { company: 'Dest Co', address1: '2 Dest Ave', latitude: 40, longitude: -75 } },
      { stop_type: 'pickup', ordering: 1, location: { company: 'Origin Co', address1: '1 Origin St', latitude: 41, longitude: -87 } },
    ],
  });
  assert.equal(load.pickupAddress, '1 Origin St');
  assert.equal(load.deliveryAddress, '2 Dest Ave');
  assert.equal(load.pickupLat, 41);
  assert.equal(load.deliveryLat, 40);
});

test('getNextStop returns the delivery (with coords) once the pickup window passed', () => {
  const svc = loadService();
  const now = Date.parse('2026-07-04T20:00:00Z');
  const load = svc.extractLoadFromOrder(LIVE_SHAPE_ORDER);
  const next = svc.getNextStop(load, { nowMs: now });
  assert.equal(next.type, 'delivery');
  assert.equal(next.address, '6000 RIVERSIDE DRIVE, KEASBEY, NJ 08832');
  assert.equal(next.lat, 40.5068324);
  assert.equal(svc.getLoadStatus(load), 'dispatched');
});

test('resolveActiveLoadForUnit matches by unit and caches per unit', async () => {
  let calls = 0;
  const svc = loadService({});
  // Patch the API module the service closed over.
  const apiPath = path.resolve(__dirname, '../services/datatruckApiService.js');
  require.cache[apiPath].exports.fetchActiveOrderForUnit = async () => { calls += 1; return LIVE_SHAPE_ORDER; };
  const first = await svc.resolveActiveLoadForUnit('771', { nowMs: 1000 });
  const second = await svc.resolveActiveLoadForUnit('#771', { nowMs: 2000 });
  assert.equal(first.loadIdentifier, '2257761');
  assert.equal(second.loadIdentifier, '2257761');
  assert.equal(calls, 1, 'normalized unit hits the cache on the second call');
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
