/**
 * SOS test-data cleanup — the AUTHORIZATION contract the /answers/test cleanup
 * control depends on.
 *
 * The /answers/test page may find a token in the browser that is valid but not
 * a full admin (a Trailer-department account) or one that has expired. This
 * suite pins what the server answers in each of those cases, because the page's
 * fallback-to-login behaviour is driven by the exact status code:
 *
 *   no token / expired / invalid  → 401
 *   valid but missing full access → 403
 *   full admin                    → 200, and ONLY is_test rows are cleared
 *
 * It also proves the real submissions are unreachable from this endpoint: a
 * clear-test call can never invoke the real clear, whatever the caller sends.
 *
 * Mounted exactly like server/api.js does it: authMiddleware, then
 * requirePermission('admin.full_access'), then the SOS admin router. The service
 * layer is stubbed; no secret and no database are involved (the JWT secret here
 * is a throwaway string generated for this file).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

const { createAuthMiddleware, requirePermission } = require('../server/middleware/auth');

const SERVICE_PATH = path.resolve(__dirname, '../services/sosAssessment/index.js');
const ROUTES_PATH = path.resolve(__dirname, '../server/routes/sosRoutes.js');
const TEST_JWT_SECRET = 'unit-test-only-secret-not-a-real-credential';

const ACCOUNTS = {
  full: { id: 1, username: 'full-admin', active: true, auth_version: 1, role_keys: ['super_admin'], permissions: ['admin.full_access'] },
  trailerOnly: { id: 2, username: 'trailer-manager', active: true, auth_version: 1, role_keys: ['trailer_manager'], permissions: ['trailer_users.manage', 'trailers.view'] },
  deactivated: { id: 3, username: 'former-admin', active: false, auth_version: 1, role_keys: ['super_admin'], permissions: ['admin.full_access'] },
};

function tokenFor(account, { secret = TEST_JWT_SECRET, expiresIn = '10m' } = {}) {
  return jwt.sign(
    { id: account.id, username: account.username, auth_version: account.auth_version },
    secret,
    { algorithm: 'HS256', expiresIn },
  );
}

/** Loads the SOS routers with the service replaced by a call-recording stub. */
function loadAdminRouter(calls) {
  delete require.cache[ROUTES_PATH];
  delete require.cache[SERVICE_PATH];
  require.cache[SERVICE_PATH] = {
    id: SERVICE_PATH,
    filename: SERVICE_PATH,
    loaded: true,
    exports: {
      clearSubmissions: async (isTest) => {
        calls.push({ name: 'clearSubmissions', isTest });
        return isTest ? 5 : 999; // a real clear would be unmistakable
      },
    },
  };
  const { adminRouter } = require(ROUTES_PATH);
  delete require.cache[ROUTES_PATH];
  delete require.cache[SERVICE_PATH];
  return adminRouter;
}

async function withServer(fn) {
  const calls = [];
  const db = {
    getAdminAuthorization: async (id) => Object.values(ACCOUNTS).find((a) => a.id === id) || null,
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/sos/admin',
    [createAuthMiddleware({ jwtSecret: TEST_JWT_SECRET }, db), requirePermission('admin.full_access')],
    loadAdminRouter(calls),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** POSTs the clear-test request the /answers/test control sends. */
async function clearTest(base, token, body = { confirm: 'DELETE TEST DATA' }) {
  const res = await fetch(`${base}/api/sos/admin/clear-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, body: json };
}

test('no stored token → 401, so the page can offer a login', async () => {
  await withServer(async ({ base, calls }) => {
    const res = await clearTest(base, null);
    assert.equal(res.status, 401);
    assert.deepEqual(calls, []);
  });
});

test('an expired token → 401', async () => {
  await withServer(async ({ base, calls }) => {
    const expired = tokenFor(ACCOUNTS.full, { expiresIn: '-1m' });
    const res = await clearTest(base, expired);
    assert.equal(res.status, 401);
    assert.deepEqual(calls, []);
  });
});

test('a token signed with another secret → 401', async () => {
  await withServer(async ({ base, calls }) => {
    const forged = tokenFor(ACCOUNTS.full, { secret: 'a-different-secret' });
    const res = await clearTest(base, forged);
    assert.equal(res.status, 401);
    assert.deepEqual(calls, []);
  });
});

test('garbage in the Authorization header → 401', async () => {
  await withServer(async ({ base, calls }) => {
    assert.equal((await clearTest(base, 'not-a-jwt')).status, 401);
    assert.deepEqual(calls, []);
  });
});

test('a VALID but limited admin (Trailer-only) → 403, never a silent success', async () => {
  await withServer(async ({ base, calls }) => {
    const res = await clearTest(base, tokenFor(ACCOUNTS.trailerOnly));
    assert.equal(res.status, 403);
    assert.match(res.body.error, /admin\.full_access/);
    assert.deepEqual(calls, []); // nothing was deleted
  });
});

test('a full-admin token clears the TEST submissions only', async () => {
  await withServer(async ({ base, calls }) => {
    const res = await clearTest(base, tokenFor(ACCOUNTS.full));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { deleted: 5, mode: 'test' });
    assert.deepEqual(calls, [{ name: 'clearSubmissions', isTest: true }]);
  });
});

test('a deactivated full admin is rejected even with a well-formed token', async () => {
  await withServer(async ({ base, calls }) => {
    const res = await clearTest(base, tokenFor(ACCOUNTS.deactivated));
    assert.equal(res.status, 401);
    assert.deepEqual(calls, []);
  });
});

test('a token for an account that no longer exists → 401', async () => {
  await withServer(async ({ base, calls }) => {
    const token = jwt.sign({ id: 404, username: 'gone', auth_version: 1 }, TEST_JWT_SECRET, { algorithm: 'HS256' });
    assert.equal((await clearTest(base, token)).status, 401);
    assert.deepEqual(calls, []);
  });
});

test('real submissions are unreachable: the wrong phrase is a 400 and clears nothing', async () => {
  await withServer(async ({ base, calls }) => {
    const token = tokenFor(ACCOUNTS.full);
    assert.equal((await clearTest(base, token, {})).status, 400);
    assert.equal((await clearTest(base, token, { confirm: 'DELETE ALL REAL SUBMISSIONS' })).status, 400);
    assert.deepEqual(calls, []);
  });
});

test('the clear-test endpoint can never trigger the real clear', async () => {
  await withServer(async ({ base, calls }) => {
    const token = tokenFor(ACCOUNTS.full);
    await clearTest(base, token);
    await clearTest(base, token, { confirm: 'DELETE TEST DATA', mode: 'real', isTest: false });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.isTest === true), 'clearSubmissions must always be called with isTest=true');
  });
});
