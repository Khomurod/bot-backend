/**
 * HTTP tests for the new trailer review + stability routes. db and the geocode
 * service are faked; the router is mounted in a bare Express app.
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
const fs = require('node:fs');
const express = require('express');

function buildApp(calls) {
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const routePath = path.resolve(__dirname, '../server/routes/trailerRoutes.js');
  const geoPath = path.resolve(__dirname, '../services/trailerGeocodeService.js');

  const fakeDb = {
    acceptTrailerEvent: async (id, opts) => { calls.accept = { id, opts }; return { id: Number(id), trailer_id: 7, review_status: 'accepted' }; },
    declineTrailerEvent: async (id, opts) => { calls.decline = { id, opts }; return { id: Number(id), trailer_id: 7, review_status: 'declined' }; },
    updateTrailerEvent: async (id, patch, opts) => { calls.update = { id, patch, opts }; return { id: Number(id), trailer_id: 7, review_status: 'edited', ...patch }; },
    recomputeTrailerCurrentStatus: async (tid) => { calls.recompute = tid; return { trailer_id: tid, current_status: 'with_driver' }; },
    getTrailerCurrentStatus: async (tid) => ({ trailer_id: tid, current_status: 'with_driver', needs_review: false }),
    getTrailerById: async (id) => ({ id: Number(id), unit_number: 'ST508998' }),
    getTrailerReviewContext: async () => ({ pendingEvent: null, previousEvent: null }),
    listTrailerEventsNeedingGeocode: async () => [],
    setTrailerEventGeocode: async () => ({}),
  };
  // Purge the router AND every module it mounts: server/routes/trailer/*.js
  // destructures db and the geocode service at require time, so a stale copy
  // would keep recording into a previous test's `calls` object — which reads as
  // a mysterious "the route did not call the database" failure.
  delete require.cache[routePath];
  for (const file of fs.readdirSync(path.resolve(__dirname, '../server/routes/trailer'))) {
    if (file.endsWith('.js')) delete require.cache[path.resolve(__dirname, '../server/routes/trailer', file)];
  }
  require.cache[dbPath] = { exports: fakeDb };
  require.cache[geoPath] = { exports: { geocodeTrailerLocation: async () => ({ lat: 40, lng: -76, source: 'geocoded', confidence: 75 }) } };
  const { createTrailerRoutes } = require(routePath);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.admin = { username: 'tester' }; next(); });
  app.use(createTrailerRoutes({ authMiddleware: (req, res, next) => next() }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}
async function req(port, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('POST /events/:id/accept records reviewer and returns event + status', async () => {
  const calls = {};
  const { server, port } = await listen(buildApp(calls));
  try {
    const r = await req(port, 'POST', '/api/trailers/events/5/accept', { note: 'looks right' });
    assert.equal(r.status, 200);
    assert.equal(r.body.event.review_status, 'accepted');
    assert.equal(r.body.status.current_status, 'with_driver');
    assert.equal(calls.accept.opts.reviewedBy, 'tester');
    assert.equal(calls.accept.opts.reviewNote, 'looks right');
  } finally { server.close(); }
});

test('POST /events/:id/decline marks declined + returns recomputed status', async () => {
  const calls = {};
  const { server, port } = await listen(buildApp(calls));
  try {
    const r = await req(port, 'POST', '/api/trailers/events/5/decline', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.event.review_status, 'declined');
    assert.equal(calls.decline.opts.reviewedBy, 'tester');
  } finally { server.close(); }
});

test('PUT /events/:id edits fields, recomputes, records corrector', async () => {
  const calls = {};
  const { server, port } = await listen(buildApp(calls));
  try {
    const r = await req(port, 'PUT', '/api/trailers/events/5', { event_type: 'dropoff', condition_text: 'flat tire' });
    assert.equal(r.status, 200);
    assert.equal(calls.update.patch.event_type, 'dropoff');
    assert.equal(calls.update.opts.correctedBy, 'tester');
    assert.equal(calls.recompute, 7); // status recomputed for the trailer
  } finally { server.close(); }
});

test('POST /:id/recompute-status returns the recomputed status', async () => {
  const calls = {};
  const { server, port } = await listen(buildApp(calls));
  try {
    const r = await req(port, 'POST', '/api/trailers/7/recompute-status', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.status.current_status, 'with_driver');
  } finally { server.close(); }
});

test('screenshot import rejects an oversized batch (too many files)', async () => {
  const { server, port } = await listen(buildApp({}));
  try {
    const fd = new FormData();
    for (let i = 0; i < 6; i += 1) {
      fd.append('screenshots', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), `s${i}.png`);
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/trailers/import/screenshot`, { method: 'POST', body: fd });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /at most 4 images|images per batch|Unexpected field|LIMIT/i);
  } finally { server.close(); }
});

test('screenshot import rejects a batch over the total-size cap', async () => {
  const { server, port } = await listen(buildApp({}));
  try {
    const fd = new FormData();
    // 4 files of 9 MB each = 36 MB > 35 MB total cap (each under the 10 MB/file limit).
    for (let i = 0; i < 4; i += 1) {
      fd.append('screenshots', new Blob([Buffer.alloc(9 * 1024 * 1024, 1)], { type: 'image/png' }), `big${i}.png`);
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/trailers/import/screenshot`, { method: 'POST', body: fd });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Total upload must be under 35 MB/i);
  } finally { server.close(); }
});
