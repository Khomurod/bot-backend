/**
 * Route tests for GET /api/bot-users — the admin Users tab API. Verifies the
 * new fields, the derived source (dispatch match wins), and that filter/search
 * query params are forwarded to the DB layer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

function loadApp({ dbMock }) {
  const routePath = path.resolve(__dirname, '../server/routes/botUsersRoutes.js');
  const dbPath = path.resolve(__dirname, '../database/botUsers.js');
  for (const p of [routePath, dbPath]) delete require.cache[p];
  require.cache[dbPath] = { exports: dbMock };
  const { createBotUsersRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  app.use('/api/bot-users', createBotUsersRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
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

test('GET / returns enriched users and infers dispatcher source when team-linked', async () => {
  const dbMock = {
    async listBotUsers() {
      return [
        {
          telegram_user_id: '100', username: 'joe_d', first_name: 'Joe', last_name: 'Driver',
          interactions: 0, message_count: 12, last_group_id: 7, last_group_name: 'Driver Joe',
          last_seen_chat_id: '-100123', language_code: 'en', is_bot: false,
          linked_team_id: 3, linked_team_name: 'East Dispatch', source: null,
          first_seen_at: '2026-07-01T00:00:00Z', last_interaction_at: '2026-07-08T00:00:00Z',
        },
        {
          telegram_user_id: '200', username: null, first_name: 'Silent', last_name: null,
          interactions: 0, message_count: 1, last_group_id: null, last_group_name: null,
          last_seen_chat_id: null, language_code: null, is_bot: false,
          linked_team_id: null, linked_team_name: null, source: null,
          first_seen_at: '2026-07-05T00:00:00Z', last_interaction_at: '2026-07-06T00:00:00Z',
        },
      ];
    },
  };
  const app = loadApp({ dbMock });
  const res = await call(app, '/api/bot-users');
  assert.equal(res.status, 200);
  assert.equal(res.json.users.length, 2);
  const joe = res.json.users[0];
  assert.equal(joe.message_count, 12);
  assert.equal(joe.linked_team_name, 'East Dispatch');
  assert.equal(joe.source, 'dispatcher'); // dispatch match wins
  assert.equal(joe.last_seen_chat_id, '-100123');
  assert.equal(res.json.users[1].source, 'unknown');
});

test('GET / forwards filter and search to the DB layer', async () => {
  let received = null;
  const dbMock = {
    async listBotUsers(opts) { received = opts; return []; },
  };
  const app = loadApp({ dbMock });
  const res = await call(app, '/api/bot-users?filter=dispatch&search=joe&limit=50');
  assert.equal(res.status, 200);
  assert.equal(received.filter, 'dispatch');
  assert.equal(received.search, 'joe');
  assert.equal(received.limit, 50);
});
