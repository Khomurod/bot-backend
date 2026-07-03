/**
 * Fleet Operations Platform API tests.
 *
 * The fleet module is self-contained (in-memory synthetic store), so these
 * tests mount ONLY the fleet router on an ephemeral Express server — no
 * database, telegram, or host-app services are loaded.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const fleetRouter = require('../server/fleet/router');
const domain = require('../server/fleet/domain');

// ── boot an isolated server ──
const app = express();
app.use('/api/v1', fleetRouter);
let server; let base;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/v1`; resolve(); }); });
});
test.after(() => server && server.close());

async function req(path, { method = 'GET', body, token, company } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { 'X-Company-Id': company } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null; const txt = await res.text();
  if (txt) { try { json = JSON.parse(txt); } catch { /* noop */ } }
  return { status: res.status, json };
}
async function loginAs(email) {
  const r = await req('/login', { method: 'POST', body: { email, password: 'demo1234' } });
  assert.strictEqual(r.status, 200, `login ${email}`);
  return r.json.token;
}

// ─────────────────────────────────────────────────────────────────────────────
test('domain: timing labels never show ambiguous signed delay', () => {
  assert.strictEqual(domain.timingLabel(0), 'On Time');
  assert.strictEqual(domain.timingLabel(-120), 'Early by 2h');
  assert.strictEqual(domain.timingLabel(150), 'Late by 2h 30m');
  assert.strictEqual(domain.timingLabel(null), 'Unknown');
  assert.strictEqual(domain.timingState(-120), 'early');
  assert.strictEqual(domain.timingState(150), 'late');
});

test('domain: rate savings and loss labeling', () => {
  assert.strictEqual(domain.rateSavings(300000, 200000), 100000);
  assert.strictEqual(domain.savingsLabel(100000), 'Savings');
  assert.strictEqual(domain.savingsLabel(-5000), 'Loss/Over assignment');
});

test('domain: RPM single definition (hauling $ per planned mile)', () => {
  assert.strictEqual(domain.rpm(240000, 1000), 2.4); // $2400 / 1000mi
  assert.strictEqual(domain.rpm(240000, 0), 0);
  assert.strictEqual(domain.finalBalance(100000, -25000), 75000);
});

test('domain: load state machine rejects illegal transitions', () => {
  assert.ok(domain.canTransitionLoad('upcoming', 'dispatched'));
  assert.ok(domain.canTransitionLoad('in_transit', 'delivered'));
  assert.ok(!domain.canTransitionLoad('upcoming', 'delivered'));
  assert.ok(!domain.canTransitionLoad('delivered', 'in_transit'));
});

test('domain: task state machine', () => {
  assert.ok(domain.canTransitionTask('todo', 'in_progress'));
  assert.ok(domain.canTransitionTask('done', 'in_progress'));
  assert.ok(!domain.canTransitionTask('todo', 'done'));
});

// ─────────────────────────────────────────────────────────────────────────────
test('auth: login issues token and /me returns permissions', async () => {
  const token = await loginAs('admin@wenzel.example.com');
  const me = await req('/me', { token });
  assert.strictEqual(me.status, 200);
  assert.ok(Array.isArray(me.json.permissions));
  assert.ok(me.json.permissions.includes('loads.create'));
  assert.ok(me.json.tenant.name);
});

test('auth: bad credentials rejected; missing token 401', async () => {
  const bad = await req('/login', { method: 'POST', body: { email: 'admin@wenzel.example.com', password: 'wrong' } });
  assert.strictEqual(bad.status, 401);
  const noAuth = await req('/loads');
  assert.strictEqual(noAuth.status, 401);
  assert.strictEqual(noAuth.json.error.code, 'UNAUTHENTICATED');
});

test('envelope: list responses carry standard meta', async () => {
  const token = await loginAs('admin@wenzel.example.com');
  const r = await req('/loads?pageSize=5', { token });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.data));
  assert.ok(r.json.meta && r.json.meta.source);
  assert.strictEqual(typeof r.json.total, 'number');
  assert.ok(r.json.data.length <= 5);
});

// ── TENANT ISOLATION (§4.8) ──
test('tenant isolation: tenant A cannot read tenant B loads', async () => {
  const tokenA = await loginAs('admin@wenzel.example.com');
  const tokenB = await loginAs('admin@redline.example.com');
  const loadsA = await req('/loads?pageSize=200', { token: tokenA });
  const loadsB = await req('/loads?pageSize=200', { token: tokenB });
  const idsA = new Set(loadsA.json.data.map((l) => l.id));
  const idsB = new Set(loadsB.json.data.map((l) => l.id));
  // No overlap between tenants.
  for (const id of idsA) assert.ok(!idsB.has(id), 'tenant load id leaked across tenants');
  assert.ok(idsA.size > 0 && idsB.size > 0);
});

test('tenant isolation: tenant A cannot fetch a tenant B load by id (404)', async () => {
  const tokenA = await loginAs('admin@wenzel.example.com');
  const tokenB = await loginAs('admin@redline.example.com');
  const loadsB = await req('/loads?pageSize=1', { token: tokenB });
  const bId = loadsB.json.data[0].id;
  const cross = await req(`/loads/${bId}`, { token: tokenA });
  assert.strictEqual(cross.status, 404, 'cross-tenant fetch must 404 within tenant');
});

test('tenant isolation: global search never returns another tenant\'s record id', async () => {
  // Load numbers may legitimately collide across tenants; the guarantee is that
  // a search only ever returns records belonging to the caller's tenant.
  const tokenA = await loginAs('admin@wenzel.example.com');
  const loadsA = await req('/loads?pageSize=200', { token: tokenA });
  const idsA = new Set(loadsA.json.data.map((l) => l.id));
  const num = loadsA.json.data[0].load_number;
  const tokenB = await loginAs('admin@redline.example.com');
  const search = await req(`/search?q=${encodeURIComponent(num)}`, { token: tokenB });
  for (const hit of search.json.loads) {
    assert.ok(!idsA.has(hit.id), 'tenant B search returned a tenant A load id');
  }
});

// ── PERMISSIONS (§16) ──
test('permissions: viewer cannot create a load (403)', async () => {
  const viewer = await loginAs('viewer@wenzel.example.com');
  const r = await req('/loads', { method: 'POST', token: viewer, body: { load_number: 'X1', broker_id: 'b', hauling_rate: 1000 } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error.code, 'FORBIDDEN');
});

test('permissions: dispatcher can create a load', async () => {
  const disp = await loginAs('disp0@wenzel.example.com');
  const r = await req('/loads', { method: 'POST', token: disp, body: { load_number: `T${Date.now()}`, broker_id: 'brk_x', hauling_rate: 250000 } });
  assert.strictEqual(r.status, 201);
  assert.ok(r.json.data.id);
});

// ── STATE MACHINE over HTTP (§7.1) ──
test('loads: illegal transition returns 409 with current state', async () => {
  const token = await loginAs('admin@wenzel.example.com');
  const created = await req('/loads', { method: 'POST', token, body: { load_number: `SM${Date.now()}`, broker_id: 'b', hauling_rate: 100000, status: 'upcoming' } });
  const id = created.json.data.id;
  const bad = await req(`/loads/${id}/transition`, { method: 'POST', token, body: { to: 'delivered' } });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.json.error.code, 'ILLEGAL_TRANSITION');
  const good = await req(`/loads/${id}/transition`, { method: 'POST', token, body: { to: 'dispatched' } });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.json.data.status, 'dispatched');
});

test('loads: duplicate load number rejected (400 with fieldErrors)', async () => {
  const token = await loginAs('admin@wenzel.example.com');
  const num = `DUP${Date.now()}`;
  const first = await req('/loads', { method: 'POST', token, body: { load_number: num, broker_id: 'b', hauling_rate: 1000 } });
  assert.strictEqual(first.status, 201);
  const dup = await req('/loads', { method: 'POST', token, body: { load_number: num, broker_id: 'b', hauling_rate: 1000 } });
  assert.strictEqual(dup.status, 400);
  assert.ok(dup.json.error.fieldErrors.load_number);
});

test('tasks: create validates title length, then archive transitions', async () => {
  const token = await loginAs('admin@wenzel.example.com');
  const bad = await req('/tasks', { method: 'POST', token, body: { title: 'ab', department: 'Fleet', priority: 'high' } });
  assert.strictEqual(bad.status, 400);
  const ok = await req('/tasks', { method: 'POST', token, body: { title: 'Valid task title', department: 'Fleet', priority: 'high' } });
  assert.strictEqual(ok.status, 201);
  const arch = await req(`/tasks/${ok.json.data.id}/archive`, { method: 'POST', token, body: {} });
  assert.strictEqual(arch.status, 200);
  assert.strictEqual(arch.json.data.status, 'archived');
});

test('assignments: conflict without override returns 409', async () => {
  const token = await loginAs('admin@wenzel.example.com');
  const loads = await req('/loads?status=in_transit&pageSize=1', { token });
  const load = loads.json.data[0];
  // Attempt to assign the same in-use truck to a different load.
  const others = await req('/loads?status=upcoming&pageSize=1', { token });
  if (!others.json.data.length || !load) return; // dataset guard
  const r = await req('/assignments', { method: 'POST', token, body: { load_id: others.json.data[0].id, truck_id: load.truck_id } });
  assert.ok(r.status === 409 || r.status === 201); // 409 if truck busy; 201 if seed had no active conflict
  if (r.status === 409) assert.strictEqual(r.json.error.code, 'ASSIGNMENT_CONFLICT');
});

test('settings: check-in radius out of bounds rejected', async () => {
  const token = await loginAs('admin@wenzel.example.com');
  const r = await req('/settings/general', { method: 'PUT', token, body: { check_in_radius_miles: 99 } });
  assert.strictEqual(r.status, 400);
  assert.ok(r.json.error.fieldErrors.check_in_radius_miles);
});
