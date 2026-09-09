/**
 * PUT /api/home-time/settings must not accept a chat id that points at nothing.
 *
 * The route validated SHAPE only, so '5052301861' — the "HR Personnel" chat with
 * its minus sign dropped — saved cleanly and then failed at every send for
 * months. These tests pin the rejection, and pin that it did not become a wall:
 * an unrelated setting, a cleared destination, and a chat we simply do not know
 * all still save.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { purgeModulePackage } = require('./helpers/purgeDataLayer');

const HR = { telegram_group_id: -5052301861, group_name: 'HR Personnel' };

function loadApp({ groups = [HR], telegram, written }) {
  const routePath = path.resolve(__dirname, '../server/routes/homeTimeRoutes.js');
  const routeDir = path.resolve(__dirname, '../server/routes/homeTime');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const groupsPath = path.resolve(__dirname, '../database/groups.js');

  purgeModulePackage(routePath, routeDir, [htPath, dbPath, groupsPath]);

  require.cache[dbPath] = { exports: {} };
  require.cache[groupsPath] = {
    exports: {
      async getGroupByTelegramId(id) {
        return groups.find((g) => String(g.telegram_group_id) === String(id));
      },
    },
  };
  require.cache[htPath] = {
    exports: {
      async getHomeTimeSettings() { return { enabled: true, driver_clarification_enabled: true }; },
      async updateHomeTimeSettings(patch) { written.push(patch); return { ...patch }; },
    },
  };

  const { createHomeTimeRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  app.use('/api/home-time', createHomeTimeRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
    telegram,
  }));
  return app;
}

async function putSettings(app, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/home-time/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a sign-dropped chat id is rejected and nothing is written', async () => {
  const written = [];
  const app = loadApp({ written });
  const { status, json } = await putSettings(app, { internal_clarification_group_id: '5052301861' });

  assert.equal(status, 400);
  assert.match(json.error, /^internal_clarification_group_id /);
  assert.match(json.error, /HR Personnel/);
  assert.equal(json.suggestion, '-5052301861');
  assert.deepEqual(written, [], 'the settings row must be left untouched');
});

test('the corrected id saves', async () => {
  const written = [];
  const app = loadApp({ written });
  const { status } = await putSettings(app, { internal_clarification_group_id: '-5052301861' });

  assert.equal(status, 200);
  assert.equal(written.length, 1);
  assert.equal(written[0].internal_clarification_group_id, '-5052301861');
});

test('clearing a destination still works', async () => {
  const written = [];
  const app = loadApp({ written });
  const { status } = await putSettings(app, { completed_notify_group_id: '' });

  assert.equal(status, 200);
  assert.equal(written[0].completed_notify_group_id, null);
});

test('an unrelated setting is not made to pass a chat-id check', async () => {
  const written = [];
  const app = loadApp({ written });
  const { status } = await putSettings(app, { road_allowance_weeks: 5 });

  assert.equal(status, 200);
  assert.deepEqual(written, [{ road_allowance_weeks: 5 }]);
});

test('a chat we have never captured is still accepted when nothing contradicts it', async () => {
  const written = [];
  const app = loadApp({ groups: [], written });
  const { status } = await putSettings(app, { completed_notify_group_id: '-1009999999999' });

  assert.equal(status, 200);
  assert.equal(written[0].completed_notify_group_id, '-1009999999999');
});

test('with a Telegram client, an unreachable chat is rejected', async () => {
  const written = [];
  const telegram = { async getChat() { throw new Error('400: Bad Request: chat not found'); } };
  const app = loadApp({ groups: [], written, telegram });
  const { status, json } = await putSettings(app, { completed_notify_group_id: '-1009999999999' });

  assert.equal(status, 400);
  assert.match(json.error, /chat not found/);
  assert.deepEqual(written, []);
});
