/**
 * /api/operations — the gate between looking and changing.
 *
 * The point of these tests is the permission split. Until migration 0018,
 * `admin.full_access` was the only gate in the application, so anyone who could
 * open a page could do anything on it. Reading a finding — "these two facts of
 * ours disagree, here is the evidence" — is ordinary administration. APPLYING
 * one closes a driver's home-time cycle or flips their status. The tests below
 * pin that an admin holding only the blanket permission can read the whole page
 * and change nothing.
 *
 * The rest is about answering the right way when the answer is "no": a
 * dismissal without a reason, a finding nothing is registered to act on, and a
 * proposal whose evidence moved are three different refusals, and collapsing
 * them into one 500 is how an operator learns to stop reading error messages.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { purgeModulePackage } = require('./helpers/purgeDataLayer');

const OPEN_FINDING = {
  id: 11,
  checkKey: 'home_time.closable_open_cycle',
  subjectType: 'road_history',
  subjectId: '7',
  title: 'Cycle #7 can be closed from recorded evidence',
  severity: 'info',
  tier: 'auto',
  status: 'open',
  proposedChange: {
    id: 7,
    returnToRoadAt: { from: null, to: '2026-08-31T00:00:00Z' },
    homeDays: { from: null, to: 6 },
  },
};

/** A finding the registry has no action for — the default for most checks. */
const REPORTED_ONLY = {
  ...OPEN_FINDING, id: 12, checkKey: 'home_time.road_clock_past_allowance', tier: 'warning',
};

function loadApp({
  findings = [OPEN_FINDING], applyPermission = true, applyImpl, dismissImpl,
} = {}) {
  const routePath = path.resolve(__dirname, '../server/routes/operationsRoutes.js');
  const routeDir = path.resolve(__dirname, '../server/routes/operations');
  const applyPath = path.resolve(__dirname, '../services/operations/corrections/apply.js');
  const autoApplyPath = path.resolve(__dirname, '../services/operations/corrections/autoApply.js');
  const sweepPath = path.resolve(__dirname, '../services/operations/consistencyService.js');

  purgeModulePackage(routePath, routeDir, [applyPath, autoApplyPath, sweepPath]);

  const calls = { applied: [], dismissed: [], snoozed: [], settings: [] };

  require.cache[path.resolve(__dirname, '../database/operationalFindings.js')] = {
    exports: {
      async summariseFindings() { return { info: 1, warning: 0, serious: 0, total: 1 }; },
      async listFindings() { return findings; },
      async getFindingById(id) { return findings.find((f) => f.id === Number(id)) || null; },
      async dismissFinding(id, opts) {
        calls.dismissed.push({ id, ...opts });
        if (dismissImpl) return dismissImpl(id, opts);
        return { ...findings[0], status: 'dismissed', dismissReason: opts.reason };
      },
      async snoozeFinding(id, until) { calls.snoozed.push({ id, until }); return { ...findings[0] }; },
    },
  };
  require.cache[path.resolve(__dirname, '../database/operationalCorrections.js')] = {
    exports: {
      mapCorrection: (row) => row,
      async listCorrections() { return []; },
      async getCorrectionById() { return null; },
      async summariseCorrections() {
        return { total: 0, live: 0, reverted: 0, bySystem: 0, byAdmin: 0 };
      },
      async listAuditForSubject() { return []; },
    },
  };
  require.cache[path.resolve(__dirname, '../database/operationalCheckSettings.js')] = {
    exports: {
      async listCheckSettings() { return []; },
      async upsertCheckSettings(checkKey, patch) {
        calls.settings.push({ checkKey, ...patch });
        return { checkKey, ...patch };
      },
    },
  };
  require.cache[sweepPath] = {
    exports: {
      async runConsistencySweep() { return { filed: 3, resolved: 1 }; },
      getConsistencyStatus() { return { running: true, lastRun: null }; },
    },
  };
  require.cache[applyPath] = {
    exports: {
      async applyCorrection(args) {
        calls.applied.push(args);
        if (applyImpl) return applyImpl(args);
        return { id: 99, action_key: args.actionKey };
      },
      async revertCorrection(args) { return { id: args.correctionId }; },
    },
  };

  // `payloadFor` is pure and is exactly what the apply route is being tested to
  // use, so it stays REAL. Only `runAutoCorrections` is replaced — it is the one
  // function here that reaches for the module-level pool.
  const realAutoApply = require(autoApplyPath);
  require.cache[autoApplyPath] = {
    exports: {
      ...realAutoApply,
      async runAutoCorrections() {
        return { summary: { open: 1, eligible: 0, dryRun: true }, plan: [], capped: [] };
      },
    },
  };

  const { createOperationsRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  const read = (req, _res, next) => {
    req.admin = { id: 1, username: 'admin', role_keys: ['super_admin'], permissions: ['admin.full_access'] };
    next();
  };
  const applyGate = (req, res, next) => (applyPermission
    ? next()
    : res.status(403).json({ error: 'Missing permission: operations.corrections.apply' }));
  app.use('/api/operations', createOperationsRouter({
    authMiddleware: read, applyMiddleware: [read, applyGate],
  }));
  return { app, calls };
}

async function call(app, method, url, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

// ─── the permission split ────────────────────────────────────────────────────

test('an admin without the apply permission can read the whole page', async () => {
  const { app } = loadApp({ applyPermission: false });

  for (const url of ['/api/operations/summary', '/api/operations/findings',
    '/api/operations/findings/11', '/api/operations/corrections',
    '/api/operations/checks', '/api/operations/auto-apply/preview']) {
    const res = await call(app, 'GET', url);
    assert.equal(res.status, 200, `${url} must stay readable`);
  }
});

test('...and cannot change a single fleet record', async () => {
  const { app, calls } = loadApp({ applyPermission: false });

  const applied = await call(app, 'POST', '/api/operations/findings/11/apply', {});
  assert.equal(applied.status, 403);
  const reverted = await call(app, 'POST', '/api/operations/corrections/99/revert', {});
  assert.equal(reverted.status, 403);
  const granted = await call(app, 'PUT', '/api/operations/checks/home_time.closable_open_cycle',
    { autoApplyEnabled: true });
  assert.equal(granted.status, 403, 'granting auto-apply is itself a change to what software may do');

  assert.deepEqual(calls.applied, [], 'nothing reached the correction layer');
  assert.deepEqual(calls.settings, []);
});

test('with the permission, applying names the actor for the audit mirror', async () => {
  const { app, calls } = loadApp();

  const res = await call(app, 'POST', '/api/operations/findings/11/apply', { reason: 'Verified by hand.' });

  assert.equal(res.status, 200);
  assert.equal(calls.applied.length, 1);
  assert.equal(calls.applied[0].actionKey, 'home_time.close_cycle');
  assert.deepEqual(calls.applied[0].payload,
    { cycleId: 7, returnToRoadAt: '2026-08-31T00:00:00Z', homeDays: 6 });
  assert.equal(calls.applied[0].admin.username, 'admin');
  assert.deepEqual(calls.applied[0].admin.roleKeys, ['super_admin']);
  assert.equal(calls.applied[0].reason, 'Verified by hand.');
});

// ─── saying "no" in the right way ────────────────────────────────────────────

test('a dismissal without a reason is refused before it reaches the database', async () => {
  const { app, calls } = loadApp();

  const res = await call(app, 'POST', '/api/operations/findings/11/dismiss', { reason: '   ' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /needs a reason/);
  assert.deepEqual(calls.dismissed, [],
    'the schema would refuse it too, but a constraint violation is not a sentence anyone can read');
});

test('a finding nothing is registered to act on is a 400, not a failure', async () => {
  const { app } = loadApp({ findings: [REPORTED_ONLY] });

  const res = await call(app, 'POST', '/api/operations/findings/12/apply', {});

  assert.equal(res.status, 400);
  assert.match(res.body.error, /reported only/);
});

test('evidence that moved answers 409, because nothing went wrong', async () => {
  const { app } = loadApp({
    applyImpl: () => {
      const err = new Error('Cycle 7: the recorded return moment has moved since this was proposed.');
      err.stale = true;
      throw err;
    },
  });

  const res = await call(app, 'POST', '/api/operations/findings/11/apply', {});

  assert.equal(res.status, 409, 'a stand-down is a conflict, not a server fault');
  assert.equal(res.body.stale, true);
  assert.match(res.body.error, /has moved/);
});

test('a finding that is no longer open cannot be applied twice', async () => {
  const { app } = loadApp({ findings: [{ ...OPEN_FINDING, status: 'applied' }] });

  const res = await call(app, 'POST', '/api/operations/findings/11/apply', {});

  assert.equal(res.status, 409);
  assert.match(res.body.error, /already applied/);
});

test('an unknown check key cannot be granted auto-apply', async () => {
  const { app, calls } = loadApp();

  const res = await call(app, 'PUT', '/api/operations/checks/not.a.real.check', { autoApplyEnabled: true });

  assert.equal(res.status, 400);
  assert.deepEqual(calls.settings, []);
});

test('a snooze is bounded, so an alert cannot be silenced forever', async () => {
  const { app, calls } = loadApp();

  assert.equal((await call(app, 'POST', '/api/operations/findings/11/snooze', { hours: 99999 })).status, 400);
  assert.equal((await call(app, 'POST', '/api/operations/findings/11/snooze', { hours: 0 })).status, 400);
  assert.deepEqual(calls.snoozed, []);

  assert.equal((await call(app, 'POST', '/api/operations/findings/11/snooze', { hours: 24 })).status, 200);
  assert.equal(calls.snoozed.length, 1);
});

// ─── the page has to explain a quiet day ─────────────────────────────────────

test('the summary carries sweep state, so "nothing found" is distinguishable', async () => {
  const { app } = loadApp();

  const res = await call(app, 'GET', '/api/operations/summary');

  assert.equal(res.status, 200);
  assert.equal(res.body.findings.total, 1);
  assert.equal(res.body.sweep.running, true,
    'an empty page and a stopped sweep look identical and mean opposite things');
  assert.deepEqual(res.body.corrections, { total: 0, live: 0, reverted: 0, bySystem: 0, byAdmin: 0 });
});

test('the list marks which findings can actually be acted on', async () => {
  const { app } = loadApp({ findings: [OPEN_FINDING, REPORTED_ONLY] });

  const res = await call(app, 'GET', '/api/operations/findings');

  assert.equal(res.body.findings[0].actionable, true);
  assert.equal(res.body.findings[1].actionable, false,
    'the UI must not offer a button that can only ever return 400');
});

test('the preview is a dry run and says so', async () => {
  const { app } = loadApp();

  const res = await call(app, 'GET', '/api/operations/auto-apply/preview');

  assert.equal(res.status, 200);
  assert.equal(res.body.summary.dryRun, true,
    'deciding whether to grant a check must not require already holding the grant');
});

test('a sweep can be run on demand without waiting a quarter of an hour', async () => {
  const { app } = loadApp();

  const res = await call(app, 'POST', '/api/operations/sweep');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sweep, { filed: 3, resolved: 1 });
});

test('every check the registry can act on is listed, enabled or not', async () => {
  const { app } = loadApp();

  const res = await call(app, 'GET', '/api/operations/checks');

  assert.ok(res.body.checks.length >= 2);
  for (const check of res.body.checks) {
    assert.equal(check.autoApplyEnabled, false, 'default deny');
    assert.equal(check.configured, false, 'a check with no row has never been decided on');
    assert.ok(check.actionKey, 'only actionable checks appear here');
  }
});
