'use strict';

/**
 * The video /dispatchteam plays after the 4 PM celebration: kept on the
 * server's disk, served to the screens with no sign-in and in byte ranges,
 * replaced only by a signed-in admin, and never half-written.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const express = require('express');

const { createGrossRaceRoutes } = require('../server/routes/grossRaceRoutes');
const celebrationVideo = require('../services/grossRace/celebrationVideo');

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(500, 7)]);

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-video-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'celebration.mp4');
}

function adapter(file) {
  return {
    videoPath: () => file,
    hasVideo: () => celebrationVideo.hasVideo(file),
    saveVideo: (source) => celebrationVideo.saveVideo(source, { file, maxBytes: 1000 }),
  };
}

function serve(t, file, { signedIn = true } = {}) {
  const app = express();
  const authMiddleware = (req, res, next) => (signedIn ? next() : res.status(401).json({ error: 'sign in' }));
  app.use(createGrossRaceRoutes({ feed: { getRace: () => ({}) }, video: adapter(file), authMiddleware }));
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const put = (base, body, type = 'video/mp4') => fetch(`${base}/api/gross-race/video`, {
  method: 'PUT', headers: { 'Content-Type': type }, body,
});

test('the default file is under the app, never in a tracked directory', () => {
  assert.equal(celebrationVideo.videoPath({}), celebrationVideo.DEFAULT_PATH);
  assert.match(celebrationVideo.DEFAULT_PATH, /data[\\/]gross-race[\\/]celebration\.mp4$/);
  assert.equal(celebrationVideo.videoPath({ GROSS_RACE_VIDEO_PATH: ' /srv/v.mp4 ' }), '/srv/v.mp4');
  const ignored = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(ignored, /^\/data\/$/m, 'a video saved in development is never committed');
});

test('no video yet: the screens are told so, and the car plays alone', async (t) => {
  const base = serve(t, tempFile(t));
  assert.equal((await fetch(`${base}/api/gross-race/video`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/gross-race?view=teams`)).json()).video, false);
});

test('an admin replaces it; the screens get it with no sign-in, in byte ranges', async (t) => {
  const file = tempFile(t);
  const base = serve(t, file);
  const saved = await put(base, MP4);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true, bytes: MP4.length });

  const whole = await fetch(`${base}/api/gross-race/video`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), MP4);

  const part = await fetch(`${base}/api/gross-race/video`, { headers: { Range: 'bytes=4-11' } });
  assert.equal(part.status, 206);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), 'ftypisom');
  assert.equal((await (await fetch(`${base}/api/gross-race?view=teams`)).json()).video, true);
});

test('only a signed-in admin may replace it, and only with an MP4', async (t) => {
  const file = tempFile(t);
  assert.equal((await put(serve(t, file, { signedIn: false }), MP4)).status, 401);
  const base = serve(t, file);
  assert.equal((await put(base, MP4, 'text/plain')).status, 415);
  assert.equal((await put(base, Buffer.alloc(0))).status, 400);
  assert.equal(fs.existsSync(file), false);
});

test('a video over the limit is refused and the one playing stays', async (t) => {
  const file = tempFile(t);
  const base = serve(t, file);
  await put(base, MP4);
  const res = await put(base, Buffer.alloc(5000, 1));
  assert.equal(res.status, 413);
  assert.deepEqual(fs.readFileSync(file), MP4);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['celebration.mp4'], 'no half-written file is left behind');
});

test('saveVideo: an upload that breaks off leaves the old file untouched', async (t) => {
  const file = tempFile(t);
  await celebrationVideo.saveVideo(Readable.from([MP4]), { file });
  const broken = new Readable({ read() { this.push(Buffer.alloc(10)); this.destroy(new Error('connection reset')); } });
  await assert.rejects(celebrationVideo.saveVideo(broken, { file }), /connection reset/);
  assert.deepEqual(fs.readFileSync(file), MP4);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['celebration.mp4']);
});
