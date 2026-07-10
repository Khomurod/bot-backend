/**
 * HTTP surface tests for server/routes/trailerRoutes.js. The db module is
 * replaced with a fake; the router is mounted in a bare Express app. Verifies
 * wiring + route ordering (specific paths win over /:id) + payload shape.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

function buildApp() {
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const routePath = path.resolve(__dirname, '../server/routes/trailerRoutes.js');

  const fakeDb = {
    listTrailers: async () => ([{ id: 1, unit_number: 'ST508998', current_status: 'dropped' }]),
    listTrailerMapData: async () => ([{ trailer_id: 1, unit_number: 'ST508998', current_status: 'dropped', current_lat: 40, current_lng: -76 }]),
    getTrailerSettings: async () => ({ id: 1, enabled: true, beta_mode: true, automatic_update_test_group_id: null }),
    listTrailerEvents: async () => ([{ id: 9, event_type: 'pickup' }]),
    listUnidentifiedTrailerEvents: async () => ([{ id: 3, event_type: 'unidentified' }]),
    getTrailerById: async (id) => ({ id: Number(id), unit_number: 'ST508998' }),
    getTrailerCurrentStatus: async () => ({ trailer_id: 1, current_status: 'dropped' }),
    getTrailerReviewContext: async () => ({ pendingEvent: null, previousEvent: null }),
    recomputeTrailerCurrentStatus: async () => ({ trailer_id: 1, current_status: 'dropped' }),
    listTrailerTimeline: async () => ([{ id: 9, event_type: 'pickup' }]),
    upsertTrailerByUnitNumber: async (t) => ({ id: 1, ...t }),
  };
  delete require.cache[routePath];
  require.cache[dbPath] = { exports: fakeDb };
  const { createTrailerRoutes } = require(routePath);

  const app = express();
  app.use(express.json());
  const passThroughAuth = (req, res, next) => { req.admin = { username: 'tester' }; next(); };
  app.use(createTrailerRoutes({ authMiddleware: passThroughAuth }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function get(port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('trailer routes are wired and ordered correctly', async () => {
  const app = buildApp();
  const { server, port } = await listen(app);
  try {
    const list = await get(port, '/api/trailers');
    assert.equal(list.status, 200);
    assert.equal(list.body.trailers[0].unit_number, 'ST508998');

    const map = await get(port, '/api/trailers/map');
    assert.equal(map.status, 200);
    assert.ok(Array.isArray(map.body.trailers));

    // /settings must NOT be captured by /:id.
    const settings = await get(port, '/api/trailers/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.settings.enabled, true);

    const events = await get(port, '/api/trailers/events');
    assert.equal(events.status, 200);
    assert.equal(events.body.events[0].event_type, 'pickup');

    const unid = await get(port, '/api/trailers/unidentified');
    assert.equal(unid_ok(unid), true);

    // /:id still works for a numeric id.
    const one = await get(port, '/api/trailers/1');
    assert.equal(one.status, 200);
    assert.equal(one.body.trailer.id, 1);

    const timeline = await get(port, '/api/trailers/1/events');
    assert.equal(timeline.status, 200);
    assert.ok(Array.isArray(timeline.body.events));
  } finally {
    server.close();
  }
});

function unid_ok(r) { return r.status === 200 && Array.isArray(r.body.events); }
