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
  { id: 1, username: 'owner', active: true, role_keys: ['super_admin'] },
  { id: 2, username: 'office.one', active: true, role_keys: ['custom_office'] },
];

function appWith(db) {
  const app = express();
  app.use(express.json());
  app.use(createAdminUserRoutes({
    db: {
      listRolesAndPermissions: async () => ({ roles: [{ id: 5 }], permissions: [] }),
      listAdminUsers: async () => USERS,
      ...db,
    },
    authMiddleware: (req, res, next) => { req.admin = { id: 1 }; next(); },
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
