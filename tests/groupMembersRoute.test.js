/**
 * Route tests for GET /api/groups/:groupId/members — the captured-members
 * list that powers the Driver Groups "Driver Username" dropdown.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

function loadApp({ dbMock }) {
  const routePath = path.resolve(__dirname, '../server/routes/groupMembersRoutes.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');

  for (const p of [routePath, dbPath]) delete require.cache[p];
  require.cache[dbPath] = { exports: dbMock };

  const { createGroupMembersRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/groups',
    createGroupMembersRouter({
      authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
    })
  );
  return app;
}

async function call(app, pathname) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}${pathname}`);
    const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /:groupId/members returns captured members with display names', async () => {
  const captured = [];
  const dbMock = {
    async listGroupMembers(groupId) {
      captured.push(groupId);
      return [
        { group_id: 7, telegram_user_id: '5021', username: 'joe_d', first_name: 'Joe', last_name: 'Driver' },
        { group_id: 7, telegram_user_id: '9042', username: null, first_name: 'Silent', last_name: null },
        { group_id: 7, telegram_user_id: '13', username: null, first_name: null, last_name: null },
      ];
    },
  };
  const app = loadApp({ dbMock });
  const res = await call(app, '/api/groups/7/members');
  assert.equal(res.status, 200);
  assert.deepEqual(captured, [7]);
  assert.deepEqual(res.json.members, [
    { telegram_user_id: '5021', username: 'joe_d', display_name: 'Joe Driver' },
    // No username → still selectable; the id alone enables an inline mention.
    { telegram_user_id: '9042', username: null, display_name: 'Silent' },
    // No name at all → generic label so the option is never blank.
    { telegram_user_id: '13', username: null, display_name: 'User 13' },
  ]);
});

test('GET /:groupId/members returns an empty list for a quiet group', async () => {
  const app = loadApp({ dbMock: { async listGroupMembers() { return []; } } });
  const res = await call(app, '/api/groups/7/members');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.members, []);
});

test('GET /:groupId/members rejects a non-numeric group id', async () => {
  const app = loadApp({ dbMock: { async listGroupMembers() { throw new Error('unused'); } } });
  const res = await call(app, '/api/groups/abc/members');
  assert.equal(res.status, 400);
});

test('GET /:groupId/members surfaces db failures as 500', async () => {
  const app = loadApp({ dbMock: { async listGroupMembers() { throw new Error('boom'); } } });
  const res = await call(app, '/api/groups/7/members');
  assert.equal(res.status, 500);
});
