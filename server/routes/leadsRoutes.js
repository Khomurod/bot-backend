/**
 * Leads listing (Facebook + Indeed) for the admin "Leads" tab.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definition.
 */
const express = require('express');

function createLeadsRoutes({ db, authMiddleware }) {
  const router = express.Router();

  router.get('/api/leads', authMiddleware, async (req, res) => {
    try {
      const source = req.query.source === 'facebook' || req.query.source === 'indeed'
        ? req.query.source
        : null;
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 100;
      const leads = await db.listLeads(limit, source);
      res.json(leads);
    } catch (err) {
      console.error('[API] Error fetching leads:', err.message);
      res.status(500).json({ error: 'Failed to fetch leads' });
    }
  });

  return router;
}

module.exports = { createLeadsRoutes };
