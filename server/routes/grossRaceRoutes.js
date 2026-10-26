/**
 * The Gross Grand Prix behind the /dispatchteam and /dispatch displays.
 *
 * GET /api/gross-race?view=teams|dispatchers — the standings. PUBLIC, like the
 * recruiters' leaderboard (/api/recruiters/public-stats): the screens hang in
 * the office with nobody signed in. So the payload is kept to names and race
 * numbers (services/grossRace/standings.js says which), and the Datatruck token
 * never leaves the server. Answering never waits on Datatruck and never reads
 * the database: services/grossRace/feed.js holds the week.
 *
 * `page` names the build of the race page this server hands out
 * (services/grossRace/pageVersion.js); a screen running another one reloads.
 * `video` says whether the teams' board has a video to play after the 4 PM
 * celebration (services/grossRace/celebrationVideo.js).
 *
 * GET /api/gross-race/video — that video, public for the same reason, with
 * byte ranges so a TV can start playing before all of it arrived.
 * PUT /api/gross-race/video — replace it (an MP4 as the request body); signed
 * in, with full admin access only. Like the three below, it is what Settings →
 * Gross Grand Prix uses (the owner, 26 October 2026):
 * GET /api/gross-race/video/status — whether there is one, its size and date,
 * and whether it is paused.
 * PUT /api/gross-race/video/paused { paused } — pause or resume it. Paused, the
 * teams' board is told `video: false`, so it shows the car alone and closes a
 * video already playing on its next poll; the file stays.
 * DELETE /api/gross-race/video — remove it.
 */
const express = require('express');
const celebrationVideo = require('../../services/grossRace/celebrationVideo');
const videoPause = require('../../services/grossRace/videoPause');

const defaultVideo = { ...celebrationVideo, ...videoPause };

const VIEWS = new Set(['teams', 'dispatchers']);
const passThrough = (_req, _res, next) => next();

function createGrossRaceRoutes({ feed, racePageVersion = () => null, video = defaultVideo, authMiddleware = passThrough }) {
  const router = express.Router();
  const pause = () => (typeof video.pauseState === 'function' ? video.pauseState() : { paused: false });
  const playable = () => video.hasVideo() && !pause().paused;
  const who = (req) => (req.admin && req.admin.username) || null;

  router.get('/api/gross-race', (req, res) => {
    const view = typeof req.query.view === 'string' ? req.query.view : '';
    if (!VIEWS.has(view)) return res.status(400).json({ error: 'view must be teams or dispatchers' });
    try {
      res.set('Cache-Control', 'no-store');
      return res.json({ ...feed.getRace(view), page: racePageVersion(), video: view === 'teams' && playable() });
    } catch (err) {
      console.error('[GROSS-RACE] standings failed:', err.message);
      return res.status(500).json({ error: 'Failed to load the race' });
    }
  });

  router.get('/api/gross-race/video', (req, res) => {
    if (!video.hasVideo()) return res.status(404).json({ error: 'No video' });
    // A replaced video must reach the screens the same day: revalidate, never assume.
    return res.sendFile(video.videoPath(), { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-cache' } }, (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: 'Failed to send the video' });
    });
  });

  router.put('/api/gross-race/video', authMiddleware, async (req, res) => {
    if (!String(req.headers['content-type'] || '').startsWith('video/mp4')) {
      return res.status(415).json({ error: 'Send an MP4 (Content-Type: video/mp4)' });
    }
    try {
      const bytes = await video.saveVideo(req);
      console.log(`[GROSS-RACE] celebration video replaced (${bytes} bytes) by ${who(req) || 'an admin'}`);
      return res.json({ ok: true, bytes });
    } catch (err) {
      if (err.code === 'TOO_LARGE') return res.status(413).json({ error: 'The video is too large (100 MB at most)' });
      if (err.code === 'EMPTY') return res.status(400).json({ error: 'The upload was empty' });
      console.error('[GROSS-RACE] saving the video failed:', err.message);
      return res.status(500).json({ error: 'Failed to save the video' });
    }
  });

  router.get('/api/gross-race/video/status', authMiddleware, (req, res) => {
    try {
      const { paused, changedAt, changedBy, error } = pause();
      return res.json({ ...video.videoInfo(), paused, pausedChangedAt: changedAt, pausedChangedBy: changedBy, pauseError: error });
    } catch (err) {
      console.error('[GROSS-RACE] reading the video status failed:', err.message);
      return res.status(500).json({ error: 'Failed to read the video status' });
    }
  });

  router.put('/api/gross-race/video/paused', authMiddleware, express.json(), async (req, res) => {
    const paused = req.body && req.body.paused;
    if (typeof paused !== 'boolean') return res.status(400).json({ error: 'paused must be true or false' });
    try {
      const state = await video.setPaused(paused, { by: who(req) });
      console.log(`[GROSS-RACE] celebration video ${paused ? 'paused' : 'resumed'} by ${who(req) || 'an admin'}`);
      return res.json({ ok: true, paused: state.paused, pausedChangedAt: state.changedAt, pausedChangedBy: state.changedBy });
    } catch (err) {
      console.error('[GROSS-RACE] saving the pause failed:', err.message);
      return res.status(500).json({ error: 'Failed to save the pause' });
    }
  });

  router.delete('/api/gross-race/video', authMiddleware, async (req, res) => {
    try {
      const deleted = await video.deleteVideo();
      if (deleted) console.log(`[GROSS-RACE] celebration video deleted by ${who(req) || 'an admin'}`);
      return res.json({ ok: true, deleted });
    } catch (err) {
      console.error('[GROSS-RACE] deleting the video failed:', err.message);
      return res.status(500).json({ error: 'Failed to delete the video' });
    }
  });

  return router;
}

module.exports = { createGrossRaceRoutes };
