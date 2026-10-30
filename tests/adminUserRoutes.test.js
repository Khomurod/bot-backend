/**
 * Settings → Admin Accounts reads the server's refusal as it is sent: a taken
 * username comes back as 409 with its words AND its code (USERNAME_TAKEN), on
 * create and on rename; an error the server did not raise on purpose gets the
 * generic line, so a database error's own text never reaches the page.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createAdminUserRoutes } = require('../server/routes/adminUserRoutes');

const taken = () => Object.assign(new Error('That username is already taken.'), { status: 409, code: 'USERNAME_TAKEN' });
const USERS = [
  { id: 1, username: 'owner', active: true, role_keys: ['super_admin'], roles: [{ id: 9, system_key: 'super_admin' }] },
  { id: 2, username: 'office.one', active: true, role_keys: ['custom_office'], roles: [{ id: 5, system_key: 'custom_office' }] },
  { id: 3, username: 'owner.two', active: true, role_keys: ['super_admin'], roles: [{ id: 9, system_key: 'super_admin' }] },
];

function appWith(db, actor = { id: 1 }) {
  const app = express();
  app.use(express.json());
  app.use(createAdminUserRoutes({
    db: {
      listRolesAndPermissions: async () => ({ roles: [{ id: 5, system_key: 'custom_office' }, { id: 9, system_key: 'super_admin' }], permissions: [] }),
      listAdminUsers: async () => USERS,
      ...db,
    },
    authMiddleware: (req, res, next) => { req.admin = actor; next(); },
    requirePermission: () => (req, res, next) => next(),
  }));
  return app;
}

async function send(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    server.close();
  }
}

test('a taken username on create is a 409 with its words and its code', async () => {
  const res = await send(appWith({ createAdminUser: async () => { throw taken(); } }),
    'POST', '/api/admin/users', { username: 'office.one', password: 'long-enough-1', role_ids: [5] });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'That username is already taken.', code: 'USERNAME_TAKEN' });
});

test('a taken username on rename is the same 409', async () => {
  const res = await send(appWith({ updateAdminUser: async () => { throw taken(); } }),
    'PUT', '/api/admin/users/2', { username: 'owner' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'That username is already taken.', code: 'USERNAME_TAKEN' });
});

test('an error nobody raised on purpose gets the generic line, never its own text', async () => {
  const res = await send(appWith({ createAdminUser: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); } }),
    'POST', '/api/admin/users', { username: 'new.one', password: 'long-enough-1', role_ids: [5] });
  assert.equal(res.status, 500);
  assert.deepEqual(res.json, { error: 'Could not create user.' });
});

test('creating an account with no role is refused with the same ROLE_REQUIRED', async () => {
  let created = false;
  const res = await send(appWith({ createAdminUser: async () => { created = true; } }),
    'POST', '/api/admin/users', { username: 'new.one', password: 'long-enough-1', role_ids: [] });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'ROLE_REQUIRED');
  assert.equal(created, false);
});

test('stripping every role is refused — the boot bootstrap must never meet a role-less account', async () => {
  let updated = false;
  const res = await send(appWith({ updateAdminUser: async () => { updated = true; } }),
    'PUT', '/api/admin/users/2', { role_ids: [] });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'ROLE_REQUIRED');
  assert.equal(updated, false);
});

test('an account manager who is not a super administrator cannot move super_admin, on create or update', async () => {
  const manager = { id: 2, role_keys: ['custom_office'] };
  let written = 0;
  const db = { createAdminUser: async () => { written += 1; }, updateAdminUser: async () => { written += 1; } };
  const grantOnCreate = await send(appWith(db, manager), 'POST', '/api/admin/users',
    { username: 'new.one', password: 'long-enough-1', role_ids: [9] });
  const grantToSelf = await send(appWith(db, manager), 'PUT', '/api/admin/users/2', { role_ids: [5, 9] });
  const demoteOther = await send(appWith(db, manager), 'PUT', '/api/admin/users/3', { role_ids: [5] });
  for (const res of [grantOnCreate, grantToSelf, demoteOther]) {
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'SUPER_ADMIN_ONLY');
  }
  assert.equal(written, 0);
  // Ordinary roles and password resets stay open to an account manager.
  const office = await send(appWith({ ...db, updateAdminUser: async () => ({ id: 2 }) }, manager), 'PUT', '/api/admin/users/2', { role_ids: [5] });
  assert.equal(office.status, 200);
});

test("an account manager cannot reset a super administrator's password or disable one; an ordinary account they can", async () => {
  const manager = { id: 2, role_keys: ['custom_office'] };
  let written = 0;
  const db = { updateAdminUser: async () => { written += 1; return { id: 1 }; } };
  const resetSuper = await send(appWith(db, manager), 'PUT', '/api/admin/users/1', { password: 'a-new-password-1' });
  const disableSuper = await send(appWith(db, manager), 'PUT', '/api/admin/users/3', { active: false });
  for (const res of [resetSuper, disableSuper]) {
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'SUPER_ADMIN_ONLY');
  }
  assert.equal(written, 0);
  const resetOffice = await send(appWith(db, manager), 'PUT', '/api/admin/users/2', { password: 'a-new-password-1' });
  assert.equal(resetOffice.status, 200);
  assert.equal(written, 1);
});

test('the database is told WHO acts, not what roles they had when the request began', async () => {
  let seen = null;
  const res = await send(appWith({ updateAdminUser: async (id, body) => { seen = body; return { id: Number(id) }; } },
    { id: 1, role_keys: ['super_admin'] }), 'PUT', '/api/admin/users/2', { password: 'a-new-password-1' });
  assert.equal(res.status, 200);
  assert.equal(seen.actorId, 1);
  assert.equal('actorRoleKeys' in seen, false, 'rbac.js re-reads the actor under lock');
});

test('a super administrator may grant super_admin', async () => {
  const res = await send(appWith({ updateAdminUser: async (id, body) => ({ id: Number(id), roleIds: body.roleIds }) },
    { id: 1, role_keys: ['super_admin'] }), 'PUT', '/api/admin/users/2', { role_ids: [5, 9] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.user.roleIds, [5, 9]);
});

