/**
 * Leads listing (Facebook + Indeed) for the admin "Leads" tab.
 *
 * The page polls every 45 seconds, and nearly every poll finds the list it
 * already has. So the route reads the list's fingerprint first (one md5,
 * database/leads.js), sends it as a strong ETag, and answers 304 with no body
 * — WITHOUT reading the list — when If-None-Match already names it. An idle
 * poll then costs the database a 32-character answer instead of a page of
 * leads.
 *
 * THE FINGERPRINT IS READ BEFORE THE LIST. A write landing between the two
 * leaves a newer list under an older ETag, and the next poll re-reads it. The
 * reverse order could leave the browser holding a list that is missing that
 * write, under an ETag that keeps matching.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definition.
 */
const express = require('express');

/**
 * Whether an If-None-Match header names this ETag, compared as RFC 9110
 * §13.1.2 says: a comma-separated list, weak comparison (a `W/` prefix is
 * ignored, as a compressing proxy may add one), and `*` for any list.
 *
 * Deliberately NOT `req.fresh`. A browser whose script sets If-None-Match also
 * sends `Cache-Control: no-cache` (the Fetch standard switches such a request
 * to "no-store"), and `req.fresh` calls every request carrying that header
 * stale: it would never answer 304 to the one client this exists for.
 */
function ifNoneMatchNames(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

function createLeadsRoutes({ db, authMiddleware }) {
  const router = express.Router();

  router.get('/api/leads', authMiddleware, async (req, res) => {
    try {
      const source = req.query.source === 'facebook' || req.query.source === 'indeed'
        ? req.query.source
        : null;
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 100;
      const etag = `"${await db.getLeadListFingerprint(limit, source)}"`;
      if (ifNoneMatchNames(req.get('If-None-Match'), etag)) {
        return res.status(304).set('ETag', etag).end();
      }
      const leads = await db.listLeads(limit, source);
      return res.set('ETag', etag).json(leads);
    } catch (err) {
      console.error('[API] Error fetching leads:', err.message);
      return res.status(500).json({ error: 'Failed to fetch leads' });
    }
  });

  return router;
}

module.exports = { createLeadsRoutes };
