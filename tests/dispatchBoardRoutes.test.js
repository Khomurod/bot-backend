'use strict';

/**
 * The Dispatcher Board admin surface.
 *
 * The Board authenticates by a token in its query string, so the properties
 * being guarded here are about what LEAVES the server:
 *
 *   - the token is write-only, and a candidate sent to `/test` is never echoed;
 *   - `/test` answers with counts and histograms, not rows — a settings screen
 *     has no business rendering driver names, phone numbers or trailer numbers
 *     to answer "did it connect";
 *   - a connection that fails answers 200 with `connected: false`, not a 500,
 *     because the failure IS the finding the operator asked for.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const DB_PATH = require.resolve('../database/dispatchBoardSettings');
const CLIENT_PATH = require.resolve('../services/dispatchBoard/client');
const ROWS_PATH = require.resolve('../database/dispatchBoard');
const ROUTE_PATH = require.resolve('../server/routes/settings/dispatchBoardRoutes');

const BASE = 'https://script.example.com/macros/s/AKfycbX/exec';
const TOKEN = 'Sh4red-T0ken-ThatMustNeverAppear';

const BOARD_ANSWER = {
  board_date: '2026-09-12',
  rows: [
    { row: 2, driver_name: 'JOHN SMITH (COMPANY DRIVER)', truck: '001', phone: '+15555550001', trailer: 'T-118', status: 'HOME', dispatcher: 'Ann' },
    { row: 3, driver_name: 'A ONE / B TWO (LEASE DRIVERS)', truck: '310', status: 'DISPATCHED', is_team: true },
    { row: 4, driver_name: 'C THREE', truck: '27', status: 'READY', mystery_column: 'secret value' },
  ],
};

function loadApp({ fetchResult = { status: 200, json: BOARD_ANSWER }, fetchError = null, stored = {}, summary = null } = {}) {
  const seen = { updates: [], fetches: [] };
  const adminView = () => ({
    enabled: false, baseUrl: BASE, tokenSet: true, tokenMasked: '••••pear',
    configured: true, pollIntervalSeconds: 300, lastPollAt: null, lastPollOk: null,
    lastPollCount: null, lastError: null, updatedAt: null, updatedBy: null,
  });

  require.cache[DB_PATH] = {
    exports: {
      getBoardSettingsForAdmin: async () => adminView(),
      getBoardConfig: async () => ({ baseUrl: BASE, token: TOKEN, ...stored }),
      updateBoardSettings: async (payload, opts) => { seen.updates.push({ payload, opts }); return adminView(); },
      usableBaseUrl: (raw) => {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (!text) return null;
        try { return new URL(text).protocol.startsWith('http') ? text : null; } catch (_) { return null; }
      },
    },
  };
  require.cache[ROWS_PATH] = {
    exports: {
      summariseBoard: async () => summary || {
        total: 4, present: 3,
        fleet: { company: 1, lease: 1, owner_operator: 1, unknown: 0 },
        teams: 1, linked: 0, lastSeenAt: '2026-09-12T10:00:00.000Z',
        statuses: [{ status: 'HOME', count: 1 }, { status: 'DISPATCHED', count: 1 }],
      },
    },
  };
  require.cache[CLIENT_PATH] = {
    exports: {
      fetchBoard: async (connection) => {
        seen.fetches.push(connection);
        if (fetchError) throw fetchError;
        return fetchResult;
      },
    },
  };

  delete require.cache[ROUTE_PATH];
  // eslint-disable-next-line global-require
  const { createDispatchBoardSettingsRouter } = require(ROUTE_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createDispatchBoardSettingsRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
  const restore = () => {
    for (const p of [DB_PATH, CLIENT_PATH, ROWS_PATH, ROUTE_PATH]) delete require.cache[p];
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

test('the settings read reports that a token is set, and never the token', async (t) => {
  const { app, restore } = loadApp();
  t.after(restore);
  const res = await call(app, 'GET', '/api/settings/dispatch-board');
  assert.equal(res.status, 200);
  assert.equal(res.json.settings.tokenSet, true);
  assert.ok(!res.text.includes(TOKEN), res.text);
});

test('a candidate token sent to /test is proven and never echoed back', async (t) => {
  const { app, seen, restore } = loadApp();
  t.after(restore);
  const res = await call(app, 'POST', '/api/settings/dispatch-board/test', {
    baseUrl: BASE, token: TOKEN,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.connected, true);
  assert.equal(seen.fetches[0].token, TOKEN, 'the candidate was the one tested');
  assert.ok(!res.text.includes(TOKEN), 'the response must not contain it');
});

test('the test answers with counts, never with rows', async (t) => {
  const { app, restore } = loadApp();
  t.after(restore);
  const res = await call(app, 'POST', '/api/settings/dispatch-board/test', {});

  assert.equal(res.json.count, 3);
  assert.deepEqual(res.json.fleet, { company: 1, lease: 1, owner_operator: 1, unknown: 0 });
  assert.equal(res.json.teams, 1);
  assert.equal(res.json.status.HOME, 1);
  // Not one field of fleet data may reach a settings screen.
  for (const secret of ['JOHN SMITH', '+15555550001', 'T-118', 'Ann', 'secret value']) {
    assert.ok(!res.text.includes(secret), `${secret} must not be in the test response`);
  }
});

test('an unrecognised column is reported by name, which is how the shape is learned', async (t) => {
  const { app, restore } = loadApp();
  t.after(restore);
  const res = await call(app, 'POST', '/api/settings/dispatch-board/test', {});
  assert.deepEqual(res.json.unknownFields, ['mystery_column']);
});

test('a failed connection is a 200 with the reason, not a 500', async (t) => {
  const err = new Error('the board answered 429');
  const { app, restore } = loadApp({ fetchError: err });
  t.after(restore);
  const res = await call(app, 'POST', '/api/settings/dispatch-board/test', {});
  assert.equal(res.status, 200, 'the failure is the answer the operator asked for');
  assert.equal(res.json.connected, false);
  assert.match(res.json.message, /429/);
});

test('a URL leaking out of an unexpected failure is stripped on the way', async (t) => {
  const { app, restore } = loadApp({
    fetchError: new Error(`connect failed for ${BASE}?token=${TOKEN}`),
  });
  t.after(restore);
  const res = await call(app, 'POST', '/api/settings/dispatch-board/test', {});
  assert.ok(!res.text.includes(TOKEN), res.text);
  assert.ok(!res.text.includes('script.example.com'), res.text);
});

test('saving something that is not a URL is refused with a sentence, not a 500', async (t) => {
  const { app, seen, restore } = loadApp();
  t.after(restore);
  const res = await call(app, 'PUT', '/api/settings/dispatch-board', { baseUrl: 'paste it here' });
  assert.equal(res.status, 400);
  assert.equal(res.json.field, 'baseUrl');
  assert.match(res.json.error, /\/exec/);
  assert.equal(seen.updates.length, 0, 'nothing was written');
});

test('an empty base URL clears the setting rather than failing validation', async (t) => {
  const { app, seen, restore } = loadApp();
  t.after(restore);
  const res = await call(app, 'PUT', '/api/settings/dispatch-board', { baseUrl: '' });
  assert.equal(res.status, 200);
  assert.equal(seen.updates.length, 1);
});

test('who saved it is recorded', async (t) => {
  const { app, seen, restore } = loadApp();
  t.after(restore);
  await call(app, 'PUT', '/api/settings/dispatch-board', { enabled: true });
  assert.equal(seen.updates[0].opts.updatedBy, 'admin');
});

// ── the stored token belongs to the stored URL ──────────────────────────────

test('the stored token is never sent to a URL it was not saved against', async (t) => {
  const { app, seen, restore } = loadApp();
  t.after(restore);

  // An administrator edits only the address and clicks Test. A typo — or a
  // hostile address — would otherwise be handed the write-only credential.
  const res = await call(app, 'POST', '/api/settings/dispatch-board/test', {
    baseUrl: 'https://not-the-board.example/exec',
  });

  assert.equal(seen.fetches.length, 0, 'nothing was sent anywhere');
  assert.equal(res.json.connected, false);
  assert.match(res.json.message, /token/i);
});

test('testing the stored URL still uses the stored token', async (t) => {
  const { app, seen, restore } = loadApp();
  t.after(restore);
  const res = await call(app, 'POST', '/api/settings/dispatch-board/test', { baseUrl: BASE });
  assert.equal(res.json.connected, true);
  assert.equal(seen.fetches[0].token, TOKEN);
});

test('a new URL with its own token is tested normally', async (t) => {
  const { app, seen, restore } = loadApp();
  t.after(restore);
  const res = await call(app, 'POST', '/api/settings/dispatch-board/test', {
    baseUrl: 'https://a-new-board.example/exec', token: 'a-new-token',
  });
  assert.equal(res.json.connected, true);
  assert.equal(seen.fetches[0].token, 'a-new-token');
});

test('the feed answers with counts, and with nothing from the board', async (t) => {
  const { app, restore } = loadApp();
  t.after(restore);
  const res = await call(app, 'GET', '/api/settings/dispatch-board/feed');
  assert.equal(res.status, 200);
  assert.equal(res.json.summary.present, 3);
  assert.equal(res.json.summary.statuses.length, 2);
  // The feed reads Wenze's snapshot, so it must not reach the board at all.
  assert.ok(!res.text.includes(TOKEN), res.text);
  for (const secret of ['JOHN SMITH', '+15555550001', 'T-118', 'Ann', 'script.example.com']) {
    assert.ok(!res.text.includes(secret), secret);
  }
});

test('the feed never contacts the board', async (t) => {
  const { app, seen, restore } = loadApp();
  t.after(restore);
  await call(app, 'GET', '/api/settings/dispatch-board/feed');
  assert.equal(seen.fetches.length, 0, 'the snapshot is the answer; the board is not asked');
});

test('a database outage on the feed answers 503 with a machine-readable code', async (t) => {
  const failing = new Error('connection terminated unexpectedly');
  failing.code = 'ECONNREFUSED';
  const { app, restore } = loadApp();
  t.after(restore);
  // Replace the stub the router already holds, so the failure comes from the
  // same place a real outage would.
  require.cache[ROWS_PATH].exports.summariseBoard = async () => { throw failing; };
  const res = await call(app, 'GET', '/api/settings/dispatch-board/feed');
  assert.equal(res.status, 503, 'an outage is not an ordinary server error');
  assert.ok(res.json.code, 'the admin needs a code it can act on');
  assert.match(res.json.code, /^DB_/);
});

test('a failure response never carries a board URL or its token', async (t) => {
  const leaky = new Error(`GET ${BASE}?token=${TOKEN} failed`);
  leaky.code = 'ECONNREFUSED';
  const { app, restore } = loadApp();
  t.after(restore);
  require.cache[ROWS_PATH].exports.summariseBoard = async () => { throw leaky; };
  const res = await call(app, 'GET', '/api/settings/dispatch-board/feed');
  assert.ok(!res.text.includes(TOKEN), res.text);
  assert.ok(!res.text.includes('script.example.com'), res.text);
});
