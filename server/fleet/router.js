/**
 * Fleet Operations Platform API — /api/v1 (§11).
 *
 * Self-contained Express router. Backed by the synthetic tenant-scoped store.
 * Every list returns the standard envelope; every mutation is permission-gated,
 * version-checked where relevant, audited, and validated server-side.
 */

'use strict';

const express = require('express');
const { DB } = require('./store');
const D = require('./domain');
const { login, loginReal, issueToken, authenticate, requirePermission, scoped, audit, permissionsForUser } = require('./auth');
const { isReal, isDemo, dataMode, REAL_TENANT, REAL_COMPANY } = require('./config');
const realProvider = require('./realProvider');

const router = express.Router();
router.use(express.json({ limit: '2mb' }));

// Public: lets the SPA know whether it is showing demo or real data.
router.get('/mode', (req, res) => res.json({ mode: dataMode() }));

// ── helpers ──────────────────────────────────────────────────────────────────
function paginate(rows, req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const total = rows.length;
  const start = (page - 1) * pageSize;
  return { slice: rows.slice(start, start + pageSize), page, pageSize, total };
}
function byId(collection, id, tid) {
  return DB[collection].find((r) => r.id === id && r.tenant_id === tid);
}
function nameOfUser(tid, id) {
  const u = DB.users.find((x) => x.id === id && x.tenant_id === tid);
  return u ? u.display_name : null;
}
function nameOfDriver(tid, id) {
  const d = DB.drivers.find((x) => x.id === id && x.tenant_id === tid);
  return d ? d.display_name : null;
}
function nameOfBroker(tid, id) {
  const b = DB.brokers.find((x) => x.id === id && x.tenant_id === tid);
  return b ? b.display_name : null;
}
function unitOf(tid, id) {
  const e = DB.equipment.find((x) => x.id === id && x.tenant_id === tid);
  return e ? e.unit_number : null;
}
function latestEta(tid, loadId) {
  return scopedByTenant(tid, 'etaSnapshots').filter((e) => e.load_id === loadId)
    .sort((a, b) => new Date(b.calculated_at) - new Date(a.calculated_at));
}
function scopedByTenant(tid, collection) {
  return DB[collection].filter((r) => r.tenant_id === tid);
}
function latestLocation(tid, truckId) {
  return scopedByTenant(tid, 'vehicleLocations').filter((v) => v.truck_id === truckId)
    .sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at))[0] || null;
}

// Enrich a load row with joined display fields + timing (single source of truth).
function enrichLoad(tid, load) {
  const etas = latestEta(tid, load.id);
  const eta = etas[0] || null;
  const prevEta = etas[1] || null;
  const loc = latestLocation(tid, load.truck_id);
  const eld = DB.eldStatus.find((e) => e.tenant_id === tid && e.driver_id === load.driver_id) || null;
  return {
    ...load,
    driver_name: nameOfDriver(tid, load.driver_id),
    dispatcher_name: nameOfUser(tid, load.dispatcher_id),
    broker_name: nameOfBroker(tid, load.broker_id),
    truck_unit: unitOf(tid, load.truck_id),
    trailer_unit: unitOf(tid, load.trailer_id),
    rate_savings: D.rateSavings(load.hauling_rate, load.assigned_rate),
    rpm: D.rpm(load.hauling_rate, load.planned_distance_miles),
    eta: eta ? {
      eta_utc: eta.eta_utc, remaining_miles: eta.remaining_miles, calculated_at: eta.calculated_at,
      timing_state: eta.timing_state, timing_label: D.timingLabel(eta.schedule_variance_minutes),
      schedule_variance_minutes: eta.schedule_variance_minutes,
    } : null,
    previous_eta: prevEta ? { eta_utc: prevEta.eta_utc, calculated_at: prevEta.calculated_at } : null,
    location: loc ? {
      latitude: loc.latitude, longitude: loc.longitude, speed_mph: loc.speed_mph,
      observed_at: loc.observed_at, source: loc.source_provider,
      freshness: D.locationFreshness(loc.observed_at),
    } : null,
    eld_state: eld ? {
      connection_state: eld.connection_state, stationary: eld.stationary,
      sleep_timer_minutes: eld.sleep_timer_minutes, inspection_state: eld.inspection_state,
    } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth (public)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  try {
    const result = isReal() ? await loginReal(email, password) : login(email, password);
    if (!result) return D.apiError(res, 401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
    const { user, token, activeCompanyId } = result;
    return res.json({
      token,
      user: { id: user.id, name: user.display_name, email: user.email },
      activeCompanyId,
    });
  } catch (e) {
    return D.apiError(res, 500, 'AUTH_UNAVAILABLE', 'Authentication is not configured.');
  }
});

// Everything below requires authentication.
router.use(authenticate);

// Real mode is READ-FIRST toward external systems: FleetView may write ONLY to
// its own fleet_* tables (tasks, settings, sync runs, support/audit records).
// Every other mutation — loads, assignments, imports, master data, anything
// that would touch DataTruck/Samsara/Telegram/Bitrix/etc. — returns an honest
// 501 until a specific write is approved, gated, and audited.
const REAL_WRITE_ALLOW = new Set([
  '/session/active-company', '/logout', '/notifications',
  '/tasks', '/settings/general', '/sync', '/support/tickets',
]);
router.use((req, res, next) => {
  if (!isReal()) return next();
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
  if (!mutating) return next();
  const allowed = [...REAL_WRITE_ALLOW].some((p) => req.path === p || req.path.startsWith(`${p}/`));
  if (allowed) return next();
  return D.apiError(res, 501, 'READ_ONLY_MODE', 'FleetView real mode is read-only toward external systems. This write action is not yet enabled.', { retryable: false });
});

router.get('/me', (req, res) => {
  const { user, tenantId, companyId } = req.auth;
  if (isReal()) {
    return res.json({
      id: user.id, name: user.display_name, email: user.email, department: 'Fleet',
      tenant: { id: REAL_TENANT.id, name: REAL_TENANT.name, plan: 'operational' },
      activeCompanyId: REAL_COMPANY.id,
      companies: [{ id: REAL_COMPANY.id, name: REAL_COMPANY.name }],
      roles: ['Administrator'],
      permissions: req.auth.permissions,
      dataMode: 'real',
    });
  }
  const tenant = DB.tenants.find((t) => t.id === tenantId);
  res.json({
    id: user.id, name: user.display_name, email: user.email, department: user.department,
    tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan },
    activeCompanyId: companyId,
    companies: user.company_ids.map((cid) => {
      const c = DB.companies.find((x) => x.id === cid);
      return c ? { id: c.id, name: c.name } : null;
    }).filter(Boolean),
    roles: user.role_ids.map((rid) => (DB.roles.find((r) => r.id === rid) || {}).name).filter(Boolean),
    permissions: req.auth.permissions,
  });
});

router.get('/me/companies', (req, res) => {
  const companies = req.auth.user.company_ids
    .map((cid) => DB.companies.find((c) => c.id === cid)).filter(Boolean);
  res.json(D.envelope(companies));
});

router.post('/session/active-company', (req, res) => {
  const { companyId } = req.body || {};
  if (!req.auth.user.company_ids.includes(companyId)) {
    return D.apiError(res, 403, 'FORBIDDEN', 'You do not have access to that company.');
  }
  res.json({ token: issueToken(req.auth.user, companyId), activeCompanyId: companyId });
});

router.post('/logout', (req, res) => res.json({ ok: true }));

// ── Global search (§9.1) ──
router.get('/search', async (req, res) => {
  if (isReal()) return res.json(await realProvider.search(req.query.q));
  const q = String(req.query.q || '').trim().toLowerCase();
  const tid = req.auth.tenantId;
  if (!q) return res.json({ loads: [], drivers: [], trucks: [] });
  const loads = scopedByTenant(tid, 'loads')
    .filter((l) => l.load_number.toLowerCase().includes(q) || l.trip_number.toLowerCase().includes(q))
    .slice(0, 6).map((l) => ({ id: l.id, label: l.load_number, context: `${l.origin_label} → ${l.destination_label}` }));
  const drivers = scopedByTenant(tid, 'drivers')
    .filter((d) => d.display_name.toLowerCase().includes(q))
    .slice(0, 6).map((d) => ({ id: d.id, label: d.display_name, context: d.position }));
  const trucks = scopedByTenant(tid, 'equipment')
    .filter((e) => e.type === 'truck' && String(e.unit_number).toLowerCase().includes(q))
    .slice(0, 6).map((e) => ({ id: e.id, label: `Unit ${e.unit_number}`, context: `${e.make} ${e.model}` }));
  res.json({ loads, drivers, trucks });
});

// ── Notifications ──
router.get('/notifications', (req, res) => {
  const rows = scoped(req, 'notifications').filter((n) => n.user_id === req.auth.user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(D.envelope(rows));
});
router.post('/notifications/:id/read', (req, res) => {
  const n = scoped(req, 'notifications').find((x) => x.id === req.params.id);
  if (n) n.read = true;
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard (§10.1)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard/task-summary', async (req, res) => {
  if (isReal()) return res.json(await realProvider.taskSummary(req.auth.tenantId));
  const tasks = scoped(req, 'tasks').filter((t) => t.company_scoped !== false);
  const today = '2026-07-03';
  res.json({
    doneTickets: tasks.filter((t) => t.status === 'done').length,
    highPriorityTickets: tasks.filter((t) => t.priority === 'high' && t.status !== 'archived').length,
    unassignedTickets: tasks.filter((t) => !t.assignee_id && t.status !== 'archived').length,
    todaysTickets: tasks.filter((t) => (t.created_at || '').startsWith(today)).length,
  });
});

router.get('/dashboard/task-chart', async (req, res) => {
  if (isReal()) return res.json(await realProvider.taskChart(req.auth.tenantId));
  const tasks = scoped(req, 'tasks');
  const depts = ['Fleet', 'Dispatcher', 'Safety', 'HR', 'Accounting'];
  const series = depts.map((dept) => ({
    department: dept,
    todo: tasks.filter((t) => t.department_id === dept && t.status === 'todo').length,
    inProgress: tasks.filter((t) => t.department_id === dept && t.status === 'in_progress').length,
    done: tasks.filter((t) => t.department_id === dept && t.status === 'done').length,
  }));
  res.json({ data: series });
});

router.get('/dashboard/loads', async (req, res) => {
  if (isReal()) return res.json(await realProvider.dashboardLoads({ segment: req.query.segment || 'all', search: req.query.search }));
  const seg = req.query.segment || 'all';
  const q = String(req.query.search || '').trim().toLowerCase();
  let rows = scoped(req, 'loads');
  if (seg === 'dispatched') rows = rows.filter((l) => l.status === 'dispatched');
  else if (seg === 'in_transit') rows = rows.filter((l) => l.status === 'in_transit');
  if (q) rows = rows.filter((l) => l.load_number.toLowerCase().includes(q) || (nameOfDriver(req.auth.tenantId, l.driver_id) || '').toLowerCase().includes(q));
  rows.sort((a, b) => (b.pinned - a.pinned) || (new Date(b.updated_at) - new Date(a.updated_at)));
  const { slice, page, pageSize, total } = paginate(rows, req);
  res.json(D.envelope(slice.map((l) => enrichLoad(req.auth.tenantId, l)), { page, pageSize, total }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Tasks (§10.2)
// ─────────────────────────────────────────────────────────────────────────────
function enrichTask(tid, t) {
  const load = t.related_load_id ? byId('loads', t.related_load_id, tid) : null;
  const eta = load ? (latestEta(tid, load.id)[0] || null) : null;
  return {
    ...t,
    assignee_name: nameOfUser(tid, t.assignee_id),
    creator_name: nameOfUser(tid, t.creator_id),
    driver_name: nameOfDriver(tid, t.related_driver_id),
    broker_name: nameOfBroker(tid, t.related_broker_id),
    dispatcher_name: load ? nameOfUser(tid, load.dispatcher_id) : null,
    load_number: load ? load.load_number : null,
    load_route: load ? `${load.origin_label} → ${load.destination_label}` : null,
    dropoff_address: load ? load.destination_label : null,
    eta_label: eta ? D.timingLabel(eta.schedule_variance_minutes) : null,
    labels: (t.label_ids || []).map((lid) => DB.taskLabels.find((l) => l.id === lid)).filter(Boolean)
      .map((l) => ({ id: l.id, name: l.name, color: l.color })),
  };
}

router.get('/tasks', requirePermission('tasks.read'), async (req, res) => {
  if (isReal()) {
    try {
      let rows = await require('./realTasks').list(req.auth.tenantId);
      const { department, priority, search } = req.query;
      if (department) rows = rows.filter((t) => t.department_id === department);
      if (priority) rows = rows.filter((t) => t.priority === priority);
      if (search) rows = rows.filter((t) => t.title.toLowerCase().includes(String(search).toLowerCase()));
      return res.json(D.envelope(rows, { total: rows.length, pageSize: rows.length }));
    } catch (e) {
      return D.apiError(res, 503, 'STORE_UNAVAILABLE', 'Task store unavailable.', { retryable: true });
    }
  }
  const tid = req.auth.tenantId;
  let rows = scoped(req, 'tasks');
  const { department, priority, assignee, driver, dispatcher, label, search } = req.query;
  if (department) rows = rows.filter((t) => t.department_id === department);
  if (priority) rows = rows.filter((t) => t.priority === priority);
  if (assignee) rows = rows.filter((t) => t.assignee_id === assignee);
  if (driver) rows = rows.filter((t) => t.related_driver_id === driver);
  if (dispatcher) {
    rows = rows.filter((t) => {
      const l = t.related_load_id ? byId('loads', t.related_load_id, tid) : null;
      return l && l.dispatcher_id === dispatcher;
    });
  }
  if (label) rows = rows.filter((t) => (t.label_ids || []).includes(label));
  if (search) {
    const s = String(search).toLowerCase();
    rows = rows.filter((t) => t.title.toLowerCase().includes(s));
  }
  const sort = req.query.sort || 'created_at';
  const dir = req.query.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => (a[sort] > b[sort] ? dir : -dir));
  res.json(D.envelope(rows.map((t) => enrichTask(tid, t)), { total: rows.length, pageSize: rows.length }));
});

router.post('/tasks', requirePermission('tasks.create'), async (req, res) => {
  const { title, description, department, priority, assignee_id, related_load_id, label_ids, due_at } = req.body || {};
  const fieldErrors = {};
  if (!title || title.trim().length < 3 || title.length > 200) fieldErrors.title = 'Title must be 3–200 characters.';
  if (!department) fieldErrors.department = 'Department is required.';
  if (!priority) fieldErrors.priority = 'Priority is required.';
  if (description && description.length > 10000) fieldErrors.description = 'Max 10,000 characters.';
  if (Object.keys(fieldErrors).length) return D.apiError(res, 400, 'VALIDATION', 'Please correct the highlighted fields.', { fieldErrors });
  if (isReal()) {
    try {
      const task = await require('./realTasks').create(req.auth.tenantId, req.auth.companyId, req.auth.user.id, {
        title: title.trim(), description, department, priority, assignee_id, related_load_id, label_ids, due_at,
      });
      audit(req, 'task.create', 'task', task.id, null, task);
      return res.status(201).json({ data: task });
    } catch (e) {
      return D.apiError(res, 503, 'STORE_UNAVAILABLE', 'Task store unavailable.', { retryable: true });
    }
  }
  const { uid } = require('./store');
  const now = new Date().toISOString();
  const task = {
    id: uid('tsk'), tenant_id: req.auth.tenantId, title: title.trim(), description: description || '',
    status: 'todo', priority, department_id: department, creator_id: req.auth.user.id,
    assignee_id: assignee_id || null, related_load_id: related_load_id || null, related_driver_id: null,
    related_broker_id: null, related_company_id: req.auth.companyId, label_ids: label_ids || [],
    due_at: due_at || null, source: 'manual', version: 1, created_at: now, updated_at: now,
    has_linked_conversation: false,
  };
  DB.tasks.push(task);
  DB.taskActivity.push({ id: uid('act'), tenant_id: req.auth.tenantId, task_id: task.id, type: 'created', actor: req.auth.user.id, timestamp: now, detail: 'Task created' });
  audit(req, 'task.create', 'task', task.id, null, task);
  res.status(201).json({ data: enrichTask(req.auth.tenantId, task), auditId: `aud_${DB.auditLog.length}` });
});

router.get('/tasks/:id', requirePermission('tasks.read'), async (req, res) => {
  if (isReal()) {
    const t = await require('./realTasks').get(req.params.id, req.auth.tenantId).catch(() => null);
    if (!t) return D.apiError(res, 404, 'NOT_FOUND', 'Task not found.');
    return res.json({ data: t });
  }
  const t = byId('tasks', req.params.id, req.auth.tenantId);
  if (!t) return D.apiError(res, 404, 'NOT_FOUND', 'Task not found.');
  res.json({ data: enrichTask(req.auth.tenantId, t) });
});

router.patch('/tasks/:id', requirePermission('tasks.create', 'tasks.comment'), async (req, res) => {
  if (isReal()) {
    const realTasks = require('./realTasks');
    const t = await realTasks.get(req.params.id, req.auth.tenantId).catch(() => null);
    if (!t) return D.apiError(res, 404, 'NOT_FOUND', 'Task not found.');
    const { version, status, priority, assignee_id } = req.body || {};
    if (version != null && version !== t.version) {
      return D.apiError(res, 409, 'VERSION_CONFLICT', 'This task changed since you opened it. Refresh and retry.');
    }
    if (status && status !== t.status && !D.canTransitionTask(t.status, status)) {
      return D.apiError(res, 409, 'ILLEGAL_TRANSITION', `Cannot move task from ${t.status} to ${status}.`);
    }
    const updated = await realTasks.update(req.auth.tenantId, t.id, { status, priority, assignee_id });
    if (status && status !== t.status) await realTasks.activity(req.auth.tenantId, t.id, 'status_changed', req.auth.user.id, `${t.status} → ${status}`);
    audit(req, 'task.update', 'task', t.id, t, updated);
    return res.json({ data: updated });
  }
  const t = byId('tasks', req.params.id, req.auth.tenantId);
  if (!t) return D.apiError(res, 404, 'NOT_FOUND', 'Task not found.');
  const { version, status, priority, assignee_id } = req.body || {};
  if (version != null && version !== t.version) {
    return D.apiError(res, 409, 'VERSION_CONFLICT', 'This task changed since you opened it. Refresh and retry.');
  }
  const before = { ...t };
  if (status && status !== t.status) {
    if (!D.canTransitionTask(t.status, status)) {
      return D.apiError(res, 409, 'ILLEGAL_TRANSITION', `Cannot move task from ${t.status} to ${status}.`);
    }
    t.status = status;
    DB.taskActivity.push({ id: `act_${DB.taskActivity.length + 1}`, tenant_id: t.tenant_id, task_id: t.id, type: 'status_changed', actor: req.auth.user.id, timestamp: new Date().toISOString(), detail: `${before.status} → ${status}` });
  }
  if (priority) t.priority = priority;
  if (assignee_id !== undefined) t.assignee_id = assignee_id;
  t.version += 1;
  t.updated_at = new Date().toISOString();
  audit(req, 'task.update', 'task', t.id, before, t);
  res.json({ data: enrichTask(req.auth.tenantId, t) });
});

router.post('/tasks/:id/comments', requirePermission('tasks.comment'), async (req, res) => {
  const body = String((req.body || {}).body || '').trim();
  if (!body) return D.apiError(res, 400, 'VALIDATION', 'Comment cannot be empty.', { fieldErrors: { body: 'Required.' } });
  if (isReal()) {
    const realTasks = require('./realTasks');
    const t = await realTasks.get(req.params.id, req.auth.tenantId).catch(() => null);
    if (!t) return D.apiError(res, 404, 'NOT_FOUND', 'Task not found.');
    const c = await realTasks.addComment(req.auth.tenantId, t.id, req.auth.user.id, body);
    return res.status(201).json({ data: c });
  }
  const t = byId('tasks', req.params.id, req.auth.tenantId);
  if (!t) return D.apiError(res, 404, 'NOT_FOUND', 'Task not found.');
  const { uid } = require('./store');
  const c = { id: uid('cmt'), tenant_id: t.tenant_id, task_id: t.id, body, author_id: req.auth.user.id, mentions: (req.body.mentions || []), created_at: new Date().toISOString() };
  DB.taskComments.push(c);
  res.status(201).json({ data: { ...c, author_name: nameOfUser(t.tenant_id, c.author_id) } });
});

router.get('/tasks/:id/comments', requirePermission('tasks.read'), async (req, res) => {
  if (isReal()) {
    const rows = await require('./realTasks').listComments(req.auth.tenantId, req.params.id).catch(() => []);
    return res.json(D.envelope(rows));
  }
  const rows = scoped(req, 'taskComments').filter((c) => c.task_id === req.params.id)
    .map((c) => ({ ...c, author_name: nameOfUser(req.auth.tenantId, c.author_id) }));
  res.json(D.envelope(rows));
});

router.get('/tasks/:id/activity', requirePermission('tasks.read'), async (req, res) => {
  if (isReal()) {
    const rows = await require('./realTasks').listActivity(req.auth.tenantId, req.params.id).catch(() => []);
    return res.json(D.envelope(rows));
  }
  const rows = scoped(req, 'taskActivity').filter((a) => a.task_id === req.params.id)
    .map((a) => ({ ...a, actor_name: nameOfUser(req.auth.tenantId, a.actor) }));
  res.json(D.envelope(rows));
});

router.get('/tasks/:id/chat-history', requirePermission('tasks.read'), (req, res) => {
  const t = byId('tasks', req.params.id, req.auth.tenantId);
  if (t && t.has_linked_conversation) {
    return res.json(D.envelope([
      { id: 'm1', from: 'driver', text: 'Checked in at pickup.', at: '2026-07-03T14:00:00Z' },
      { id: 'm2', from: 'dispatch', text: 'Copy, safe travels.', at: '2026-07-03T14:02:00Z' },
    ]));
  }
  res.json(D.envelope([]));
});

router.get('/tasks/:id/broker-mail-history', requirePermission('tasks.read'), (req, res) => {
  const t = byId('tasks', req.params.id, req.auth.tenantId);
  const threads = t && t.related_broker_id
    ? scoped(req, 'emailThreads').filter((th) => th.related_broker_id === t.related_broker_id).slice(0, 5)
    : [];
  res.json(D.envelope(threads));
});

async function taskLifecycle(req, res, toStatus, action) {
  if (isReal()) {
    const realTasks = require('./realTasks');
    const t = await realTasks.get(req.params.id, req.auth.tenantId).catch(() => null);
    if (!t) return D.apiError(res, 404, 'NOT_FOUND', 'Task not found.');
    if (toStatus === 'archived' && !D.canTransitionTask(t.status, 'archived')) {
      return D.apiError(res, 409, 'ILLEGAL_TRANSITION', 'Cannot archive from current state.');
    }
    const updated = await realTasks.update(req.auth.tenantId, t.id, { status: toStatus });
    await realTasks.activity(req.auth.tenantId, t.id, action, req.auth.user.id, `${t.status} → ${toStatus}`);
    audit(req, `task.${action}`, 'task', t.id, t, updated, (req.body || {}).reason);
    return res.json({ data: updated });
  }
  const t = byId('tasks', req.params.id, req.auth.tenantId);
  if (!t) return D.apiError(res, 404, 'NOT_FOUND', 'Task not found.');
  if (toStatus === 'archived' && !D.canTransitionTask(t.status, 'archived')) return D.apiError(res, 409, 'ILLEGAL_TRANSITION', 'Cannot archive from current state.');
  const before = { ...t }; t.status = toStatus; t.version += 1;
  audit(req, `task.${action}`, 'task', t.id, before, t, (req.body || {}).reason);
  return res.json({ data: enrichTask(req.auth.tenantId, t) });
}
router.post('/tasks/:id/archive', requirePermission('tasks.archive'), (req, res) => taskLifecycle(req, res, 'archived', 'archive'));
router.post('/tasks/:id/restore', requirePermission('tasks.archive'), (req, res) => taskLifecycle(req, res, 'todo', 'restore'));

// ─────────────────────────────────────────────────────────────────────────────
// Loads (§10.3)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/loads', requirePermission('loads.read'), async (req, res) => {
  if (isReal()) return res.json(await realProvider.loadsList({ status: req.query.status, search: req.query.search }));
  const tid = req.auth.tenantId;
  let rows = scoped(req, 'loads');
  const { status, dispatcher, driver, broker, paperwork, search, warning } = req.query;
  if (status && status !== 'all') rows = rows.filter((l) => l.status === status);
  if (dispatcher) rows = rows.filter((l) => l.dispatcher_id === dispatcher);
  if (driver) rows = rows.filter((l) => l.driver_id === driver);
  if (broker) rows = rows.filter((l) => l.broker_id === broker);
  if (paperwork) rows = rows.filter((l) => l.paperwork_state === paperwork);
  if (search) {
    const s = String(search).toLowerCase();
    rows = rows.filter((l) => l.load_number.toLowerCase().includes(s) || (nameOfDriver(tid, l.driver_id) || '').toLowerCase().includes(s));
  }
  const enriched = rows.map((l) => enrichLoad(tid, l));
  let filtered = enriched;
  if (warning === 'eld_not_connected') filtered = enriched.filter((l) => l.eld_state && l.eld_state.connection_state !== 'connected');
  else if (warning === 'stationary') filtered = enriched.filter((l) => l.eld_state && l.eld_state.stationary);
  else if (warning === 'detention') filtered = enriched.filter((l) => l.paperwork_state === 'has_issue');
  filtered.sort((a, b) => (b.pinned - a.pinned) || (new Date(b.updated_at) - new Date(a.updated_at)));
  const { slice, page, pageSize, total } = paginate(filtered, req);
  res.json(D.envelope(slice, { page, pageSize, total }));
});

router.get('/loads/kpis', requirePermission('loads.read'), async (req, res) => {
  if (isReal()) return res.json(await realProvider.loadsKpis());
  const tid = req.auth.tenantId;
  const enriched = scoped(req, 'loads').map((l) => enrichLoad(tid, l));
  res.json({
    delayed: enriched.filter((l) => l.eta && l.eta.timing_state === 'late').length,
    exceptions: enriched.filter((l) => l.paperwork_state !== 'all_good' || (l.eld_state && l.eld_state.connection_state !== 'connected')).length,
    inTransit: enriched.filter((l) => l.status === 'in_transit').length,
    delivered: enriched.filter((l) => l.status === 'delivered').length,
  });
});

router.post('/loads', requirePermission('loads.create'), (req, res) => {
  const b = req.body || {};
  const fieldErrors = {};
  if (!b.load_number) fieldErrors.load_number = 'Load number is required.';
  else if (scoped(req, 'loads').some((l) => l.load_number === b.load_number)) fieldErrors.load_number = 'Load number already exists for this tenant.';
  if (!b.broker_id) fieldErrors.broker_id = 'Broker is required.';
  if (b.hauling_rate == null) fieldErrors.hauling_rate = 'Hauling rate is required.';
  if (Object.keys(fieldErrors).length) return D.apiError(res, 400, 'VALIDATION', 'Please correct the highlighted fields.', { fieldErrors });
  const { uid } = require('./store');
  const now = new Date().toISOString();
  const load = {
    id: uid('lod'), tenant_id: req.auth.tenantId, company_id: req.auth.companyId,
    load_number: b.load_number, trip_number: b.trip_number || '', customer_ref: b.customer_ref || '',
    broker_id: b.broker_id, status: b.status || 'upcoming', dispatcher_id: b.dispatcher_id || null,
    driver_id: b.driver_id || null, truck_id: b.truck_id || null, trailer_id: b.trailer_id || null,
    hauling_rate: b.hauling_rate, assigned_rate: b.assigned_rate || 0, currency: b.currency || 'USD',
    planned_distance_miles: b.planned_distance_miles || 0, actual_distance_miles: null,
    pickup_window_start: b.pickup_window_start || now, pickup_window_end: b.pickup_window_end || now,
    delivery_window_start: b.delivery_window_start || now, delivery_window_end: b.delivery_window_end || now,
    source_timezone: b.source_timezone || 'America/Chicago', source_system: 'manual', external_id: null,
    version: 1, origin_label: b.origin_label || '', destination_label: b.destination_label || '',
    paperwork_state: 'all_good', pinned: false, created_at: now, updated_at: now,
  };
  DB.loads.push(load);
  DB.loadStatusHistory.push({ id: uid('lsh'), tenant_id: load.tenant_id, load_id: load.id, previous_status: null, new_status: load.status, actor: req.auth.user.id, source: 'manual', timestamp: now, reason: 'Created', external_event_id: null });
  audit(req, 'load.create', 'load', load.id, null, load);
  res.status(201).json({ data: enrichLoad(req.auth.tenantId, load), auditId: `aud_${DB.auditLog.length}` });
});

router.get('/loads/:id', requirePermission('loads.read'), async (req, res) => {
  if (isReal()) {
    const l = await realProvider.loadById(req.params.id);
    if (!l) return D.apiError(res, 404, 'NOT_FOUND', 'Load not found.');
    return res.json({ data: l });
  }
  const l = byId('loads', req.params.id, req.auth.tenantId);
  if (!l) return D.apiError(res, 404, 'NOT_FOUND', 'Load not found.');
  const stops = scoped(req, 'loadStops').filter((s) => s.load_id === l.id).sort((a, b) => a.sequence - b.sequence);
  res.json({ data: { ...enrichLoad(req.auth.tenantId, l), stops } });
});

router.patch('/loads/:id', requirePermission('loads.update'), (req, res) => {
  const l = byId('loads', req.params.id, req.auth.tenantId);
  if (!l) return D.apiError(res, 404, 'NOT_FOUND', 'Load not found.');
  const b = req.body || {};
  if (b.version != null && b.version !== l.version) return D.apiError(res, 409, 'VERSION_CONFLICT', 'Load changed since you opened it. Refresh and retry.');
  const before = { ...l };
  ['hauling_rate', 'assigned_rate', 'trip_number', 'customer_ref', 'planned_distance_miles', 'origin_label', 'destination_label', 'paperwork_state', 'pinned'].forEach((k) => {
    if (b[k] !== undefined) l[k] = b[k];
  });
  l.version += 1; l.updated_at = new Date().toISOString();
  audit(req, 'load.update', 'load', l.id, before, l);
  res.json({ data: enrichLoad(req.auth.tenantId, l) });
});

router.post('/loads/:id/transition', requirePermission('loads.update_status'), (req, res) => {
  const l = byId('loads', req.params.id, req.auth.tenantId);
  if (!l) return D.apiError(res, 404, 'NOT_FOUND', 'Load not found.');
  const { to, reason, version } = req.body || {};
  if (version != null && version !== l.version) return D.apiError(res, 409, 'VERSION_CONFLICT', 'Load changed since you opened it.', { retryable: true });
  if (!D.canTransitionLoad(l.status, to)) {
    return D.apiError(res, 409, 'ILLEGAL_TRANSITION', `Cannot move load from ${l.status} to ${to}. Current state: ${l.status}.`);
  }
  const reopening = (l.status === 'canceled' || l.status === 'rejected');
  if (reopening && !reason) return D.apiError(res, 422, 'REASON_REQUIRED', 'Reopening a load requires a reason.');
  const { uid } = require('./store');
  const before = l.status;
  l.status = to; l.version += 1; l.updated_at = new Date().toISOString();
  DB.loadStatusHistory.push({ id: uid('lsh'), tenant_id: l.tenant_id, load_id: l.id, previous_status: before, new_status: to, actor: req.auth.user.id, source: 'manual', timestamp: l.updated_at, reason: reason || null, external_event_id: null });
  audit(req, 'load.transition', 'load', l.id, { status: before }, { status: to }, reason);
  res.json({ data: enrichLoad(req.auth.tenantId, l) });
});

router.get('/loads/:id/eta-history', requirePermission('loads.read'), (req, res) => {
  const rows = latestEta(req.auth.tenantId, req.params.id).map((e) => ({ ...e, timing_label: D.timingLabel(e.schedule_variance_minutes) }));
  res.json(D.envelope(rows));
});

// Import (§10.3) — dry-run preview + commit with idempotency
router.post('/loads/imports/preview', requirePermission('import.run'), (req, res) => {
  const rows = (req.body || {}).rows || [];
  const preview = rows.map((r, i) => {
    const errors = [];
    if (!r.load_number) errors.push('Missing load number');
    if (scoped(req, 'loads').some((l) => l.load_number === r.load_number)) errors.push('Duplicate load number');
    return { row: i + 1, load_number: r.load_number, errors, valid: errors.length === 0 };
  });
  res.json({ data: preview, summary: { total: preview.length, valid: preview.filter((p) => p.valid).length, invalid: preview.filter((p) => !p.valid).length } });
});
router.post('/loads/imports/commit', requirePermission('import.run'), (req, res) => {
  const rows = (req.body || {}).rows || [];
  const { uid } = require('./store');
  let created = 0;
  rows.forEach((r) => {
    if (r.load_number && !scoped(req, 'loads').some((l) => l.load_number === r.load_number)) {
      DB.loads.push({ id: uid('lod'), tenant_id: req.auth.tenantId, company_id: req.auth.companyId, load_number: r.load_number, trip_number: r.trip_number || '', broker_id: null, status: 'upcoming', dispatcher_id: null, driver_id: null, truck_id: null, trailer_id: null, hauling_rate: r.hauling_rate || 0, assigned_rate: r.assigned_rate || 0, currency: 'USD', planned_distance_miles: r.distance || 0, actual_distance_miles: null, pickup_window_start: null, pickup_window_end: null, delivery_window_start: null, delivery_window_end: null, source_timezone: 'America/Chicago', source_system: 'import', external_id: null, version: 1, origin_label: r.origin || '', destination_label: r.destination || '', paperwork_state: 'all_good', pinned: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      created += 1;
    }
  });
  audit(req, 'load.import', 'load', 'batch', null, { created });
  res.json({ data: { created, idempotencyKey: (req.body || {}).idempotencyKey || null }, auditId: `aud_${DB.auditLog.length}` });
});

// ─────────────────────────────────────────────────────────────────────────────
// Assignments (§11.1)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/assignments/preview', requirePermission('drivers.assign'), (req, res) => {
  const { truck_id } = req.body || {};
  const tid = req.auth.tenantId;
  const conflicts = scoped(req, 'assignments').filter((a) => a.truck_id === truck_id && a.state === 'active');
  res.json({ data: { conflicts: conflicts.map((c) => ({ load_id: c.load_id, effective_from: c.effective_from })), canAssign: conflicts.length === 0 } });
});
router.post('/assignments', requirePermission('drivers.assign'), (req, res) => {
  const { load_id, driver_id, truck_id, trailer_id, override_reason } = req.body || {};
  const l = byId('loads', load_id, req.auth.tenantId);
  if (!l) return D.apiError(res, 404, 'NOT_FOUND', 'Load not found.');
  const conflict = scoped(req, 'assignments').find((a) => a.truck_id === truck_id && a.state === 'active' && a.load_id !== load_id);
  if (conflict && !override_reason) {
    return D.apiError(res, 409, 'ASSIGNMENT_CONFLICT', `Truck ${unitOf(req.auth.tenantId, truck_id)} already has an active assignment.`);
  }
  const { uid } = require('./store');
  const a = { id: uid('asg'), tenant_id: req.auth.tenantId, load_id, driver_id, truck_id, trailer_id, dispatcher_id: l.dispatcher_id, effective_from: new Date().toISOString(), effective_to: null, state: 'active', reason: override_reason || '', actor: req.auth.user.id };
  DB.assignments.push(a);
  if (driver_id) l.driver_id = driver_id;
  if (truck_id) l.truck_id = truck_id;
  if (trailer_id) l.trailer_id = trailer_id;
  l.updated_at = new Date().toISOString();
  audit(req, 'assignment.create', 'assignment', a.id, null, a, override_reason);
  res.status(201).json({ data: a, auditId: `aud_${DB.auditLog.length}` });
});
router.delete('/assignments/:id', requirePermission('drivers.assign'), (req, res) => {
  const a = byId('assignments', req.params.id, req.auth.tenantId);
  if (!a) return D.apiError(res, 404, 'NOT_FOUND', 'Assignment not found.');
  const { reason } = req.body || {};
  if (!reason) return D.apiError(res, 422, 'REASON_REQUIRED', 'Ending an assignment requires a reason.');
  const before = { ...a }; a.state = 'ended'; a.effective_to = new Date().toISOString();
  audit(req, 'assignment.end', 'assignment', a.id, before, a, reason);
  res.json({ data: a });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boards & Map (§10.4–10.6)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/update-board', requirePermission('loads.read'), async (req, res) => {
  if (isReal()) return res.json(await realProvider.updateBoard(req.query.segment || 'active', req.query.search));
  const tid = req.auth.tenantId;
  const seg = req.query.segment || 'active';
  let loads = scoped(req, 'loads').filter((l) => ['dispatched', 'in_transit'].includes(l.status));
  const enriched = loads.map((l) => enrichLoad(tid, l));
  let rows = enriched;
  if (seg === 'paperwork') rows = enriched.filter((l) => l.paperwork_state !== 'all_good');
  else if (seg === 'stationary') rows = enriched.filter((l) => l.eld_state && l.eld_state.stationary);
  else if (seg === 'delayed') rows = enriched.filter((l) => l.eta && l.eta.timing_state === 'late');
  else if (seg === 'sleep') rows = enriched.filter((l) => l.eld_state && l.eld_state.sleep_timer_minutes > 0);
  const q = String(req.query.search || '').toLowerCase();
  if (q) rows = rows.filter((l) => (l.truck_unit || '').toLowerCase().includes(q) || (l.driver_name || '').toLowerCase().includes(q) || l.load_number.toLowerCase().includes(q));
  res.json(D.envelope(rows, { total: rows.length, pageSize: rows.length }));
});

router.get('/dispatch-board', requirePermission('loads.read'), async (req, res) => {
  if (isReal()) return res.json(await realProvider.dispatchBoard(req.query.weekStart || null));
  const tid = req.auth.tenantId;
  const drivers = scoped(req, 'drivers').filter((d) => d.status === 'active');
  const groups = {};
  drivers.forEach((d) => {
    const disp = DB.users.find((u) => u.id === d.primary_dispatcher_id);
    const leadId = disp ? disp.leader_user_id : null;
    const key = `${leadId || 'none'}::${d.primary_dispatcher_id}`;
    if (!groups[key]) groups[key] = { team_lead: leadId ? nameOfUser(tid, leadId) : 'Unassigned', dispatcher: nameOfUser(tid, d.primary_dispatcher_id), drivers: [] };
    const driverLoads = scoped(req, 'loads').filter((l) => l.driver_id === d.id).map((l) => enrichLoad(tid, l));
    const hauling = driverLoads.reduce((s, l) => s + l.hauling_rate, 0);
    const assigned = driverLoads.reduce((s, l) => s + l.assigned_rate, 0);
    const dist = driverLoads.reduce((s, l) => s + (l.planned_distance_miles || 0), 0);
    const eld = DB.eldStatus.find((e) => e.tenant_id === tid && e.driver_id === d.id);
    groups[key].drivers.push({
      id: d.id, name: d.display_name, position: d.position, unit: unitOf(tid, d.assigned_truck_id),
      condition: eld ? (eld.connection_state !== 'connected' ? 'ELD Not Connected' : (eld.stationary ? 'Stationary' : 'Healthy')) : 'Unknown',
      loads: driverLoads.map((l) => ({ id: l.id, load_number: l.load_number, route: `${l.origin_label} → ${l.destination_label}`, status: l.status, pickup: l.pickup_window_start, delivery: l.delivery_window_start })),
      stats: { hauling, assigned, rate_savings: D.rateSavings(hauling, assigned), rpm: D.rpm(hauling, dist) },
    });
  });
  const groupList = Object.values(groups);
  const allLoads = scoped(req, 'loads');
  const enrouteCount = allLoads.filter((l) => l.status === 'in_transit').length;
  const totalHauling = allLoads.reduce((s, l) => s + l.hauling_rate, 0);
  const totalAssigned = allLoads.reduce((s, l) => s + l.assigned_rate, 0);
  const totalDist = allLoads.reduce((s, l) => s + (l.planned_distance_miles || 0), 0);
  res.json({
    data: groupList,
    weekStart: req.query.weekStart || '2026-06-29',
    summary: {
      enroute: enrouteCount, total_hauling: totalHauling, total_assigned: totalAssigned,
      total_rate_savings: D.rateSavings(totalHauling, totalAssigned), avg_rpm: D.rpm(totalHauling, totalDist),
    },
    meta: { source: 'primary-db', generatedAt: '2026-07-03T18:00:00Z' },
  });
});

router.get('/dispatch-map', requirePermission('location.read'), async (req, res) => {
  if (isReal()) return res.json(await realProvider.dispatchMap(req.query.condition || 'all'));
  const tid = req.auth.tenantId;
  const condition = req.query.condition || 'all';
  const active = scoped(req, 'loads').filter((l) => ['dispatched', 'in_transit'].includes(l.status)).map((l) => enrichLoad(tid, l));
  const withLoc = active.filter((l) => l.location);
  const noLoc = active.filter((l) => !l.location).map((l) => ({ load_id: l.id, driver_name: l.driver_name, unit: l.truck_unit, reason: 'Location unavailable' }));
  let markers = withLoc.map((l) => ({
    load_id: l.id, driver_name: l.driver_name, unit: l.truck_unit, load_number: l.load_number,
    status: l.status, latitude: l.location.latitude, longitude: l.location.longitude,
    speed_mph: l.location.speed_mph, observed_at: l.location.observed_at, source: l.location.source,
    freshness: l.location.freshness, remaining_miles: l.eta ? l.eta.remaining_miles : null,
    eta_label: l.eta ? l.eta.timing_label : null,
    condition: l.status === 'in_transit' ? (l.location.speed_mph > 5 ? 'loaded' : 'finishing') : 'empty',
  }));
  if (condition !== 'all') markers = markers.filter((m) => m.condition === condition);
  res.json({ data: { markers, noLocation: noLoc }, meta: { source: 'eld-provider', generatedAt: '2026-07-03T18:00:00Z', stale: false } });
});

router.post('/data-refresh', requirePermission('integrations.manage'), (req, res) => {
  audit(req, 'data.sync', 'integration', (req.body || {}).type || 'all', null, null);
  res.json({ data: { lastSuccessfulSyncAt: new Date().toISOString(), scope: (req.body || {}).scope || 'display-only' } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Master data (§10.10–10.15)
// ─────────────────────────────────────────────────────────────────────────────
function crudList(collection, permission, enrich) {
  router.get(`/${collection}`, requirePermission(permission), async (req, res) => {
    if (isReal()) {
      // Real sources per collection; never synthetic.
      if (collection === 'drivers') return res.json(await realProvider.drivers({ search: req.query.search }));
      if (collection === 'brokers') return res.json(await realProvider.brokers({ search: req.query.search }));
      if (collection === 'users') return res.json(await realProvider.usersList());
      if (collection === 'companies') return res.json(realProvider.companiesList());
      return res.json(realProvider.notConnected(`${collection} not yet wired to a real source`));
    }
    const tid = req.auth.tenantId;
    let rows = scoped(req, collection === 'equipments' ? 'equipment' : collection);
    const q = String(req.query.search || '').toLowerCase();
    if (q) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
    const out = enrich ? rows.map((r) => enrich(tid, r)) : rows;
    const { slice, page, pageSize, total } = paginate(out, req);
    res.json(D.envelope(slice, { page, pageSize, total }));
  });
}

crudList('drivers', 'drivers.read', (tid, d) => ({
  ...d, truck_unit: unitOf(tid, d.assigned_truck_id), dispatcher_name: nameOfUser(tid, d.primary_dispatcher_id),
  hired_company_name: (DB.companies.find((c) => c.id === d.hired_company_id) || {}).name,
}));
crudList('brokers', 'brokers.read');
crudList('users', 'users.manage', (tid, u) => ({
  id: u.id, name: u.display_name, email: u.email, phone_e164: u.phone_e164, department: u.department,
  status: u.status, leader_name: nameOfUser(tid, u.leader_user_id),
  roles: u.role_ids.map((rid) => (DB.roles.find((r) => r.id === rid) || {}).name).filter(Boolean),
}));
crudList('companies', 'settings.manage');

// Equipment with truck/trailer tabs
router.get('/equipments', requirePermission('equipment.read'), async (req, res) => {
  if (isReal()) return res.json(await realProvider.equipments({ type: req.query.type || 'truck', search: req.query.search }));
  const tid = req.auth.tenantId;
  const type = req.query.type || 'truck';
  let rows = scoped(req, 'equipment').filter((e) => e.type === type);
  const q = String(req.query.search || '').toLowerCase();
  if (q) rows = rows.filter((e) => String(e.unit_number).toLowerCase().includes(q) || (e.vin || '').toLowerCase().includes(q));
  rows = rows.map((e) => {
    const activeAsg = scoped(req, 'assignments').find((a) => a.truck_id === e.id && a.state === 'active');
    return { ...e, operated_by: (DB.companies.find((c) => c.id === e.operated_by_company_id) || {}).name, conflict: activeAsg && e.status === 'available' };
  });
  const { slice, page, pageSize, total } = paginate(rows, req);
  res.json(D.envelope(slice, { page, pageSize, total }));
});

// Broker duplicate detection + merge
router.get('/brokers/duplicates', requirePermission('brokers.read'), (req, res) => {
  const rows = scoped(req, 'brokers');
  const seen = {}; const dups = [];
  rows.forEach((b) => {
    const key = b.display_name.toLowerCase().replace(/[^a-z]/g, '');
    if (seen[key]) dups.push({ a: seen[key], b: b.id, name: b.display_name });
    else seen[key] = b.id;
  });
  res.json(D.envelope(dups));
});

// Generic create/deactivate for master data (permission-gated)
function makeDeactivate(collection, permission, type) {
  router.post(`/${collection}/:id/deactivate`, requirePermission(permission), (req, res) => {
    const coll = collection === 'equipments' ? 'equipment' : collection;
    const row = byId(coll, req.params.id, req.auth.tenantId);
    if (!row) return D.apiError(res, 404, 'NOT_FOUND', `${type} not found.`);
    // Block deletion when referenced; deactivate instead (§10.11, §10.12).
    const before = { ...row }; row.status = 'inactive';
    audit(req, `${type}.deactivate`, type, row.id, before, row, (req.body || {}).reason);
    res.json({ data: row });
  });
}
makeDeactivate('drivers', 'drivers.manage', 'driver');
makeDeactivate('brokers', 'brokers.manage', 'broker');
makeDeactivate('users', 'users.manage', 'user');

router.post('/brokers', requirePermission('brokers.manage'), (req, res) => {
  const b = req.body || {};
  if (!b.display_name) return D.apiError(res, 400, 'VALIDATION', 'Broker name is required.', { fieldErrors: { display_name: 'Required.' } });
  const { uid } = require('./store');
  const broker = { id: uid('brk'), tenant_id: req.auth.tenantId, legal_name: b.legal_name || b.display_name, display_name: b.display_name, mc_number: b.mc_number || '', email: b.email || '', phone_e164: b.phone_e164 || '', address: b.address || '', status: 'active', canonical_broker_id: null, created_at: new Date().toISOString() };
  DB.brokers.push(broker); audit(req, 'broker.create', 'broker', broker.id, null, broker);
  res.status(201).json({ data: broker });
});

router.post('/companies', requirePermission('settings.manage'), (req, res) => {
  const b = req.body || {};
  const fieldErrors = {};
  if (!b.name) fieldErrors.name = 'Name is required.';
  if (b.phone_e164 && !/^\+[1-9]\d{6,14}$/.test(b.phone_e164)) fieldErrors.phone_e164 = 'Must be E.164 (e.g. +13125551234).';
  if (b.email && !/^[^@]+@[^@]+\.[^@]+$/.test(b.email)) fieldErrors.email = 'Invalid email.';
  if (Object.keys(fieldErrors).length) return D.apiError(res, 400, 'VALIDATION', 'Please correct the highlighted fields.', { fieldErrors });
  const { uid } = require('./store');
  const c = { id: uid('cmp'), tenant_id: req.auth.tenantId, name: b.name, mc_number: b.mc_number || '', phone_e164: b.phone_e164 || '', email: b.email || '', timezone_iana: b.timezone_iana || 'America/Chicago', address_line1: b.address_line1 || '', address_line2: '', city: b.city || '', state: b.state || '', postal_code: b.postal_code || '', country: 'US', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  DB.companies.push(c); audit(req, 'company.create', 'company', c.id, null, c);
  res.status(201).json({ data: c });
});

// ─────────────────────────────────────────────────────────────────────────────
// Email (§10.7)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/email/categories', requirePermission('email.read'), (req, res) => {
  if (isReal()) {
    return res.json({ data: [{ key: 'all', label: 'All Emails', count: 0 }], meta: { connected: false, note: 'Email integration is not connected.' } });
  }
  const threads = scoped(req, 'emailThreads');
  const cats = ['Rate Cons', 'Update Request', 'Critical', 'Charges', 'Claim', 'New Load Offer'];
  res.json({
    data: [{ key: 'all', label: 'All Emails', count: threads.length }]
      .concat(cats.map((c) => ({ key: c, label: c, count: threads.filter((t) => t.category === c).length }))),
  });
});
router.get('/email/threads', requirePermission('email.read'), (req, res) => {
  if (isReal()) return res.json({ ...realProvider.notConnected('Email integration is not connected.'), account: null });
  let rows = scoped(req, 'emailThreads');
  if (req.query.category && req.query.category !== 'all') rows = rows.filter((t) => t.category === req.query.category);
  const q = String(req.query.search || '').toLowerCase();
  if (q) rows = rows.filter((t) => t.subject.toLowerCase().includes(q) || t.sender.toLowerCase().includes(q));
  rows.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
  const account = scoped(req, 'emailAccounts')[0] || null;
  res.json({ ...D.envelope(rows, { total: rows.length, pageSize: rows.length }), account });
});
router.get('/email/threads/:id', requirePermission('email.read'), (req, res) => {
  const thread = byId('emailThreads', req.params.id, req.auth.tenantId);
  if (!thread) return D.apiError(res, 404, 'NOT_FOUND', 'Email not found.');
  if (thread.unread) thread.unread = false;
  const messages = scoped(req, 'emailMessages').filter((m) => m.thread_id === thread.id);
  res.json({ data: { ...thread, messages } });
});
router.get('/email/attachments/:id/download-url', requirePermission('email.download'), (req, res) => {
  // Signed, short-lived URL with tenant check (§4.6). Simulated here.
  res.json({ data: { url: `/api/v1/email/attachments/${req.params.id}/blob?token=short-lived`, expiresInSeconds: 120 } });
});
router.get('/email/attachments/:id/preview-url', requirePermission('email.read'), (req, res) => {
  res.json({ data: { url: `/api/v1/email/attachments/${req.params.id}/preview?token=short-lived`, expiresInSeconds: 120 } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reports (§10.8, §10.9)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reports/rate-savings', requirePermission('reports.read'), (req, res) => {
  if (isReal()) return res.json(realProvider.reportsUnavailable('Rate savings'));
  const tid = req.auth.tenantId;
  const status = req.query.status || 'all';
  let drivers = scoped(req, 'drivers');
  if (status === 'active') drivers = drivers.filter((d) => d.status === 'active');
  else if (status === 'inactive') drivers = drivers.filter((d) => d.status !== 'active');
  const rows = drivers.map((d) => {
    const loads = scoped(req, 'loads').filter((l) => l.driver_id === d.id);
    const savings = loads.reduce((s, l) => s + D.rateSavings(l.hauling_rate, l.assigned_rate), 0);
    return {
      driver_id: d.id, driver_name: d.display_name, status: d.status, position: d.position,
      loads_booked: loads.length, rate_savings: savings, manual_adjustment: 0,
      final_balance: D.finalBalance(savings, 0), savings_label: D.savingsLabel(savings),
    };
  });
  res.json(D.envelope(rows, { total: rows.length, pageSize: rows.length }));
});

router.post('/reports/rate-savings/:driverId/adjust', requirePermission('reports.adjust'), (req, res) => {
  const { amount, reason } = req.body || {};
  if (amount == null) return D.apiError(res, 400, 'VALIDATION', 'Amount is required.', { fieldErrors: { amount: 'Required.' } });
  if (!reason) return D.apiError(res, 422, 'REASON_REQUIRED', 'Manual adjustment requires a reason.');
  audit(req, 'report.adjust', 'driver', req.params.driverId, null, { amount, reason });
  res.json({ data: { driverId: req.params.driverId, amount, reason, auditId: `aud_${DB.auditLog.length}` } });
});

router.get('/reports/cancellations', requirePermission('reports.read'), (req, res) => {
  if (isReal()) return res.json(realProvider.reportsUnavailable('Cancellations'));
  const tid = req.auth.tenantId;
  const canceled = scoped(req, 'loads').filter((l) => l.status === 'canceled').map((l) => enrichLoad(tid, l));
  const dispatchers = new Set(canceled.map((l) => l.dispatcher_id));
  res.json({ data: canceled, summary: { dispatcher_count: dispatchers.size, canceled_load_count: canceled.length } });
});

router.get('/reports/gross-board', requirePermission('reports.read'), (req, res) => {
  if (isReal()) return res.json(realProvider.reportsUnavailable('Gross Board'));
  const tid = req.auth.tenantId;
  const targets = scoped(req, 'reportTargets')[0] || { solo_gross: 1000000, team_gross: 1500000, rpm: 240 };
  const leads = scoped(req, 'users').filter((u) => (u.role_ids || []).some((rid) => (DB.roles.find((r) => r.id === rid) || {}).name === 'Team Lead'));
  const board = leads.map((lead) => {
    const dispatchers = scoped(req, 'users').filter((u) => u.leader_user_id === lead.id && u.department === 'Dispatcher');
    const dispatcherNodes = dispatchers.map((disp) => {
      const drivers = scoped(req, 'drivers').filter((d) => d.primary_dispatcher_id === disp.id);
      const driverNodes = drivers.map((d) => {
        const loads = scoped(req, 'loads').filter((l) => l.driver_id === d.id && l.status === 'delivered');
        const gross = loads.reduce((s, l) => s + l.hauling_rate, 0);
        const dist = loads.reduce((s, l) => s + (l.planned_distance_miles || 0), 0);
        return { driver_id: d.id, name: d.display_name, gross, rpm: D.rpm(gross, dist), loads: loads.length, score: Math.min(100, Math.round(gross / targets.solo_gross * 100)) };
      });
      const gross = driverNodes.reduce((s, n) => s + n.gross, 0);
      return { dispatcher_id: disp.id, name: disp.display_name, gross, drivers: driverNodes };
    });
    const gross = dispatcherNodes.reduce((s, n) => s + n.gross, 0);
    return { team_lead_id: lead.id, name: lead.display_name, gross, dispatchers: dispatcherNodes };
  });
  const totalGross = board.reduce((s, n) => s + n.gross, 0);
  const driverCount = scoped(req, 'drivers').length;
  const dispatcherCount = scoped(req, 'users').filter((u) => u.department === 'Dispatcher').length;
  const loadCount = scoped(req, 'loads').filter((l) => l.status === 'delivered').length;
  res.json({ data: board, summary: { total_gross: totalGross, dispatchers: dispatcherCount, drivers: driverCount, loads: loadCount, avg_score: 72 }, targets });
});

router.get('/reports/targets', requirePermission('reports.read'), (req, res) => {
  if (isReal()) return res.json({ data: null, meta: { note: 'Targets require persisted load history.' } });
  res.json({ data: scoped(req, 'reportTargets')[0] || null });
});
router.put('/reports/targets', requirePermission('reports.adjust'), (req, res) => {
  const t = scoped(req, 'reportTargets')[0];
  if (!t) return D.apiError(res, 404, 'NOT_FOUND', 'Targets not found.');
  const before = { ...t };
  ['solo_gross', 'team_gross', 'rpm'].forEach((k) => { if (req.body[k] != null) t[k] = req.body[k]; });
  audit(req, 'targets.update', 'targets', t.id, before, t);
  res.json({ data: t });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fuel & Tolls (§10.14)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/fuel-prices', requirePermission('loads.read'), (req, res) => {
  if (isReal()) return res.json(realProvider.notConnected('No fuel price source is connected.'));
  let rows = scoped(req, 'fuelPrices');
  if (req.query.state) rows = rows.filter((r) => r.state === req.query.state);
  if (req.query.city) rows = rows.filter((r) => r.city.toLowerCase() === String(req.query.city).toLowerCase());
  res.json(D.envelope(rows, { total: rows.length, pageSize: rows.length }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings (§10.16)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/settings/general', requirePermission('settings.manage'), async (req, res) => {
  if (isReal()) {
    try {
      const row = await require('./realDb').getSettings(req.auth.tenantId);
      const data = row ? { ...realProvider.SETTINGS_DEFAULTS, ...row.data, version: row.version, updated_at: row.updated_at, updated_by: row.updated_by }
        : { ...realProvider.SETTINGS_DEFAULTS, version: 1, updated_at: null, updated_by: null };
      return res.json({ data });
    } catch (e) { return D.apiError(res, 503, 'STORE_UNAVAILABLE', 'Settings store unavailable.', { retryable: true }); }
  }
  const s = scoped(req, 'companySettings').find((x) => x.company_id === req.auth.companyId) || scoped(req, 'companySettings')[0];
  res.json({ data: s });
});
router.put('/settings/general', requirePermission('settings.manage'), async (req, res) => {
  const b = req.body || {};
  const fieldErrors = {};
  if (b.check_in_radius_miles != null && (b.check_in_radius_miles < 0.1 || b.check_in_radius_miles > 5.0)) fieldErrors.check_in_radius_miles = 'Must be between 0.1 and 5.0 miles.';
  if (Object.keys(fieldErrors).length) return D.apiError(res, 400, 'VALIDATION', 'Please correct the highlighted fields.', { fieldErrors });
  if (isReal()) {
    try {
      const realDb = require('./realDb');
      const existing = await realDb.getSettings(req.auth.tenantId);
      const beforeData = existing ? existing.data : { ...realProvider.SETTINGS_DEFAULTS };
      const data = { ...realProvider.SETTINGS_DEFAULTS, ...beforeData };
      ['check_in_radius_miles', 'eld_inspection_expiration_days', 'detention_threshold_minutes', 'auto_create_detention_task', 'stale_location_minutes'].forEach((k) => { if (b[k] !== undefined) data[k] = b[k]; });
      const version = (existing ? existing.version : 0) + 1;
      await realDb.putSettings(req.auth.tenantId, data, version, req.auth.user.id);
      audit(req, 'settings.general.update', 'fleet_settings', req.auth.tenantId, beforeData, data);
      return res.json({ data: { ...data, version, updated_at: new Date().toISOString(), updated_by: req.auth.user.id } });
    } catch (e) { return D.apiError(res, 503, 'STORE_UNAVAILABLE', 'Settings store unavailable.', { retryable: true }); }
  }
  const s = scoped(req, 'companySettings').find((x) => x.company_id === req.auth.companyId) || scoped(req, 'companySettings')[0];
  if (!s) return D.apiError(res, 404, 'NOT_FOUND', 'Settings not found.');
  const before = { ...s };
  ['check_in_radius_miles', 'eld_inspection_expiration_days', 'detention_threshold_minutes', 'auto_create_detention_task'].forEach((k) => { if (b[k] !== undefined) s[k] = b[k]; });
  s.version += 1; s.updated_at = new Date().toISOString(); s.updated_by = req.auth.user.id;
  audit(req, 'settings.general.update', 'company_settings', s.id, before, s);
  res.json({ data: s });
});

router.get('/settings/bot/logs', requirePermission('settings.manage'), (req, res) => {
  if (isReal()) return res.json(realProvider.notConnected('Bot logs live in the main application admin panel.'));
  res.json(D.envelope([
    { id: 'bl1', timestamp: '2026-07-03T17:00:00Z', event_type: 'check_in', actor: 'driver', message: 'Check-in recorded at pickup', status: 'ok', correlation_id: 'cid_abc' },
    { id: 'bl2', timestamp: '2026-07-03T16:30:00Z', event_type: 'paperwork', actor: 'bot', message: 'BOL analyzed — 2 pages', status: 'ok', correlation_id: 'cid_def' },
    { id: 'bl3', timestamp: '2026-07-03T15:10:00Z', event_type: 'notification', actor: 'system', message: 'ETA update sent to driver group', status: 'ok', correlation_id: 'cid_ghi' },
  ]));
});
router.get('/settings/bot/permissions', requirePermission('settings.manage'), (req, res) => {
  if (isReal()) return res.json({ data: [], meta: { connected: false, note: 'Bot permissions are managed by the main application.' } });
  res.json({ data: [
    { key: 'ticket_create', label: 'Ticket create', enabled: true },
    { key: 'task_paraphrase', label: 'Task paraphrase', enabled: true },
    { key: 'bol_pod_analysis', label: 'BOL/POD paperwork analysis', enabled: true },
    { key: 'check_in_out', label: 'Check-in/Check-out', enabled: true },
    { key: 'sleep_time', label: 'Sleep time', enabled: false, restriction: 'plan' },
    { key: 'photo_pdf', label: 'Photo PDF', enabled: true },
  ] });
});
router.get('/settings/integrations', requirePermission('integrations.manage'), async (req, res) => {
  if (isReal()) return res.json(await realProvider.integrationsStatus());
  res.json(D.envelope(scoped(req, 'integrations')));
});
router.post('/settings/integrations/:type/health-check', requirePermission('integrations.manage'), (req, res) => {
  const intg = scoped(req, 'integrations').find((i) => i.type === req.params.type);
  if (!intg) return D.apiError(res, 404, 'NOT_FOUND', 'Integration not found.');
  intg.last_health_check_at = new Date().toISOString();
  res.json({ data: intg });
});
router.post('/settings/integrations/:type/disconnect', requirePermission('integrations.manage'), (req, res) => {
  const intg = scoped(req, 'integrations').find((i) => i.type === req.params.type);
  if (!intg) return D.apiError(res, 404, 'NOT_FOUND', 'Integration not found.');
  const before = { ...intg }; intg.state = 'disconnected'; intg.error_message = 'Disconnected by admin';
  audit(req, 'integration.disconnect', 'integration', intg.id, before, intg);
  res.json({ data: intg });
});
router.get('/settings/roles', requirePermission('roles.manage'), (req, res) => {
  if (isReal()) {
    const { PERMISSIONS } = require('./store');
    return res.json(D.envelope([{ id: 'role_admin', name: 'Administrator', description: 'Federated from the main application admin login', permissions: PERMISSIONS, permission_count: PERMISSIONS.length, system: true }]));
  }
  res.json(D.envelope(scoped(req, 'roles').map((r) => ({ ...r, permission_count: r.permissions.length }))));
});
router.get('/settings/labels', requirePermission('settings.manage'), (req, res) => {
  if (isReal()) {
    // Default label config (not synthetic data) until label management persists.
    return res.json(D.envelope([
      { id: 'lbl_detention', name: 'Detention', color: '#d4380d', active: true },
      { id: 'lbl_paperwork', name: 'Paperwork', color: '#d48806', active: true },
      { id: 'lbl_urgent', name: 'Urgent', color: '#cf1322', active: true },
      { id: 'lbl_followup', name: 'Follow-up', color: '#1677ff', active: true },
    ]));
  }
  res.json(D.envelope(scoped(req, 'taskLabels')));
});
router.get('/settings/notification-rules', requirePermission('settings.manage'), (req, res) => {
  if (isReal()) return res.json({ ...realProvider.notConnected('Outbound notifications are disabled until sending is explicitly approved.'), data: [] });
  res.json(D.envelope(scoped(req, 'notificationRules')));
});
router.put('/settings/notification-rules/:id', requirePermission('settings.manage'), (req, res) => {
  const r = byId('notificationRules', req.params.id, req.auth.tenantId);
  if (!r) return D.apiError(res, 404, 'NOT_FOUND', 'Rule not found.');
  const before = { ...r };
  if (req.body.enabled !== undefined) r.enabled = req.body.enabled;
  r.version += 1;
  audit(req, 'notification_rule.update', 'notification_rule', r.id, before, r);
  res.json({ data: r });
});
router.get('/settings/permissions-catalog', requirePermission('roles.manage'), (req, res) => {
  const { PERMISSIONS } = require('./store');
  res.json({ data: PERMISSIONS });
});

// ── Sync layer (admin-only, read-first: refreshes read caches, mutates nothing
//    external, records a fleet_sync_runs row) ──
router.post('/sync/:source', requirePermission('integrations.manage'), async (req, res) => {
  if (!isReal()) return D.apiError(res, 400, 'DEMO_MODE', 'Sync is available in real mode only.');
  const source = String(req.params.source || '');
  if (!['locations', 'drivers'].includes(source)) return D.apiError(res, 400, 'VALIDATION', 'Unknown sync source. Use locations or drivers.');
  try {
    const result = await realProvider.runSync(req.auth.tenantId, source, req.auth.user.id);
    audit(req, 'sync.run', 'sync', result.runId, null, result);
    return res.json({ data: result });
  } catch (e) {
    return D.apiError(res, 503, 'SYNC_FAILED', 'Sync could not be started.', { retryable: true });
  }
});
router.get('/sync/runs', requirePermission('integrations.manage'), async (req, res) => {
  if (!isReal()) return res.json(D.envelope([]));
  try {
    const rows = await require('./realDb').listSyncRuns(req.auth.tenantId);
    return res.json(D.envelope(rows));
  } catch (e) { return D.apiError(res, 503, 'STORE_UNAVAILABLE', 'Sync history unavailable.', { retryable: true }); }
});

// ── Audit viewer (§21) ──
router.get('/audit', requirePermission('audit.read'), async (req, res) => {
  if (isReal()) {
    try {
      const { rows } = await require('./realDb').query(
        'SELECT * FROM fleet_audit_log WHERE tenant_id = $1 ORDER BY timestamp DESC LIMIT 200',
        [req.auth.tenantId],
      );
      return res.json(D.envelope(rows, { total: rows.length, pageSize: 200 }));
    } catch (e) { return D.apiError(res, 503, 'STORE_UNAVAILABLE', 'Audit store unavailable.', { retryable: true }); }
  }
  let rows = scoped(req, 'auditLog').sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (req.query.action) rows = rows.filter((r) => r.action.includes(req.query.action));
  res.json(D.envelope(rows.slice(0, 200), { total: rows.length, pageSize: 200 }));
});

// ── Contact support (§10.17) — recorded internally; nothing is sent externally.
router.post('/support/tickets', (req, res) => {
  const { subject, description, category } = req.body || {};
  if (!subject || !description) return D.apiError(res, 400, 'VALIDATION', 'Subject and description are required.');
  const id = `SUP-${Math.floor(Math.random() * 90000) + 10000}`;
  if (isReal()) {
    audit(req, 'support.ticket', 'support', id, null, { subject, category });
    return res.status(201).json({ data: { ticketNumber: id, category, destination: 'Recorded internally (audit log) — no external delivery is configured.' } });
  }
  res.status(201).json({ data: { ticketNumber: id, category, destination: 'FleetView Support (internal demo)' } });
});

// 404 for unknown API routes (tenant-safe)
router.use((req, res) => D.apiError(res, 404, 'NOT_FOUND', 'Resource not found.'));

module.exports = router;
