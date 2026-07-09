const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');

// Required by config/config.js — set before anything pulls it in.
process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '000:testbot';
process.env.TELEGRAM_BOT_TOKEN ||= '000:testnotif';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused_in_this_test';

const express = require('express');

// Fake the heavy DB modules so no real Postgres is needed. We only care about
// the safety-events sub-routes here.
function fakeModule(relPath, exportsObj) {
  const abs = path.resolve(__dirname, relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}

// Minimal fake pool/query so config + sibling settings modules don't crash.
fakeModule('../database/db.js', { query: async () => ({ rows: [] }), pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) } });

// In-memory safety-events store fake.
const state = {
  view: {
    settings: { driverGroupMusicEnabled: false, speedingMusicEnabled: true, activeMusicAssetId: null,
      musicVolume: 0.35, preserveOriginalAudio: true, fadeInSeconds: 0, fadeOutSeconds: 1.5,
      loopMusicWhenVideoLonger: true, maxVideoSeconds: 120, updatedAt: null },
    activeMusic: null,
    musicAssets: [],
  },
  lastUpload: null,
  lastUpdate: null,
};
fakeModule('../database/safetyEventVideoSettings.js', {
  ALLOWED_AUDIO_MIME_TYPES: ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/aac'],
  MAX_MUSIC_BYTES: 20 * 1024 * 1024,
  async getSafetyEventVideoSettingsForAdmin() { return state.view; },
  async getSafetyEventVideoStatusForAdmin() {
    return {
      settings: state.view.settings,
      activeMusic: state.view.activeMusic,
      activeMusicPresent: Boolean(state.view.activeMusic),
      overlayConfigured: false,
      recentJobs: [
        { id: 2, status: 'fallback_sent', video_source: 'immediate', music_trim_mode: null, video_duration_seconds: 12, error_message: 'ffmpeg unavailable', created_at: '2026-07-09T00:00:00Z', finished_at: '2026-07-09T00:00:01Z' },
        { id: 1, status: 'sent', video_source: 'backfill', music_trim_mode: 'trim', video_duration_seconds: 10, error_message: null, created_at: '2026-07-08T00:00:00Z' },
      ],
      jobStatusCounts: { sent: 1, fallback_sent: 1 },
      lastFailure: { at: '2026-07-09T00:00:01Z', status: 'fallback_sent', source: 'immediate', reason: 'ffmpeg unavailable' },
    };
  },
  async updateSafetyEventVideoSettings(payload) { state.lastUpdate = payload; return state.view; },
  async insertMusicAsset(args) { state.lastUpload = args; return { id: 1, isActive: true }; },
  async setActiveMusicAsset(id) { return id === 999 ? null : { id, isActive: true }; },
  async deactivateMusicAsset() { return { id: 1, isActive: false }; },
  async deleteMusicAsset(id) { return id === 5 ? { deleted: false, reason: 'is_active' } : { deleted: true }; },
  async getMusicAssetById() { return null; },
});

const { createSettingsRouter } = require('../server/routes/settingsRoutes');

function makeServer() {
  const app = express();
  app.use(express.json());
  // Stub auth: always authorized as "admin".
  const authMiddleware = (req, _res, next) => { req.admin = { username: 'admin' }; next(); };
  app.use('/api/settings', createSettingsRouter({ authMiddleware }));
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

// Build a minimal multipart/form-data body for a file upload.
function multipart(fieldName, filename, contentType, contentBuf) {
  const boundary = '----testboundary1234';
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`
    + `Content-Type: ${contentType}\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([pre, contentBuf, post]) };
}

test('GET /api/settings/safety-events returns the settings view', async () => {
  const server = makeServer();
  try {
    const res = await request(server, { method: 'GET', path: '/api/settings/safety-events' });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.settings.speedingMusicEnabled, true);
    assert.ok(Array.isArray(json.musicAssets));
  } finally { server.close(); }
});

test('GET /api/settings/safety-events/status returns diagnostics (jobs + last failure)', async () => {
  const server = makeServer();
  try {
    const res = await request(server, { method: 'GET', path: '/api/settings/safety-events/status' });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.overlayConfigured, false);
    assert.equal(json.recentJobs.length, 2);
    assert.equal(json.jobStatusCounts.fallback_sent, 1);
    assert.equal(json.lastFailure.reason, 'ffmpeg unavailable');
  } finally { server.close(); }
});

test('PUT /api/settings/safety-events forwards the payload', async () => {
  const server = makeServer();
  try {
    const res = await request(server, {
      method: 'PUT', path: '/api/settings/safety-events',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverGroupMusicEnabled: true, musicVolume: 0.5 }),
    });
    assert.equal(res.status, 200);
    assert.equal(state.lastUpdate.driverGroupMusicEnabled, true);
    assert.equal(state.lastUpdate.musicVolume, 0.5);
  } finally { server.close(); }
});

test('POST music rejects a non-audio file with 400', async () => {
  const server = makeServer();
  try {
    const { boundary, body } = multipart('file', 'evil.txt', 'text/plain', Buffer.from('nope'));
    const res = await request(server, {
      method: 'POST', path: '/api/settings/safety-events/music',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      body,
    });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test('POST music accepts an audio file and stores it (201)', async () => {
  const server = makeServer();
  try {
    const { boundary, body } = multipart('file', 'clip.m4a', 'audio/mp4', Buffer.from('AUDIODATA'));
    const res = await request(server, {
      method: 'POST', path: '/api/settings/safety-events/music',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      body,
    });
    assert.equal(res.status, 201);
    assert.equal(state.lastUpload.mimeType, 'audio/mp4');
    assert.equal(state.lastUpload.uploadedBy, 'admin');
    assert.ok(Buffer.isBuffer(state.lastUpload.data));
  } finally { server.close(); }
});

test('activate returns 404 for a missing asset', async () => {
  const server = makeServer();
  try {
    const res = await request(server, { method: 'POST', path: '/api/settings/safety-events/music/999/activate' });
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('DELETE returns 409 when the asset is active', async () => {
  const server = makeServer();
  try {
    const res = await request(server, { method: 'DELETE', path: '/api/settings/safety-events/music/5' });
    assert.equal(res.status, 409);
  } finally { server.close(); }
});
