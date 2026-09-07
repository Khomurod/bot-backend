/**
 * The Bitrix admin surface: `GET /api/settings/bitrix` and
 * `POST /api/settings/bitrix/diagnose`.
 *
 * Two things are being guarded, and the first is the important one:
 *
 *   THE WEBHOOK URL IS THE CREDENTIAL. A Bitrix inbound webhook authenticates
 *   by its path, so returning the URL to a browser is handing out the key.
 *   Only the host may leave the server.
 *
 *   A diagnostic that cannot run answers 200 with a failed step, not a 500 —
 *   otherwise the admin panel renders "the server broke" for what is itself
 *   the finding.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const BITRIX_PATH = require.resolve('../services/bitrix24Service');
const DB_BITRIX_PATH = require.resolve('../database/bitrix');
const DIAG_PATH = require.resolve('../services/bitrix24DiagnosticsService');
const ROUTE_PATH = require.resolve('../server/routes/settings/bitrixRoutes');

const WEBHOOK = 'https://wenze.bitrix24.com/rest/1/super-secret-value/';

function loadApp({
  enabled = true,
  webhookUrl = WEBHOOK,
  entity = 'lead',
  assignedById = 'Tom Robinson',
  assigneeWaitMs = 25000,
  diagnose = async () => ({ ok: true, steps: [{ label: 'All', ok: true, detail: 'fine' }] }),
  updateError = null,
} = {}) {
  const seen = { diagnoseArgs: [], updates: [] };
  const host = webhookUrl ? new URL(webhookUrl).host : '';

  // The admin view database/bitrix builds — never the URL, only its host.
  const adminView = () => ({
    enabled,
    webhookSet: Boolean(webhookUrl),
    webhookHost: host,
    entity,
    assignedById,
    sourceId: 'WEB',
    sourceDescription: '',
    dealCategoryId: '3',
    dealStageId: 'C3:NEW',
    assigneeWaitMs,
    fromEnv: { enabled: false, webhookUrl: false, entity: false, assignedById: false, assigneeWaitMs: false },
    updatedAt: '2026-09-07T12:00:00.000Z',
  });

  require.cache[DB_BITRIX_PATH] = {
    exports: {
      getBitrixSettingsForAdmin: async () => adminView(),
      updateBitrixSettings: async (payload) => {
        seen.updates.push(payload);
        if (updateError) throw updateError;
        return adminView();
      },
    },
  };
  require.cache[BITRIX_PATH] = {
    exports: {
      isBitrixConfigured: async () => Boolean(enabled && webhookUrl),
    },
  };
  require.cache[DIAG_PATH] = {
    exports: {
      diagnoseBitrix: async (args) => { seen.diagnoseArgs.push(args); return diagnose(args); },
    },
  };

  delete require.cache[ROUTE_PATH];
  const { createBitrixSettingsRouter } = require(ROUTE_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createBitrixSettingsRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
  const restore = () => {
    for (const path of [DB_BITRIX_PATH, BITRIX_PATH, DIAG_PATH, ROUTE_PATH]) delete require.cache[path];
  };
  return { app, seen, restore };
}

async function call(app, method, pathname, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the status endpoint reports the host and never the webhook secret', async () => {
  const { app, restore } = loadApp();
  try {
    const res = await call(app, 'GET', '/api/settings/bitrix');
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('super-secret-value'), 'the path IS the credential');
    assert.equal(res.json.settings.webhookHost, 'wenze.bitrix24.com');
    assert.equal(res.json.settings.configured, true);
    assert.equal(res.json.settings.entity, 'lead');
    assert.equal(res.json.settings.assigneeWaitMs, 25000);
  } finally { restore(); }
});

test('an ignored assignee value is reported as ignored, not as configured', async () => {
  // The production default is a NAME, which Bitrix cannot use. The panel has to
  // say so, or the line looks effective.
  const named = loadApp({ assignedById: 'Tom Robinson' });
  try {
    const res = await call(named.app, 'GET', '/api/settings/bitrix');
    assert.equal(res.json.settings.assignedById, null);
    assert.equal(res.json.settings.assignedByIdRaw, 'Tom Robinson');
    assert.equal(res.json.settings.assignedByIdIgnored, true);
  } finally { named.restore(); }

  const numeric = loadApp({ assignedById: '17' });
  try {
    const res = await call(numeric.app, 'GET', '/api/settings/bitrix');
    assert.equal(res.json.settings.assignedById, 17);
    assert.equal(res.json.settings.assignedByIdIgnored, false);
  } finally { numeric.restore(); }

  const blank = loadApp({ assignedById: '' });
  try {
    const res = await call(blank.app, 'GET', '/api/settings/bitrix');
    assert.equal(res.json.settings.assignedById, null);
    assert.equal(res.json.settings.assignedByIdIgnored, false, 'not set is not a misconfiguration');
  } finally { blank.restore(); }
});

test('an unconfigured Bitrix still answers, saying it is unconfigured', async () => {
  const { app, restore } = loadApp({ enabled: false, webhookUrl: '' });
  try {
    const res = await call(app, 'GET', '/api/settings/bitrix');
    assert.equal(res.status, 200);
    assert.equal(res.json.settings.configured, false);
    assert.equal(res.json.settings.webhookHost, '');
  } finally { restore(); }
});

test('diagnose returns the steps, and passes a clamped window', async () => {
  const { app, seen, restore } = loadApp({
    diagnose: async () => ({ ok: false, steps: [{ label: 'Assignee readback', ok: false, detail: 'not mapped' }] }),
  });
  try {
    const res = await call(app, 'POST', '/api/settings/bitrix/diagnose', { days: 30 });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.steps[0].label, 'Assignee readback');
    assert.equal(seen.diagnoseArgs[0].days, 30);

    for (const [given, expected] of [[0, 14], [-5, 14], [1000, 90], ['abc', 14], [undefined, 14], [7, 7]]) {
      await call(app, 'POST', '/api/settings/bitrix/diagnose', { days: given });
      assert.equal(seen.diagnoseArgs.at(-1).days, expected, `days=${given}`);
    }
  } finally { restore(); }
});

test('a diagnostic that throws is a finding, not a 500', async () => {
  const { app, restore } = loadApp({
    diagnose: async () => { throw new Error('config/config.js blew up'); },
  });
  try {
    const res = await call(app, 'POST', '/api/settings/bitrix/diagnose', {});
    assert.equal(res.status, 200, 'the panel must render this as a result, not a crash');
    assert.equal(res.json.ok, false);
    assert.equal(res.json.steps[0].label, 'Diagnostic');
    assert.match(res.json.steps[0].detail, /blew up/);
  } finally { restore(); }
});

test('both routes are behind the admin guard', async () => {
  delete require.cache[ROUTE_PATH];
  const { createBitrixSettingsRouter } = require(ROUTE_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createBitrixSettingsRouter({
    authMiddleware: (_req, res) => res.status(401).json({ error: 'Unauthorized' }),
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/settings/bitrix`)).status, 401);
    assert.equal((await fetch(`${base}/api/settings/bitrix/diagnose`, { method: 'POST' })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete require.cache[ROUTE_PATH];
  }
});

// ─── saving: the reason Bitrix moved into the panel ───

test('PUT saves through database/bitrix and answers the masked view', async () => {
  const { app, seen, restore } = loadApp({ assignedById: '17' });
  try {
    const res = await call(app, 'PUT', '/api/settings/bitrix', {
      enabled: true, entity: 'lead', assignedById: '17', assigneeWaitMs: 30000,
      webhookUrl: 'https://wenze.bitrix24.com/rest/1/new-secret-value/',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen.updates, [{
      enabled: true, entity: 'lead', assignedById: '17', assigneeWaitMs: 30000,
      webhookUrl: 'https://wenze.bitrix24.com/rest/1/new-secret-value/',
    }]);
    assert.equal(res.json.settings.assignedById, 17);
    assert.equal(res.json.settings.assignedByIdIgnored, false);
    assert.equal(res.json.settings.webhookHost, 'wenze.bitrix24.com');
    assert.ok(!res.text.includes('secret'), 'the saved URL never comes back, not even a tail');
  } finally { restore(); }
});

test('a rejected field is a 400 with the reason, and nothing else about it leaks', async () => {
  const err = new Error('"Tom Robinson" is not a Bitrix user id — use the number from the profile URL (e.g. 17), or leave it blank.');
  err.statusCode = 400;
  const { app, restore } = loadApp({ updateError: err });
  try {
    const res = await call(app, 'PUT', '/api/settings/bitrix', { assignedById: 'Tom Robinson' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /not a Bitrix user id/);
  } finally { restore(); }
});

test('a database failure on save is a 500 that does not echo internals', async () => {
  const { app, restore } = loadApp({ updateError: new Error('connection terminated at 10.0.0.5') });
  try {
    const res = await call(app, 'PUT', '/api/settings/bitrix', { enabled: true });
    assert.equal(res.status, 500);
    assert.equal(res.json.error, 'Failed to save Bitrix24 settings');
    assert.ok(!res.text.includes('10.0.0.5'));
  } finally { restore(); }
});

test('GET reports which values still come from the environment', async () => {
  const { app, restore } = loadApp();
  try {
    const res = await call(app, 'GET', '/api/settings/bitrix');
    assert.deepEqual(res.json.settings.fromEnv, {
      enabled: false, webhookUrl: false, entity: false, assignedById: false, assigneeWaitMs: false,
    });
    assert.equal(res.json.settings.webhookSet, true);
  } finally { restore(); }
});
