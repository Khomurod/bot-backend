/**
 * FleetView REAL-mode tests.
 *
 * Runs the fleet router with FLEETVIEW_DATA_MODE=real and mocked existing
 * services (liveLocationsService + database/db) injected into the require cache
 * BEFORE the router is loaded. The db stub emulates the fleet_* tables so task
 * persistence / settings / sync / audit can be exercised end-to-end.
 *
 * Verifies: federated auth, external read-only guard, real-data mapping,
 * fleet-owned persistence, honest-empty for unwired sources, and NO synthetic
 * data leakage.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const bcrypt = require('bcryptjs');

// 1) Configure real mode + the federation secret BEFORE requiring fleet modules.
process.env.FLEETVIEW_DATA_MODE = 'real';
process.env.JWT_SECRET = 'test-real-secret';

// 2) In-memory emulation of the fleet_* tables (what Postgres would hold).
const mem = {
  fleet_tasks: [], fleet_task_comments: [], fleet_task_activity: [],
  fleet_audit_log: [], fleet_settings: {}, fleet_sync_runs: [],
};
function fleetQuery(text, params = []) {
  const t = String(text).trim();
  if (/^CREATE /i.test(t)) return { rows: [] };
  if (/INSERT INTO fleet_tasks/i.test(t)) {
    mem.fleet_tasks.push({
      id: params[0], tenant_id: params[1], company_id: params[2], title: params[3],
      description: params[4], status: 'todo', priority: params[5], department_id: params[6],
      creator_id: params[7], assignee_id: params[8], related_load_id: params[9],
      related_driver_id: params[10], label_ids: JSON.parse(params[11] || '[]'), due_at: params[12],
      source: params[13], version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    return { rows: [] };
  }
  if (/FROM fleet_tasks WHERE tenant_id = \$1/i.test(t)) return { rows: mem.fleet_tasks.filter((r) => r.tenant_id === params[0]) };
  if (/FROM fleet_tasks WHERE id = \$1 AND tenant_id = \$2/i.test(t)) return { rows: mem.fleet_tasks.filter((r) => r.id === params[0] && r.tenant_id === params[1]) };
  if (/UPDATE fleet_tasks SET/i.test(t)) {
    const r = mem.fleet_tasks.find((x) => x.id === params[0] && x.tenant_id === params[1]);
    if (r) {
      if (params[2] != null) r.status = params[2];
      if (params[3] != null) r.priority = params[3];
      if (params[4] != null) r.assignee_id = params[4];
      r.version += 1; r.updated_at = new Date().toISOString();
    }
    return { rows: [] };
  }
  if (/INSERT INTO fleet_task_comments/i.test(t)) { mem.fleet_task_comments.push({ id: params[0], tenant_id: params[1], task_id: params[2], body: params[3], author_id: params[4], created_at: new Date().toISOString() }); return { rows: [] }; }
  if (/FROM fleet_task_comments/i.test(t)) return { rows: mem.fleet_task_comments.filter((c) => c.tenant_id === params[0] && c.task_id === params[1]) };
  if (/INSERT INTO fleet_task_activity/i.test(t)) { mem.fleet_task_activity.push({ id: params[0], tenant_id: params[1], task_id: params[2], type: params[3], actor: params[4], detail: params[5], timestamp: new Date().toISOString() }); return { rows: [] }; }
  if (/FROM fleet_task_activity/i.test(t)) return { rows: mem.fleet_task_activity.filter((a) => a.tenant_id === params[0] && a.task_id === params[1]) };
  if (/INSERT INTO fleet_audit_log/i.test(t)) { mem.fleet_audit_log.push({ id: params[0], tenant_id: params[1], actor: params[2], action: params[3], timestamp: new Date().toISOString() }); return { rows: [] }; }
  if (/FROM fleet_audit_log/i.test(t)) return { rows: mem.fleet_audit_log.filter((a) => a.tenant_id === params[0]) };
  if (/INSERT INTO fleet_settings/i.test(t)) { mem.fleet_settings[params[0]] = { data: JSON.parse(params[1]), version: params[2], updated_at: new Date().toISOString(), updated_by: params[3] }; return { rows: [] }; }
  if (/FROM fleet_settings/i.test(t)) { const s = mem.fleet_settings[params[0]]; return { rows: s ? [s] : [] }; }
  if (/INSERT INTO fleet_sync_runs/i.test(t)) { mem.fleet_sync_runs.push({ id: params[0], tenant_id: params[1], source: params[2], status: params[3], correlation_id: params[4], triggered_by: params[5], started_at: new Date().toISOString(), records_fetched: 0 }); return { rows: [] }; }
  if (/UPDATE fleet_sync_runs/i.test(t)) { const r = mem.fleet_sync_runs.find((x) => x.id === params[0]); if (r) { r.status = params[1]; r.records_fetched = params[2]; r.error_reason = params[7]; r.finished_at = new Date().toISOString(); } return { rows: [] }; }
  if (/FROM fleet_sync_runs/i.test(t)) return { rows: mem.fleet_sync_runs.filter((r) => r.tenant_id === params[0]) };
  return { rows: [] };
}

// 3) Stubs for the existing main-app modules the real provider reuses.
const ROOT = path.resolve(__dirname, '..');
const SAMPLE_UNIT = {
  unit: '305', driverName: 'John Smith', groupName: 'UNIT 305 John', provider: 'Samsara',
  location: { lat: 41.8, lng: -87.63, heading: 90, speedMph: 60, lastUpdated: '2026-07-03T17:55:00Z', isStale: false },
  load: {
    orderId: 'DT-1', loadIdentifier: 'DT-010357', status: 'in_transit', miles: 500,
    pickupSummary: 'Chicago, IL', deliverySummary: 'Dallas, TX', deliveryWindowEnd: '2026-07-03T20:00:00Z',
    shipperName: 'Acme Distribution', receiverName: 'Global Foods DC',
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
  pool: { query: async (t, p) => fleetQuery(t, p) },
  getAdminByUsername: async (u) => (u === 'realadmin' ? { id: 7, username: 'realadmin', password_hash: passwordHash } : null),
  query: async (sql) => {
    if (/dispatch_team_drivers/.test(sql)) return { rows: [{ team: 'Team Alpha', nname: 'johnsmith' }] };
    if (/driver_profiles/.test(sql)) return { rows: [{ first_name: 'John', last_name: 'Smith', driver_type: 'company_driver', status: 'active', unit_number: '305', group_name: 'UNIT 305 John' }] };
    if (/FROM admins/.test(sql)) return { rows: [{ id: 7, username: 'realadmin', created_at: '2026-01-01T00:00:00Z' }] };
    return { rows: [] };
  },
});
let snapshotForceCount = 0;
inject('services/liveLocationsService.js', {
  getSnapshot: async ({ force } = {}) => {
    if (force) snapshotForceCount += 1;
    return {
      units: [SAMPLE_UNIT, UNIT_NO_LOC], isStale: false, lastSuccessfulRefreshAt: '2026-07-03T17:59:00Z',
      summary: { totalUnits: 2 }, errors: [],
    };
  },
});

// DataTruck adapter stub (shapes mirror the live-verified API mapping output).
const DT_ORDER = {
  id: 'dt_order_1', external_id: '1', load_number: 'DT-010357', trip_number: 'T1',
  status: 'in_transit', raw_status: 'in_transit', driver_name: 'John Smith', team_driver_name: null,
  dispatcher_name: 'Team Alpha', broker_name: 'Acme Logistics', mc_name: null,
  truck_unit: '305', trailer_unit: null, origin_label: 'Chicago, IL', destination_label: 'Dallas, TX',
  shipper_name: null, receiver_name: null, hauling_rate: 250000, total_pay: 255000,
  assigned_rate: null, rate_savings: null, rpm: 2.5, planned_distance_miles: 1000,
  pickup_window_start: '2026-07-03T08:00:00Z', delivery_window_start: '2026-07-05T08:00:00Z',
  paperwork_state: null, pinned: false, eta: null, previous_eta: null, location: null, eld_state: null,
  source: 'datatruck',
};
inject('server/fleet/dataTruckAdapter.js', {
  isConfigured: () => true,
  getRecentOrders: async () => [DT_ORDER],
  getTrucks: async () => [{ id: 'dt_truck_1', external_id: '1', type: 'truck', unit_number: '305', vin: '1XKAD49X1KJ000000', make: 'Kenworth', model: 'T680', year: 2022, license_plate: 'P123', jurisdiction: 'IL', fuel_type: '', registered_weight: null, operated_by: 'John Smith', status: 'available', eld_provider: null, conflict: false, source: 'datatruck' }],
  getTrailers: async () => [{ id: 'dt_trailer_1', external_id: '9', type: 'trailer', unit_number: 'T77', vin: '1UYVS2530XX000000', make: 'Utility', model: '', year: 2021, license_plate: '', jurisdiction: '', fuel_type: '', registered_weight: null, operated_by: null, status: 'available', eld_provider: null, conflict: false, source: 'datatruck' }],
  getDriversFull: async () => [{ id: 'dt_drv_1', external_id: '11', display_name: 'John Smith', position: 'company_driver', truck_unit: '305', trailer_unit: null, phone_e164: '+15550001111', email: null, dispatcher_name: 'Team Alpha', status: 'active', hire_date: null, source: 'datatruck' }],
  refreshAll: async () => ({ trucks: 1, trailers: 1, drivers: 1, orders: 1 }),
  lastSyncAt: () => '2026-07-03T18:00:00Z',
  clearCache: () => {},
});

// 4) Now load the router (picks up real mode + stubs).
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

// ── auth & mode ───────────────────────────────────────────────────────────────
test('real: /mode reports real', async () => {
  const r = await req('/mode');
  assert.deepStrictEqual(r.json, { mode: 'real' });
});

test('real: federated login works; bad/unknown credentials rejected', async () => {
  const ok = await req('/login', { method: 'POST', body: { email: 'realadmin', password: 's3cret' } });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.json.token);
  assert.strictEqual((await req('/login', { method: 'POST', body: { email: 'realadmin', password: 'wrong' } })).status, 401);
  assert.strictEqual((await req('/login', { method: 'POST', body: { email: 'nobody', password: 's3cret' } })).status, 401);
});

test('real: demo credentials do NOT work (demo1234 disabled)', async () => {
  const r = await req('/login', { method: 'POST', body: { email: 'admin@wenzel.example.com', password: 'demo1234' } });
  assert.strictEqual(r.status, 401);
});

test('real: /me is single Wenze tenant + Administrator, dataMode real', async () => {
  const me = await req('/me', { token: await adminToken() });
  assert.strictEqual(me.json.dataMode, 'real');
  assert.strictEqual(me.json.tenant.name, 'Wenze Investments');
  assert.deepStrictEqual(me.json.roles, ['Administrator']);
});

// ── external read-only guard ─────────────────────────────────────────────────
test('real: external-facing writes are blocked with 501; fleet-owned writes allowed', async () => {
  const token = await adminToken();
  for (const [p, body] of [
    ['/loads', { load_number: 'X', broker_id: 'b', hauling_rate: 1 }],
    ['/brokers', { display_name: 'X' }],
    ['/companies', { name: 'X' }],
  ]) {
    const r = await req(p, { method: 'POST', token, body });
    assert.strictEqual(r.status, 501, `${p} should be 501`);
    assert.strictEqual(r.json.error.code, 'READ_ONLY_MODE');
  }
  // fleet-owned: task create is allowed and persists
  const t = await req('/tasks', { method: 'POST', token, body: { title: 'Real persisted task', department: 'Fleet', priority: 'high' } });
  assert.strictEqual(t.status, 201);
  assert.ok(t.json.data.id.startsWith('tsk_'));
});

// ── real data mapping ────────────────────────────────────────────────────────
test('real: update-board maps snapshot → real rows with computed Late timing', async () => {
  const token = await adminToken();
  const r = await req('/update-board', { token });
  assert.strictEqual(r.json.meta.source, 'datatruck+eld');
  const row = r.json.data.find((x) => x.truck_unit === '305');
  assert.ok(row);
  assert.strictEqual(row.driver_name, 'John Smith');
  assert.strictEqual(row.load_number, 'DT-010357');
  assert.strictEqual(row.dispatcher_name, 'Team Alpha');
  assert.strictEqual(row.eta.timing_state, 'late');
  assert.match(row.eta.timing_label, /Late by 2h/);
  assert.strictEqual(row.hauling_rate, null); // never fabricated
});

test('real: dispatch-map returns real markers + no-location list', async () => {
  const r = await req('/dispatch-map', { token: await adminToken() });
  assert.strictEqual(r.json.data.markers.length, 1);
  assert.strictEqual(r.json.data.noLocation[0].unit, '999');
});

test('real: drivers from DataTruck roster (primary source); search over real rows', async () => {
  const token = await adminToken();
  const d = await req('/drivers', { token });
  assert.strictEqual(d.json.meta.source, 'datatruck');
  assert.strictEqual(d.json.data[0].display_name, 'John Smith');
  assert.strictEqual(d.json.data[0].dispatcher_name, 'Team Alpha');
  assert.strictEqual(d.json.data[0].phone_e164, '+15550001111');
  const s = await req('/search?q=305', { token });
  assert.ok(s.json.trucks.some((x) => x.label === 'Unit 305'));
});

test('real: dispatch-board has real hauling/RPM from orders; settlement honestly null', async () => {
  const r = await req('/dispatch-board', { token: await adminToken() });
  const group = r.json.data.find((g) => g.dispatcher === 'Team Alpha');
  assert.ok(group);
  const drv = group.drivers.find((d) => d.name === 'John Smith');
  assert.ok(drv.loads.length === 1 && drv.loads[0].load_number === 'DT-010357');
  assert.strictEqual(drv.stats.hauling, 250000); // real TMS revenue (cents)
  assert.strictEqual(drv.stats.rpm, 2.5);
  assert.strictEqual(drv.stats.assigned, null); // settlement not exposed → honest null
  assert.strictEqual(r.json.summary.total_hauling, 250000);
  assert.strictEqual(r.json.summary.enroute, 1);
});

test('real: equipment lists real trucks AND trailers with VIN/make/year', async () => {
  const token = await adminToken();
  const trucks = await req('/equipments?type=truck', { token });
  const u = trucks.json.data.find((e) => e.unit_number === '305');
  assert.ok(u);
  assert.strictEqual(u.vin, '1XKAD49X1KJ000000');
  assert.strictEqual(u.make, 'Kenworth');
  assert.strictEqual(u.year, 2022);
  assert.strictEqual(u.status, 'in_transit'); // live-layer join upgrades status
  const trailers = await req('/equipments?type=trailer', { token });
  assert.strictEqual(trailers.json.data.length, 1);
  assert.strictEqual(trailers.json.data[0].unit_number, 'T77');
});

test('real: brokers are actual TMS customers, no fabricated contacts', async () => {
  const r = await req('/brokers', { token: await adminToken() });
  assert.strictEqual(r.json.data[0].display_name, 'Acme Logistics');
  assert.strictEqual(r.json.data[0].loads_in_window, 1);
  assert.ok(r.json.data.every((b) => b.email === '' && b.phone_e164 === ''));
});

test('real: loads list carries real TMS rates and RPM', async () => {
  const r = await req('/loads', { token: await adminToken() });
  assert.strictEqual(r.json.meta.source, 'datatruck-orders');
  const l = r.json.data.find((x) => x.load_number === 'DT-010357');
  assert.ok(l);
  assert.strictEqual(l.hauling_rate, 250000);
  assert.strictEqual(l.rpm, 2.5);
  assert.strictEqual(l.broker_name, 'Acme Logistics');
  // live join attached location/ETA from the snapshot (unit 305 matches)
  assert.ok(l.location && l.location.latitude === 41.8);
});

test('real: users list = existing admins; companies = single Wenze', async () => {
  const token = await adminToken();
  const u = await req('/users', { token });
  assert.strictEqual(u.json.data[0].name, 'realadmin');
  const c = await req('/companies', { token });
  assert.strictEqual(c.json.data.length, 1);
  assert.strictEqual(c.json.data[0].name, 'Wenze');
});

// ── honest unavailable states ────────────────────────────────────────────────
test('real: emails / fuel / reports show honest unconnected, never fake', async () => {
  const token = await adminToken();
  const cats = await req('/email/categories', { token });
  assert.strictEqual(cats.json.meta.connected, false);
  const threads = await req('/email/threads', { token });
  assert.strictEqual(threads.json.meta.connected, false);
  assert.strictEqual(threads.json.data.length, 0);
  const fuel = await req('/fuel-prices', { token });
  assert.strictEqual(fuel.json.meta.connected, false);
  // Rate Savings is still honestly unavailable (no settlement-rate source).
  const rate = await req('/reports/rate-savings', { token });
  assert.strictEqual(rate.json.meta.connected, false);
});

// ── statistics now computed from real DataTruck orders ───────────────────────
test('real: gross board is computed per-driver from DataTruck orders over a period', async () => {
  const token = await adminToken();
  // Explicit period covers the stub order's pickup date (clock-independent).
  const gross = await req('/reports/gross-board?from=2026-07-01&to=2026-07-31', { token });
  assert.strictEqual(gross.json.groupBy, 'driver');
  const drv = gross.json.data.find((d) => d.name === 'John Smith');
  assert.ok(drv, 'expected John Smith gross row');
  assert.strictEqual(drv.gross, 250000); // real TMS hauling revenue (cents)
  assert.strictEqual(drv.loads, 1);
  assert.strictEqual(gross.json.summary.total_gross, 250000);
  assert.strictEqual(gross.json.summary.drivers, 1);
});

test('real: cancellations report reads canceled orders in the period (none here)', async () => {
  const token = await adminToken();
  const c = await req('/reports/cancellations?from=2026-07-01&to=2026-07-31', { token });
  assert.ok(Array.isArray(c.json.data));
  assert.strictEqual(c.json.summary.canceled_load_count, 0); // stub order is in_transit
});

// ── fleet-owned persistence ──────────────────────────────────────────────────
test('real: task lifecycle persists (create → transition → comment → archive)', async () => {
  const token = await adminToken();
  const created = await req('/tasks', { method: 'POST', token, body: { title: 'Lifecycle task', department: 'Dispatcher', priority: 'medium' } });
  const id = created.json.data.id;
  const list = await req('/tasks', { token });
  assert.ok(list.json.data.some((t) => t.id === id));
  // illegal transition rejected
  const bad = await req(`/tasks/${id}`, { method: 'PATCH', token, body: { status: 'done', version: 1 } });
  assert.strictEqual(bad.status, 409);
  // legal transition
  const ok = await req(`/tasks/${id}`, { method: 'PATCH', token, body: { status: 'in_progress', version: 1 } });
  assert.strictEqual(ok.json.data.status, 'in_progress');
  assert.strictEqual(ok.json.data.version, 2);
  // stale version conflict
  const conflict = await req(`/tasks/${id}`, { method: 'PATCH', token, body: { status: 'done', version: 1 } });
  assert.strictEqual(conflict.status, 409);
  // comment
  const cmt = await req(`/tasks/${id}/comments`, { method: 'POST', token, body: { body: 'working on it' } });
  assert.strictEqual(cmt.status, 201);
  const comments = await req(`/tasks/${id}/comments`, { token });
  assert.strictEqual(comments.json.data.length, 1);
  // archive + activity trail
  const arch = await req(`/tasks/${id}/archive`, { method: 'POST', token, body: {} });
  assert.strictEqual(arch.json.data.status, 'archived');
  const activity = await req(`/tasks/${id}/activity`, { token });
  assert.ok(activity.json.data.length >= 2);
});

test('real: dashboard task KPIs come from persisted fleet_tasks', async () => {
  const token = await adminToken();
  const s = await req('/dashboard/task-summary', { token });
  assert.ok(s.json.highPriorityTickets >= 1); // from 'Real persisted task'
});

test('real: settings persist with validation', async () => {
  const token = await adminToken();
  const bad = await req('/settings/general', { method: 'PUT', token, body: { check_in_radius_miles: 99 } });
  assert.strictEqual(bad.status, 400);
  const put = await req('/settings/general', { method: 'PUT', token, body: { check_in_radius_miles: 0.7 } });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.json.data.version, 1); // first write
  const put2 = await req('/settings/general', { method: 'PUT', token, body: { detention_threshold_minutes: 90 } });
  assert.strictEqual(put2.json.data.version, 2); // version increments
  const get = await req('/settings/general', { token });
  assert.strictEqual(get.json.data.check_in_radius_miles, 0.7); // earlier field retained
  assert.strictEqual(get.json.data.detention_threshold_minutes, 90);
});

test('real: manual sync records a fleet_sync_runs row and mutates nothing external', async () => {
  const token = await adminToken();
  const before = snapshotForceCount;
  const r = await req('/sync/locations', { method: 'POST', token });
  assert.strictEqual(r.json.data.status, 'success');
  assert.strictEqual(r.json.data.records_fetched, 2);
  assert.strictEqual(snapshotForceCount, before + 1); // read refresh only
  const runs = await req('/sync/runs', { token });
  assert.ok(runs.json.data.some((x) => x.source === 'locations' && x.status === 'success'));
  const dt = await req('/sync/datatruck', { method: 'POST', token });
  assert.strictEqual(dt.json.data.status, 'success');
  assert.strictEqual(dt.json.data.records_fetched, 4); // trucks+trailers+drivers+orders
  const bogus = await req('/sync/nope', { method: 'POST', token });
  assert.strictEqual(bogus.status, 400);
});

test('real: audit log persisted and readable', async () => {
  const token = await adminToken();
  await new Promise((r) => setTimeout(r, 50)); // audit writes are fire-and-forget
  const a = await req('/audit', { token });
  assert.ok(a.json.data.length > 0);
  assert.ok(a.json.data.every((row) => row.tenant_id === 'tnt_wenze'));
});

test('real: support ticket recorded internally, no external delivery', async () => {
  const token = await adminToken();
  const r = await req('/support/tickets', { method: 'POST', token, body: { subject: 'Test', description: 'Hello', category: 'Question' } });
  assert.strictEqual(r.status, 201);
  assert.match(r.json.data.destination, /Recorded internally/);
});

// ── no synthetic leakage ─────────────────────────────────────────────────────
test('real: no synthetic tenants/users/loads anywhere', async () => {
  const token = await adminToken();
  for (const p of ['/loads', '/dashboard/loads', '/drivers', '/users', '/companies']) {
    const r = await req(p, { token });
    const s = JSON.stringify(r.json.data || []);
    assert.ok(!s.includes('example.com'), `${p} leaked demo emails`);
    assert.ok(!/Redline|Wenzel /.test(s), `${p} leaked demo tenant names`);
  }
});
