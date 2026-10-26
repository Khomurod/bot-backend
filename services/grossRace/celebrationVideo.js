'use strict';

/**
 * The video /dispatchteam plays after the 4 PM celebration (the owner,
 * 16 October 2026). It is the company's own clip, so it lives on the server's
 * disk — a persistent volume in production — and never in this public
 * repository.
 *
 * GROSS_RACE_VIDEO_PATH names the file; by default `data/gross-race/
 * celebration.mp4` under the app (`/app/data/...` in the container, where the
 * Coolify volume is mounted). No file: no video, and the screen shows the car
 * alone, as before.
 *
 * A new file is written beside the old one and renamed over it, so a screen
 * never reads half an upload.
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'gross-race', 'celebration.mp4');
const MAX_BYTES = 100 * 1024 * 1024;

function videoPath(env = process.env) {
  const configured = String(env.GROSS_RACE_VIDEO_PATH || '').trim();
  return configured ? path.resolve(configured) : DEFAULT_PATH;
}

/** Whether there is a video to play: a non-empty file at `file`. */
function hasVideo(file = videoPath()) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

class TooLarge extends Error {
  constructor() { super(`video is over ${MAX_BYTES} bytes`); this.code = 'TOO_LARGE'; }
}

/**
 * Write `source` (a readable stream of an MP4) to `file`, replacing what was
 * there only once all of it arrived. Resolves with the size written.
 */
async function saveVideo(source, { file = videoPath(), maxBytes = MAX_BYTES } = {}) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.${Date.now()}.part`;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(new TooLarge());
      return done(null, chunk);
    },
  });
  try {
    await pipeline(source, counter, fs.createWriteStream(partial));
    if (bytes === 0) throw Object.assign(new Error('the upload was empty'), { code: 'EMPTY' });
    await fs.promises.rename(partial, file);
    return bytes;
  } catch (err) {
    await fs.promises.rm(partial, { force: true });
    throw err;
  }
}

/** What Settings → Gross Grand Prix shows: whether there is one, how big, since when. */
function videoInfo(file = videoPath()) {
  try {
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.size > 0) return { exists: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch { /* no file is the ordinary "no video" */ }
  return { exists: false, bytes: 0, updatedAt: null };
}

/**
 * Remove it: the teams' board shows the car alone, and a screen in the middle
 * of playing it closes it on its next poll (`video: false`). Resolves with
 * whether there was a file to remove. A pause, if set, stays for the next one.
 */
async function deleteVideo(file = videoPath()) {
  try {
    await fs.promises.unlink(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = { DEFAULT_PATH, MAX_BYTES, deleteVideo, hasVideo, saveVideo, videoInfo, videoPath };
