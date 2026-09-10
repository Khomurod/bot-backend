/**
 * Terms-watcher routes: the destination can be a person, and can be tested.
 *
 * A notification setting nobody has ever exercised is the failure that started
 * this project — a chat id with its minus sign dropped, 101 alerts undelivered.
 * "Send a test" turns "I think it works" into a message on somebody's phone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ROUTE = path.resolve(__dirname, '../server/routes/settings/aiPolicyRoutes.js');
const stub = (rel, exports) => { require.cache[path.resolve(__dirname, rel)] = { exports }; };

function loadApp({ telegram, settings = {} } = {}) {
  delete require.cache[ROUTE];
  const saw = { checks: [], updates: [] };
  stub('../database/aiPolicy.js', {
    async getWatcherSettings() { return { enabled: true, notifyChatId: '-1001', notifyEnabled: true, ...settings }; },
    async listSourcesForAdmin() { return []; },
    async updateWatcherSettings(patch) { saw.updates.push(patch); return patch; },
    async addSource(s) { return s; }, async setSourceEnabled() { return {}; }, async deleteSource() { return true; },
  });
  stub('../database/aiPolicyFindings.js', {
    async listFindings() { return []; }, async countExhaustedAlerts() { return { count: 0 }; },
    async acknowledgeFinding() { return {}; },
  });
  stub('../database/groups.js', { async getGroupByTelegramId() { return undefined; } });
  stub('../services/telegramChatIdCheck.js', {
    async checkChatIdColumns(patch, columns, deps) { saw.checks.push({ patch, columns, deps }); return { error: null }; },
  });
  stub('../services/ai/policy/policyWatcher.js', { async runPolicyCheck() { return { sources: 0 }; } });
  stub('../services/ai/policy/sourceDiscovery.js', { async ensureCatalogSources() { return { seeded: 0 }; } });

  const { createAiPolicyRouter } = require(ROUTE);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createAiPolicyRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'tom' }; next(); },
    telegram,
  }));
  return { app, saw };
}

async function call(app, method, url, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { server.close(); }
}

test('saving a destination allows a private user, not only a group', async () => {
  const { app, saw } = loadApp({ telegram: { async sendMessage() {} } });
  const res = await call(app, 'PUT', '/api/settings/ai/policy', { notifyChatId: '987654321' });
  assert.equal(res.status, 200);
  assert.equal(saw.checks[0].deps.allowPrivate, true, 'AI monitoring may report to one person');
});

test('test-notification sends to the configured destination and says so', async () => {
  const sent = [];
  const telegram = { async sendMessage(chatId, text, opts) { sent.push({ chatId, text, opts }); return { message_id: 1 }; } };
  const { app } = loadApp({ telegram });
  const res = await call(app, 'POST', '/api/settings/ai/policy/test-notification', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(sent[0].chatId, '-1001');
  assert.match(sent[0].text, /test/i);
  assert.match(sent[0].text, /provider terms|model changes/i, 'it says what will arrive here');
});

test('test-notification can try a candidate id before it is saved', async () => {
  const sent = [];
  const telegram = { async sendMessage(chatId) { sent.push(chatId); return {}; } };
  const { app } = loadApp({ telegram });
  await call(app, 'POST', '/api/settings/ai/policy/test-notification', { chatId: '555' });
  assert.deepEqual(sent, ['555']);
});

test('a Telegram refusal is a 200 with ok:false and the token stripped', async () => {
  const telegram = {
    async sendMessage() { throw new Error('400: Bad Request: chat not found for bot123456:AAHsuperSECRETtoken'); },
  };
  const { app } = loadApp({ telegram });
  const res = await call(app, 'POST', '/api/settings/ai/policy/test-notification', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /chat not found/);
  assert.equal(/AAHsuperSECRETtoken/.test(res.body.error), false);
});

test('no Telegram client and no destination are explained, not crashed', async () => {
  const noClient = loadApp({ telegram: null });
  let res = await call(noClient.app, 'POST', '/api/settings/ai/policy/test-notification', {});
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /Telegram/);

  const noChat = loadApp({ telegram: { async sendMessage() {} }, settings: { notifyChatId: null } });
  res = await call(noChat.app, 'POST', '/api/settings/ai/policy/test-notification', {});
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /destination/i);
});
