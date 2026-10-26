'use strict';

/**
 * Whether the video after the 4 PM celebration is paused (the owner,
 * 26 October 2026): Settings → Gross Grand Prix can stand it down without
 * deleting it, and bring it back. Paused, the teams' board shows the car alone,
 * and a screen already playing the video closes it on its next poll.
 *
 * Kept in a small JSON file beside the video, on the same volume, rather than
 * in the database: GET /api/gross-race answers every screen every thirty
 * seconds without a query (services/grossRace/feed.js), and this is read on
 * each of those answers. A file stat is free; a query per poll is not. The
 * parsed state is reused until the file changes.
 *
 * A state file that exists but cannot be read counts as PAUSED: the only way
 * the file comes to exist is somebody pressing Pause or Resume, and an
 * unreadable answer must not start a video with sound that somebody may have
 * stopped. A missing file is the ordinary "never paused".
 */
const fs = require('fs');
const path = require('path');
const { videoPath } = require('./celebrationVideo');

const NOT_PAUSED = Object.freeze({ paused: false, changedAt: null, changedBy: null, error: null });

function statePath(file = videoPath()) {
  return path.join(path.dirname(file), 'celebration-state.json');
}

let cached = null; // { file, mtimeMs, state }

/** The pause state: { paused, changedAt, changedBy, error }. Never throws. */
function pauseState(file = statePath()) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return NOT_PAUSED;
    return { ...NOT_PAUSED, paused: true, error: 'the pause setting could not be read' };
  }
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs) return cached.state;
  let state;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw.paused !== 'boolean') throw new Error('no "paused" in the file');
    state = {
      paused: raw.paused,
      changedAt: typeof raw.changedAt === 'string' ? raw.changedAt : null,
      changedBy: typeof raw.changedBy === 'string' ? raw.changedBy : null,
      error: null,
    };
  } catch (err) {
    console.error('[GROSS-RACE] the video pause setting is unreadable; treating the video as paused:', err.message);
    state = { ...NOT_PAUSED, paused: true, error: 'the pause setting could not be read' };
  }
  cached = { file, mtimeMs: stat.mtimeMs, state };
  return state;
}

/** Pause (true) or resume (false). Written beside and renamed over, like the video. */
async function setPaused(paused, { by = null, now = new Date(), file = statePath() } = {}) {
  if (typeof paused !== 'boolean') throw new TypeError('paused must be true or false');
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const state = { paused, changedAt: now.toISOString(), changedBy: by };
  const partial = `${file}.${process.pid}.${Date.now()}.part`;
  try {
    await fs.promises.writeFile(partial, JSON.stringify(state));
    await fs.promises.rename(partial, file);
  } catch (err) {
    await fs.promises.rm(partial, { force: true });
    throw err;
  }
  cached = null;
  return pauseState(file);
}

module.exports = { pauseState, setPaused, statePath };
