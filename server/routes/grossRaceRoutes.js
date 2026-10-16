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
 * in, with full admin access only.
 */
const express = require('express');
const celebrationVideo = require('../../services/grossRace/celebrationVideo');

const VIEWS = new Set(['teams', 'dispatchers']);
const passThrough = (_req, _res, next) => next();

function createGrossRaceRoutes({ feed, racePageVersion = () => null, video = celebrationVideo, authMiddleware = passThrough }) {
  const router = express.Router();

  router.get('/api/gross-race', (req, res) => {
    const view = typeof req.query.view === 'string' ? req.query.view : '';
    if (!VIEWS.has(view)) return res.status(400).json({ error: 'view must be teams or dispatchers' });
    try {
      res.set('Cache-Control', 'no-store');
      return res.json({ ...feed.getRace(view), page: racePageVersion(), video: view === 'teams' && video.hasVideo() });
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
      console.log(`[GROSS-RACE] celebration video replaced (${bytes} bytes)`);
      return res.json({ ok: true, bytes });
    } catch (err) {
      if (err.code === 'TOO_LARGE') return res.status(413).json({ error: 'The video is too large (100 MB at most)' });
      if (err.code === 'EMPTY') return res.status(400).json({ error: 'The upload was empty' });
      console.error('[GROSS-RACE] saving the video failed:', err.message);
      return res.status(500).json({ error: 'Failed to save the video' });
    }
  });

  return router;
}

module.exports = { createGrossRaceRoutes };
