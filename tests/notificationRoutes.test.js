/**
 * Admin → Settings → the destination screen, on what it REFUSES.
 *
 * This screen's entire job is to make sure notices reach people. Letting it be
 * configured to reach nobody would be a particularly bad joke — and it has
 * already happened once here, when a dropped minus sign turned `-5052301861`
 * into `5052301861` and 101 staff alerts were discarded over several months.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ROUTE = path.resolve(__dirname, '../server/routes/settings/notificationRoutes.js');
const SETTINGS = path.resolve(__dirname, '../database/operationalNotificationSettings.js');
const STORE = path.resolve(__dirname, '../database/operationalNotifications.js');
const GROUPS = path.resolve(__dirname, '../database/groups.js');
const SEND = path.resolve(__dirname, '../services/notifications/send.js');

function loadApp({ knownGroups = {}, getChat = null, notifyResult = null } = {}) {
  delete require.cache[require.resolve(ROUTE)];
  const saw = { saved: [], sent: [], notified: [] };

  require.cache[SETTINGS] = {
    exports: {
      async getNotificationSettings() {
        return { enabled: true, defaultChatId: '-100111', categoryChatIds: {}, repeatAfterHours: 168 };
      },
      async updateNotificationSettings(patch) { saw.saved.push(patch); return { ...patch, saved: true }; },
      invalidateCache() {},
    },
  };
  require.cache[STORE] = {
    exports: { async summariseNotifications() { return { pending: 0, abandoned: 0, delivered24h: 3 }; } },
  };
  require.cache[GROUPS] = {
    exports: { async getGroupByTelegramId(id) { return knownGroups[String(id)]; } },
  };
  require.cache[SEND] = {
    exports: {
      async notify(n) {
        saw.notified.push(n);
        return notifyResult || { recorded: true, delivered: true };
      },
    },
  };

  const telegram = {
    async getChat(id) {
      if (getChat) return getChat(id);
      return { type: 'supergroup', title: 'Ops' };
    },
    async sendMessage(chatId, body) { saw.sent.push({ chatId, body }); return { message_id: 1 }; },
  };

  const { createNotificationSettingsRouter } = require(ROUTE);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createNotificationSettingsRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
    telegram,
  }));
  return { app, saw };
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
  } finally { server.close(); }
}

test('the screen carries the catalogue, so each category is described in words', async () => {
  const { app } = loadApp();
  const res = await call(app, 'GET', '/api/settings/notifications');
  assert.equal(res.status, 200);
  assert.ok(res.body.categories.length > 5);
  for (const c of res.body.categories) {
    assert.ok(c.label && c.what, `${c.key} must be readable`);
  }
  assert.equal(res.body.queue.delivered24h, 3);
});

test('a dropped minus sign is refused and the corrected id offered', async () => {
  const { app, saw } = loadApp({ knownGroups: { '-1005052301861': { group_name: 'HR Personnel' } } });
  const res = await call(app, 'PUT', '/api/settings/notifications', { defaultChatId: '1005052301861' });
  assert.equal(res.status, 400);
  assert.equal(res.body.suggestion, '-1005052301861');
  assert.match(res.body.error, /HR Personnel/);
  assert.equal(saw.saved.length, 0, 'nothing was written');
});

test('the refusal names the field in words a person reads, not a JSON path', async () => {
  const { app } = loadApp({ knownGroups: { '-100999': { group_name: 'Fuel desk' } } });
  const res = await call(app, 'PUT', '/api/settings/notifications', {
    categoryChatIds: { fuel: '100999' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^Fuel risks /, `read: ${res.body.error}`);
  assert.equal(res.body.field, 'categoryChatIds.fuel', 'and the machine-readable path still travels');
});

test('an unreachable chat is refused', async () => {
  const { app, saw } = loadApp({ getChat: () => { throw new Error('Bad Request: chat not found'); } });
  const res = await call(app, 'PUT', '/api/settings/notifications', { defaultChatId: '-100777' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot reach/i);
  assert.equal(saw.saved.length, 0);
});

test('a private chat IS allowed — a small operation may want these in a DM', async () => {
  const { app, saw } = loadApp({ getChat: () => ({ type: 'private', first_name: 'Tom' }) });
  const res = await call(app, 'PUT', '/api/settings/notifications', { defaultChatId: '12345' });
  assert.equal(res.status, 200);
  assert.equal(saw.saved.length, 1);
});

test('CLEARING a destination never has to prove itself reachable', async () => {
  const { app, saw } = loadApp({ getChat: () => { throw new Error('chat not found'); } });
  const res = await call(app, 'PUT', '/api/settings/notifications', {
    categoryChatIds: { fuel: '' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(saw.saved[0].categoryChatIds, { fuel: '' });
});

test('an unknown category is the operator\'s mistake, so 400 rather than 500', async () => {
  const { app } = loadApp();
  require.cache[SETTINGS].exports.updateNotificationSettings = async () => {
    throw new Error('Unknown notification category "fuell".');
  };
  const res = await call(app, 'PUT', '/api/settings/notifications', {
    categoryChatIds: { fuell: '-100222' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown notification category/);
});

test('the test send answers 200 with ok:false on a refusal — the request worked', async () => {
  const { app } = loadApp({ getChat: () => ({ type: 'supergroup' }) });
  const failing = loadApp();
  failing.app.locals = {};
  const res = await call(app, 'POST', '/api/settings/notifications/test', { chatId: '-100111' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.chatId, '-100111');
});

test('a preview sends a REAL notice, with a fresh key each time', async () => {
  const { app, saw } = loadApp();
  await call(app, 'POST', '/api/settings/notifications/preview', { category: 'fuel' });
  await call(app, 'POST', '/api/settings/notifications/preview', { category: 'fuel' });
  assert.equal(saw.notified.length, 2);
  assert.notEqual(saw.notified[0].discriminator, saw.notified[1].discriminator,
    'a fixed key would let a category be previewed exactly once, ever');
});
