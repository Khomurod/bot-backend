/**
 * FleetView REAL-mode tests.
 *
 * Runs the fleet router with FLEETVIEW_DATA_MODE=real and mocked existing
 * services (liveLocationsService + database/db) injected into the require cache
 * BEFORE the router is loaded. Verifies: federated auth, read-only guard,
 * real-data mapping (from liveLocationsService.getSnapshot), honest-empty for
 * unwired sources, and NO synthetic-data leakage.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const bcrypt = require('bcryptjs');

// 1) Configure real mode + a federation secret BEFORE requiring fleet modules.
process.env.FLEETVIEW_DATA_MODE = 'real';
process.env.JWT_SECRET = 'test-real-secret';

// 2) Inject stubs for the existing services the real provider reuses.
const ROOT = path.resolve(__dirname, '..');
const SAMPLE_UNIT = {
  unit: '305', driverName: 'John Smith', groupName: 'UNIT 305 John', provider: 'Samsara',
  location: { lat: 41.8, lng: -87.63, heading: 90, speedMph: 60, lastUpdated: '2026-07-03T17:55:00Z', isStale: false },
  load: {
    orderId: 'DT-1', loadIdentifier: 'DT-010357', status: 'in_transit', miles: 500,
    pickupSummary: 'Chicago, IL', deliverySummary: 'Dallas, TX', deliveryWindowEnd: '2026-07-03T20:00:00Z',
  },
  eta: { status: 'ok', distanceMiles: 120, durationMinutes: 130, arrivalTime: '2026-07-03T22:10:00Z', source: 'osrm' },
  warnings: [],
};
const UNIT_NO_LOC = { unit: '999', driverName: 'Jane Doe', provider: null, location: null, load: null, eta: null, warnings: ['no_gps'] };

function inject(relPath, exportsObj) {
  const abs = require.resolve(path.join(ROOT, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}

const passwordHash = bcrypt.hashSync('s3cret', 4);
inject('database/db.js', {
  pool: { query: async () => ({ rows: [] }) },
  getAdminByUsername: async (u) => (u === 'realadmin' ? { id: 7, username: 'realadmin', password_hash: passwordHash } : null),
  query: async (sql) => {
    if (/dispatch_team_drivers/.test(sql)) return { rows: [{ team: 'Team Alpha', nname: 'johnsmith' }] };
    if (/driver_profiles/.test(sql)) return { rows: [{ first_name: 'John', last_name: 'Smith', driver_type: 'company_driver', status: 'active', unit_number: '305', group_name: 'UNIT 305 John' }] };
    return { rows: [] };
  },
});
inject('services/liveLocationsService.js', {
  getSnapshot: async () => ({
    units: [SAMPLE_UNIT, UNIT_NO_LOC], isStale: false, lastSuccessfulRefreshAt: '2026-07-03T17:59:00Z',
    summary: { totalUnits: 2 }, errors: [],
  }),
});

// 3) Now load the router (picks up real mode + stubs).
const fleetRouter = require('../server/fleet/router');
const express = require('express');
const app = express();
app.use('/api/v1', fleetRouter);
let server; let base;

test.before(async () => {
  await new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/v1`; r(); }); });
});
test.after(() => server && server.close());

async function req(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null; const t = await res.text(); if (t) { try { json = JSON.parse(t); } catch { /* */ } }
  return { status: res.status, json };
}
async function adminToken() {
  const r = await req('/login', { method: 'POST', body: { email: 'realadmin', password: 's3cret' } });
  assert.strictEqual(r.status, 200);
  return r.json.token;
}

test('real: /mode reports real', async () => {
  const r = await req('/mode');
  assert.deepStrictEqual(r.json, { mode: 'real' });
});

test('real: federated login succeeds for a valid admin, fails for bad password', async () => {
  const ok = await req('/login', { method: 'POST', body: { email: 'realadmin', password: 's3cret' } });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.json.token);
  const bad = await req('/login', { method: 'POST', body: { email: 'realadmin', password: 'wrong' } });
  assert.strictEqual(bad.status, 401);
  const unknown = await req('/login', { method: 'POST', body: { email: 'nobody', password: 's3cret' } });
  assert.strictEqual(unknown.status, 401);
});

test('real: demo credentials do NOT work (demo1234 disabled)', async () => {
  const r = await req('/login', { method: 'POST', body: { email: 'admin@wenzel.example.com', password: 'demo1234' } });
  assert.strictEqual(r.status, 401);
});

test('real: /me is single Wenze tenant + Administrator, dataMode real', async () => {
  const token = await adminToken();
  const me = await req('/me', { token });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.dataMode, 'real');
  assert.strictEqual(me.json.tenant.name, 'Wenze Investments');
  assert.strictEqual(me.json.companies.length, 1);
  assert.deepStrictEqual(me.json.roles, ['Administrator']);
  assert.ok(me.json.permissions.includes('loads.read'));
});

test('real: read-only guard blocks writes with 501', async () => {
  const token = await adminToken();
  for (const [p, body] of [['/tasks', { title: 'x', department: 'Fleet', priority: 'low' }], ['/loads', { load_number: 'X' }]]) {
    const r = await req(p, { method: 'POST', token, body });
    assert.strictEqual(r.status, 501, `${p} should be 501`);
    assert.strictEqual(r.json.error.code, 'READ_ONLY_MODE');
  }
});

test('real: update-board maps snapshot → real rows with computed Late timing', async () => {
  const token = await adminToken();
  const r = await req('/update-board', { token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.meta.source, 'datatruck+eld');
  const row = r.json.data.find((x) => x.truck_unit === '305');
  assert.ok(row, 'expected the mapped unit');
  assert.strictEqual(row.driver_name, 'John Smith');
  assert.strictEqual(row.load_number, 'DT-010357');
  assert.strictEqual(row.dispatcher_name, 'Team Alpha'); // from dispatch_teams mapping
  assert.strictEqual(row.status, 'in_transit');
  // arrival 22:10 vs delivery window end 20:00 → Late by 2h 10m
  assert.strictEqual(row.eta.timing_state, 'late');
  assert.match(row.eta.timing_label, /Late by 2h/);
  // rates are not available from DataTruck → honest null (not fabricated)
  assert.strictEqual(row.hauling_rate, null);
});

test('real: dispatch-map returns real markers + no-location list', async () => {
  const token = await adminToken();
  const r = await req('/dispatch-map', { token });
  assert.strictEqual(r.json.data.markers.length, 1);
  assert.strictEqual(r.json.data.markers[0].unit, '305');
  assert.strictEqual(r.json.data.noLocation.length, 1);
  assert.strictEqual(r.json.data.noLocation[0].unit, '999');
});

test('real: drivers come from driver_profiles', async () => {
  const token = await adminToken();
  const r = await req('/drivers', { token });
  assert.strictEqual(r.json.meta.source, 'driver_profiles');
  assert.strictEqual(r.json.data.length, 1);
  assert.strictEqual(r.json.data[0].display_name, 'John Smith');
  assert.strictEqual(r.json.data[0].truck_unit, '305');
});

test('real: unwired master-data returns honest not-connected, never synthetic', async () => {
  const token = await adminToken();
  const brokers = await req('/brokers', { token });
  assert.strictEqual(brokers.json.data.length, 0);
  assert.strictEqual(brokers.json.meta.connected, false);
  // loads list returns ONLY the one real load, no synthetic Wenzel/Redline rows
  const loads = await req('/loads', { token });
  assert.strictEqual(loads.json.data.length, 1);
  assert.strictEqual(loads.json.data[0].load_number, 'DT-010357');
});

test('real: dashboard load list has no synthetic tenants', async () => {
  const token = await adminToken();
  const r = await req('/dashboard/loads', { token });
  const anyExample = (r.json.data || []).some((l) => JSON.stringify(l).includes('example.com') || /Redline|Wenzel/.test(JSON.stringify(l)));
  assert.strictEqual(anyExample, false);
});
