'use strict';

/**
 * Settings → Gross Grand Prix (the owner, 26 October 2026): an admin sees the
 * video after the 4 PM celebration, pauses and resumes it, and deletes it.
 * Paused, the teams' board is told there is no video — the car plays alone and
 * a video already on screen closes on the next poll — while the file stays.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { createGrossRaceRoutes } = require('../server/routes/grossRaceRoutes');
const celebrationVideo = require('../services/grossRace/celebrationVideo');
const videoPause = require('../services/grossRace/videoPause');

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(500, 7)]);

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-console-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'gross-race', 'celebration.mp4');
}

function adapter(file) {
  const state = videoPause.statePath(file);
  return {
    videoPath: () => file,
    hasVideo: () => celebrationVideo.hasVideo(file),
    saveVideo: (source) => celebrationVideo.saveVideo(source, { file }),
    videoInfo: () => celebrationVideo.videoInfo(file),
    deleteVideo: () => celebrationVideo.deleteVideo(file),
    pauseState: () => videoPause.pauseState(state),
    setPaused: (paused, opts) => videoPause.setPaused(paused, { ...opts, file: state }),
  };
}

function serve(t, file, { signedIn = true } = {}) {
  const app = express();
  const authMiddleware = (req, res, next) => {
    if (!signedIn) return res.status(401).json({ error: 'sign in' });
    req.admin = { username: 'owner' };
    return next();
  };
  app.use(createGrossRaceRoutes({ feed: { getRace: () => ({}) }, video: adapter(file), authMiddleware }));
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const call = (base, method, route, body) => fetch(`${base}${route}`, {
  method,
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const teamsVideo = async (base) => (await (await fetch(`${base}/api/gross-race?view=teams`)).json()).video;

test('the status says what is on the server, and nothing is paused at first', async (t) => {
  const file = tempFile(t);
  const base = serve(t, file);
  let status = await (await call(base, 'GET', '/api/gross-race/video/status')).json();
  assert.deepEqual(status, {
    exists: false, bytes: 0, updatedAt: null, paused: false, pausedChangedAt: null, pausedChangedBy: null, pauseError: null,
  });

  await celebrationVideo.saveVideo(require('stream').Readable.from([MP4]), { file });
  status = await (await call(base, 'GET', '/api/gross-race/video/status')).json();
  assert.equal(status.exists, true);
  assert.equal(status.bytes, MP4.length);
  assert.match(status.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('pause stands the video down on the teams\' board and keeps the file; resume brings it back', async (t) => {
  const file = tempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, MP4);
  const base = serve(t, file);
  assert.equal(await teamsVideo(base), true);

  const paused = await call(base, 'PUT', '/api/gross-race/video/paused', { paused: true });
  assert.equal(paused.status, 200);
  const body = await paused.json();
  assert.equal(body.paused, true);
  assert.equal(body.pausedChangedBy, 'owner');
  assert.equal(await teamsVideo(base), false, 'the screens are told there is no video');
  assert.equal(fs.existsSync(file), true, 'pausing never deletes');
  assert.equal((await fetch(`${base}/api/gross-race/video`)).status, 200, 'the admin can still preview it');

  await call(base, 'PUT', '/api/gross-race/video/paused', { paused: false });
  assert.equal(await teamsVideo(base), true);
});

test('a pause survives a restart: it is on the disk beside the video, not in memory', async (t) => {
  const file = tempFile(t);
  const state = videoPause.statePath(file);
  await videoPause.setPaused(true, { by: 'owner', file: state });
  assert.equal(path.dirname(state), path.dirname(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(state, 'utf8')).paused, true);
  assert.equal(videoPause.pauseState(state).paused, true);
});

test('an unreadable pause setting counts as paused, never as "play"', (t) => {
  const file = tempFile(t);
  const state = videoPause.statePath(file);
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, '{ not json');
  const read = videoPause.pauseState(state);
  assert.equal(read.paused, true);
  assert.match(read.error, /could not be read/);
});

test('delete removes the file; the board plays the car alone; deleting nothing is not an error', async (t) => {
  const file = tempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, MP4);
  const base = serve(t, file);
  const first = await call(base, 'DELETE', '/api/gross-race/video');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, deleted: true });
  assert.equal(fs.existsSync(file), false);
  assert.equal(await teamsVideo(base), false);
  assert.deepEqual(await (await call(base, 'DELETE', '/api/gross-race/video')).json(), { ok: true, deleted: false });
});

test('status, pause and delete need a signed-in admin; a pause needs a real true/false', async (t) => {
  const file = tempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, MP4);
  const outside = serve(t, file, { signedIn: false });
  assert.equal((await call(outside, 'GET', '/api/gross-race/video/status')).status, 401);
  assert.equal((await call(outside, 'PUT', '/api/gross-race/video/paused', { paused: true })).status, 401);
  assert.equal((await call(outside, 'DELETE', '/api/gross-race/video')).status, 401);
  assert.equal(fs.existsSync(file), true);

  const base = serve(t, file);
  for (const body of [{}, { paused: 'yes' }, { paused: 1 }]) {
    assert.equal((await call(base, 'PUT', '/api/gross-race/video/paused', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await teamsVideo(base), true);
});
