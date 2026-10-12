/**
 * GET /api/gross-race?view=teams|dispatchers — the Gross Grand Prix standings
 * behind the /dispatchteam and /dispatch displays.
 *
 * PUBLIC, like the recruiters' leaderboard (/api/recruiters/public-stats): the
 * screens hang in the office with nobody signed in. So the payload is kept to
 * names and race numbers (services/grossRace/standings.js says which), and the
 * Datatruck token never leaves the server. Answering never waits on Datatruck
 * and never reads the database: services/grossRace/feed.js holds the week.
 */
const express = require('express');

const VIEWS = new Set(['teams', 'dispatchers']);

function createGrossRaceRoutes({ feed }) {
  const router = express.Router();

  router.get('/api/gross-race', (req, res) => {
    const view = typeof req.query.view === 'string' ? req.query.view : '';
    if (!VIEWS.has(view)) return res.status(400).json({ error: 'view must be teams or dispatchers' });
    try {
      res.set('Cache-Control', 'no-store');
      return res.json(feed.getRace(view));
    } catch (err) {
      console.error('[GROSS-RACE] standings failed:', err.message);
      return res.status(500).json({ error: 'Failed to load the race' });
    }
  });

  return router;
}

module.exports = { createGrossRaceRoutes };
