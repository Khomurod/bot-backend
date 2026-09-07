'use strict';

/**
 * server/middleware/auth.js — the gate in front of the whole admin API.
 *
 * These are the auth-hardening invariants from APP_BRIEF.md §5/§9: the account,
 * its roles and its permissions are reloaded from PostgreSQL on EVERY request
 * (so a disabled account or a revoked role takes effect immediately), an
 * `auth_version` bump invalidates an outstanding token, the signature algorithm
 * is pinned to HS256 so an `alg:none` or asymmetric forgery cannot impersonate
 * an admin, and requirePermission/requireAllPermissions mean any/all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const {
  createAuthMiddleware,
  requirePermission,
  requireAllPermissions,
} = require('../server/middleware/auth');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(middleware, req) {
  const res = response();
  let next = false;
  await middleware(req, res, () => { next = true; });
  return { res, next };
}

test('auth reloads active roles and permissions on every request', async () => {
  let permissions = ['admin.full_access'];
  const db = {
    getAdminAuthorization: async () => ({
      id: 1,
      username: 'operator',
      active: true,
      auth_version: 3,
      role_keys: ['super_admin'],
      permissions,
    }),
  };
  const token = jwt.sign({ id: 1, username: 'operator', auth_version: 3 }, 'secret', { algorithm: 'HS256' });
  const middleware = createAuthMiddleware({ jwtSecret: 'secret' }, db);

  const first = await invoke(middleware, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(first.next, true);
  assert.deepEqual(first.res.body, null);

  // Same token, permission revoked in the database between requests.
  permissions = [];
  const req = { headers: { authorization: `Bearer ${token}` } };
  const authenticated = await invoke(middleware, req);
  assert.equal(authenticated.next, true);

  const denied = await invoke(requirePermission('admin.full_access'), req);
  assert.equal(denied.next, false);
  assert.equal(denied.res.statusCode, 403);
});

test('disabled accounts and stale auth versions are rejected immediately', async () => {
  const token = jwt.sign({ id: 1, username: 'operator', auth_version: 1 }, 'secret', { algorithm: 'HS256' });
  let account = { id: 1, active: false, auth_version: 1, permissions: [] };
  const middleware = createAuthMiddleware(
    { jwtSecret: 'secret' },
    { getAdminAuthorization: async () => account },
  );

  assert.equal(
    (await invoke(middleware, { headers: { authorization: `Bearer ${token}` } })).res.statusCode,
    401,
    'a deactivated account cannot use an already-issued token',
  );

  account = { ...account, active: true, auth_version: 2 };
  assert.equal(
    (await invoke(middleware, { headers: { authorization: `Bearer ${token}` } })).res.statusCode,
    401,
    'an auth_version bump invalidates the outstanding token',
  );
});

test('the signature algorithm is pinned to HS256', async () => {
  const db = {
    getAdminAuthorization: async () => ({
      id: 1, username: 'operator', active: true, auth_version: 1, role_keys: [], permissions: [],
    }),
  };
  const middleware = createAuthMiddleware({ jwtSecret: 'secret' }, db);

  // alg:none — a hand-built unsigned token with an empty signature segment.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ id: 1, username: 'operator', auth_version: 1 })).toString('base64url');
  const unsigned = `${header}.${payload}.`;
  assert.equal(
    (await invoke(middleware, { headers: { authorization: `Bearer ${unsigned}` } })).res.statusCode,
    401,
    'an unsigned alg:none token must never authenticate',
  );

  // A token signed with a different secret must fail the same way.
  const wrongSecret = jwt.sign({ id: 1, username: 'operator', auth_version: 1 }, 'not-the-secret', { algorithm: 'HS256' });
  assert.equal(
    (await invoke(middleware, { headers: { authorization: `Bearer ${wrongSecret}` } })).res.statusCode,
    401,
  );
});

test('permission helpers implement any and all semantics', async () => {
  const req = { admin: { permissions: ['a', 'b'] } };
  assert.equal((await invoke(requirePermission('x', 'a'), req)).next, true, 'any-of matches on the second key');
  assert.equal((await invoke(requireAllPermissions('a', 'b'), req)).next, true);
  assert.equal((await invoke(requireAllPermissions('a', 'c'), req)).res.statusCode, 403);
});
