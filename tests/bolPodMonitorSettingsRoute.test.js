/**
 * Route tests for the BOL/POD monitor settings API (in server/routes/settingsRoutes.js).
 * Heavy DB modules are faked in the require cache; a stub telegram lets us assert
 * the test-message endpoint wiring. Covers GET/PUT (+ 400 on invalid group id),
 * status, and test-message.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');

process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '000:testbot';
process.env.TELEGRAM_BOT_TOKEN ||= '000:testnotif';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused_in_this_test';

const express = require('express');

function fakeModule(relPath, exportsObj) {
  const abs = path.resolve(__dirname, relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}

fakeModule('../database/db.js', { query: async () => ({ rows: [] }), pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) } });

const store = {
  settings: {
    enabled: false, testGroupId: '-5289094495', sendUnrelated: true, sendUnclear: true,
    sendFiles: true, lastReportAt: null, reportCount: 0, updatedAt: null, updatedBy: null, loaded: true,
  },
  lastUpdate: null,
  lastUpdatedBy: null,
  testMessageArgs: null,
};

fakeModule('../database/bolPodMonitorSettings.js', {
  async getSettingsForAdmin() { return store.settings; },
  async updateSettings(payload, updatedBy) {
    if (payload.test_group_id === 'bad') { const e = new Error('test_group_id must be a valid Telegram chat id (an integer, e.g. -5289094495).'); e.statusCode = 400; throw e; }
    store.lastUpdate = payload; store.lastUpdatedBy = updatedBy;
    if (typeof payload.test_monitor_enabled === 'boolean') store.settings.enabled = payload.test_monitor_enabled;
    if (payload.test_group_id) store.settings.testGroupId = String(payload.test_group_id);
    store.settings.updatedBy = updatedBy;
    return store.settings;
  },
});

fakeModule('../services/bolPodMonitorSettingsService.js', {
  async getStatus() {
    return { settings: store.settings, aiClassifierConfigured: true, datatruckConfigured: false, uploadMode: 'off', uploadPipelineEnabled: false };
  },
  async sendTestMessage(telegram, candidate) {
    store.testMessageArgs = { hasTelegram: !!telegram, candidate };
    return { ok: true, chatId: String(candidate || store.settings.testGroupId), message: 'Test message sent to the test group.' };
  },
  async checkGroupAccess(telegram, candidate) { return { ok: true, chatId: String(candidate || store.settings.testGroupId), title: 'Automatic updating (Test)', type: 'supergroup' }; },
});

const { createSettingsRouter } = require('../server/routes/settingsRoutes');

const fakeTelegram = { async sendMessage() { return { message_id: 1 }; }, async getChat() { return { title: 'x', type: 'supergroup' }; } };

function makeServer() {
  const app = express();
  app.use(express.json());
  const authMiddleware = (req, _res, next) => { req.admin = { username: 'admin' }; next(); };
  app.use('/api/settings', createSettingsRouter({ authMiddleware, telegram: fakeTelegram }));
  return app.listen(0);
}

function request(server, { method, path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('GET /api/settings/bol-pod-monitor returns { settings }', async () => {
  const server = makeServer();
  try {
    const res = await request(server, { method: 'GET', path: '/api/settings/bol-pod-monitor' });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.settings.testGroupId, '-5289094495');
    assert.equal(json.settings.enabled, false);
  } finally { server.close(); }
});

test('PUT /api/settings/bol-pod-monitor forwards payload + updatedBy', async () => {
  const server = makeServer();
  try {
    const res = await request(server, {
      method: 'PUT', path: '/api/settings/bol-pod-monitor',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_monitor_enabled: true, test_group_id: '-1002222' }),
    });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.settings.enabled, true);
    assert.equal(store.lastUpdate.test_monitor_enabled, true);
    assert.equal(store.lastUpdatedBy, 'admin');
  } finally { server.close(); }
});

test('PUT with an invalid group id → 400', async () => {
  const server = makeServer();
  try {
    const res = await request(server, {
      method: 'PUT', path: '/api/settings/bol-pod-monitor',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_group_id: 'bad' }),
    });
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /valid Telegram chat id/i);
  } finally { server.close(); }
});

test('GET /api/settings/bol-pod-monitor/status returns readiness', async () => {
  const server = makeServer();
  try {
    const res = await request(server, { method: 'GET', path: '/api/settings/bol-pod-monitor/status' });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.aiClassifierConfigured, true);
    assert.equal(json.uploadMode, 'off');
  } finally { server.close(); }
});

test('POST /api/settings/bol-pod-monitor/test-message sends via telegram', async () => {
  const server = makeServer();
  try {
    const res = await request(server, {
      method: 'POST', path: '/api/settings/bol-pod-monitor/test-message',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_group_id: '-777' }),
    });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, true);
    assert.equal(store.testMessageArgs.hasTelegram, true);
    assert.equal(store.testMessageArgs.candidate, '-777');
  } finally { server.close(); }
});
