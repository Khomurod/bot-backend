/**
 * /api/operations/identity — the person layer's admin surface, and its gate.
 *
 * Reading who a driver is, and previewing what the backfill would do, is
 * ordinary administration. APPLYING the backfill writes fleet records for every
 * active group, so it sits on `operations.corrections.apply` — the same
 * permission as applying a correction — and an admin holding only the blanket
 * permission must get a 403 and cause no write.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { purgeModulePackage } = require('./helpers/purgeDataLayer');

const PERSON = {
  id: 7, displayName: 'RUSLAN ABDULLAEV', mergedFrom: [],
  groups: [{ id: 1, groupId: 49, groupName: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', groupActive: false, endedAt: '2026-09-01T00:00:00Z' }],
  units: [{ id: 1, unitNumber: '27', endedAt: null }],
};

function loadApp({ applyPermission = true } = {}) {
  const routePath = path.resolve(__dirname, '../server/routes/operationsRoutes.js');
  const routeDir = path.resolve(__dirname, '../server/routes/operations');
  const resolverPath = path.resolve(__dirname, '../services/identity/personResolver.js');
  const peoplePath = path.resolve(__dirname, '../database/driverPeople.js');
  purgeModulePackage(routePath, routeDir, [resolverPath, peoplePath]);

  const calls = { backfills: [] };
  require.cache[peoplePath] = {
    exports: {
      async getPersonIdentity(id) { return Number(id) === PERSON.id ? PERSON : null; },
      async summariseIdentityCoverage() { return { people: 1, activeDriverGroups: 2, groupsWithoutPerson: 1 }; },
    },
  };
  require.cache[resolverPath] = {
    exports: {
      async runIdentityBackfill(options) {
        calls.backfills.push(options);
        return {
          dryRun: !options.apply,
          plan: { stats: { groups: 2, people: 2 } },
          applied: options.apply ? { peopleCreated: 1 } : null,
          stamped: options.apply ? { home_time_requests: 3 } : null,
          coverage: { groupsWithoutPerson: options.apply ? 0 : 1 },
        };
      },
    },
  };
  // The sibling routers load real stores; stub what they touch at require time.
  for (const rel of ['operationalFindings', 'operationalCorrections', 'operationalCheckSettings']) {
    require.cache[path.resolve(__dirname, `../database/${rel}.js`)] = { exports: {} };
  }
  for (const rel of ['services/operations/corrections/apply', 'services/operations/corrections/autoApply',
    'services/operations/corrections/actions', 'services/operations/consistencyService']) {
    const p = path.resolve(__dirname, `../${rel}.js`);
    const real = require(p);
    require.cache[p] = { exports: { ...real } };
  }

  const { createOperationsRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  const read = (req, _res, next) => { req.admin = { id: 1, username: 'admin', role_keys: ['super_admin'] }; next(); };
  const applyGate = (req, res, next) => (applyPermission
    ? next() : res.status(403).json({ error: 'Missing permission: operations.corrections.apply' }));
  app.use('/api/operations', createOperationsRouter({ authMiddleware: read, applyMiddleware: [read, applyGate] }));
  return { app, calls };
}

async function call(app, method, url) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('coverage and one person are readable with the blanket permission', async () => {
  const { app } = loadApp({ applyPermission: false });
  const coverage = await call(app, 'GET', '/api/operations/identity/coverage');
  assert.equal(coverage.status, 200);
  assert.equal(coverage.body.coverage.groupsWithoutPerson, 1);

  const person = await call(app, 'GET', '/api/operations/identity/people/7');
  assert.equal(person.status, 200);
  assert.equal(person.body.person.displayName, 'RUSLAN ABDULLAEV');
  assert.equal(person.body.person.units[0].unitNumber, '27');

  assert.equal((await call(app, 'GET', '/api/operations/identity/people/8')).status, 404);
  assert.equal((await call(app, 'GET', '/api/operations/identity/people/abc')).status, 400);
});

test('the preview writes nothing and is readable; applying needs the apply grant', async () => {
  const { app, calls } = loadApp({ applyPermission: false });
  const preview = await call(app, 'GET', '/api/operations/identity/backfill/preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.dryRun, true);
  assert.deepEqual(calls.backfills, [{ apply: false }]);

  const refused = await call(app, 'POST', '/api/operations/identity/backfill');
  assert.equal(refused.status, 403, 'the blanket permission does not apply a backfill');
  assert.equal(calls.backfills.length, 1, 'and nothing ran');
});

test('with the grant, applying runs the backfill for real and reports what it stamped', async () => {
  const { app, calls } = loadApp({ applyPermission: true });
  const res = await call(app, 'POST', '/api/operations/identity/backfill');
  assert.equal(res.status, 200);
  assert.deepEqual(calls.backfills, [{ apply: true }]);
  assert.equal(res.body.applied.peopleCreated, 1);
  assert.equal(res.body.stamped.home_time_requests, 3);
  assert.equal(res.body.coverage.groupsWithoutPerson, 0);
});
