/**
 * Admin → Settings → Recruiting hours, on what it REFUSES.
 *
 * A malformed window is the dangerous save here, and it is dangerous because it
 * is SILENT: `evaluateHours` reads an unreadable window as "not a window", the
 * office looks open forever, and a feature an administrator switched on simply
 * never runs. Nothing errors and nothing sends. So the screen refuses it at the
 * door with a sentence naming which window.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ROUTE = path.resolve(__dirname, '../server/routes/settings/recruitingHoursRoutes.js');
const STORE = path.resolve(__dirname, '../database/recruitingHours.js');
const CONVOS = path.resolve(__dirname, '../database/recruitingConversations.js');

const OFFICE = [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }];

function loadApp({ current = {} } = {}) {
  delete require.cache[require.resolve(ROUTE)];
  const saw = { saved: [], closed: [] };
  const settings = {
    timezone: 'America/Chicago',
    windows: OFFICE,
    aiAfterHoursEnabled: false,
    maxRepliesPerConversation: 4,
    quietStartLocal: '21:00',
    quietEndLocal: '08:00',
    ...current,
  };

  require.cache[STORE] = {
    exports: {
      async getRecruitingHours() { return settings; },
      async updateRecruitingHours(patch) { saw.saved.push(patch); return { ...settings, ...patch }; },
    },
  };
  require.cache[CONVOS] = {
    exports: {
      async listConversations() { return [{ driverPhone: '+15551230000', status: 'active', repliesSent: 2 }]; },
      async closeConversation(phone, args) { saw.closed.push({ phone, ...args }); return { driverPhone: phone, ...args }; },
    },
  };

  const { createRecruitingHoursRouter } = require(ROUTE);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createRecruitingHoursRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
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

test('the screen is told whether the office is open RIGHT NOW, computed server-side', async () => {
  const { app } = loadApp();
  const res = await call(app, 'GET', '/api/settings/recruiting-hours');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.now.open, 'boolean');
  assert.equal(typeof res.body.now.aiWouldAnswer, 'boolean');
  assert.match(res.body.summary, /America\/Chicago/);
  assert.equal(res.body.conversations.length, 1);
});

test('"would Wenze answer" is a different question from "is the office shut"', async () => {
  const { app } = loadApp({ current: { aiAfterHoursEnabled: false, windows: [] } });
  const res = await call(app, 'GET', '/api/settings/recruiting-hours');
  assert.equal(res.body.now.open, true, 'no windows means always open');
  assert.equal(res.body.now.aiWouldAnswer, false);
});

test('a window with an unreadable time is refused, naming which window', async () => {
  const { app, saw } = loadApp();
  const res = await call(app, 'PUT', '/api/settings/recruiting-hours', {
    windows: [OFFICE[0], { days: [6], start: 'lunchtime', end: '18:00' }],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Window 2/);
  assert.equal(res.body.field, 'windows.1.start');
  assert.equal(saw.saved.length, 0, 'nothing is written when anything is refused');
});

test('a day outside 1-7 is refused', async () => {
  const { app } = loadApp();
  const res = await call(app, 'PUT', '/api/settings/recruiting-hours', {
    windows: [{ days: [0, 8], start: '08:00', end: '18:00' }],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /days must be 1/);
});

test('switching the AI on with no working hours is refused, and says why', async () => {
  // With no windows the office reads as always open, so the feature would be
  // enabled and permanently silent — the worst of both.
  const { app, saw } = loadApp({ current: { windows: [] } });
  const res = await call(app, 'PUT', '/api/settings/recruiting-hours', { aiAfterHoursEnabled: true });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /working-hours window first/);
  assert.equal(res.body.field, 'windows');
  assert.equal(saw.saved.length, 0);
});

test('switching it on together with the hours in one save is allowed', async () => {
  const { app, saw } = loadApp({ current: { windows: [] } });
  const res = await call(app, 'PUT', '/api/settings/recruiting-hours', {
    aiAfterHoursEnabled: true, windows: OFFICE,
  });
  assert.equal(res.status, 200);
  assert.equal(saw.saved.length, 1);
});

test('a reply cap outside the schema bounds is a sentence, not a 500 from Postgres', async () => {
  const { app } = loadApp();
  for (const cap of [-1, 21, 2.5, 'lots']) {
    const res = await call(app, 'PUT', '/api/settings/recruiting-hours', { maxRepliesPerConversation: cap });
    assert.equal(res.status, 400, String(cap));
    assert.equal(res.body.field, 'maxRepliesPerConversation');
  }
});

test('a quiet-hours time that is not a time is refused', async () => {
  const { app } = loadApp();
  const res = await call(app, 'PUT', '/api/settings/recruiting-hours', { quietStartLocal: '9pm' });
  assert.equal(res.status, 400);
  assert.equal(res.body.field, 'quietStartLocal');
});

test('windows are cleaned before they are stored', async () => {
  const { app, saw } = loadApp();
  const res = await call(app, 'PUT', '/api/settings/recruiting-hours', {
    windows: [{ label: '  Weekdays  ', days: [5, 1, 1, 3], start: '8:00', end: '18:00:00' }],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(saw.saved[0].windows, [
    { label: 'Weekdays', days: [1, 3, 5], start: '08:00', end: '18:00' },
  ]);
});

test('a conversation can be handed back, or handed to Wenze again', async () => {
  const { app, saw } = loadApp();
  const stop = await call(app, 'PATCH', '/api/settings/recruiting-hours/conversations/+15551230000', {
    status: 'stopped', reason: 'candidate asked for a person',
  });
  assert.equal(stop.status, 200);
  assert.equal(saw.closed[0].status, 'stopped');

  const resume = await call(app, 'PATCH', '/api/settings/recruiting-hours/conversations/+15551230000', {
    status: 'active',
  });
  assert.equal(resume.status, 200);
  assert.equal(saw.closed[1].reason, null, 'resuming clears the reason rather than inventing one');
});

test('an unknown conversation status is refused', async () => {
  const { app } = loadApp();
  const res = await call(app, 'PATCH', '/api/settings/recruiting-hours/conversations/+15551230000', {
    status: 'whatever',
  });
  assert.equal(res.status, 400);
});
