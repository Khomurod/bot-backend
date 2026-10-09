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
 * THE ETAG SENT WITH A LIST IS THAT LIST'S OWN. A list that has to be sent
 * comes back with its fingerprint from one statement, so one snapshot. Were
 * the ETag the fingerprint checked a moment earlier, a write landing in
 * between, and undone before the next poll, would leave the browser holding a
 * list that a 304 then keeps confirming.
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

/** A fingerprint as a strong ETag. */
const etagOf = (fingerprint) => `"${fingerprint}"`;

function createLeadsRoutes({ db, authMiddleware }) {
  const router = express.Router();

  router.get('/api/leads', authMiddleware, async (req, res) => {
    try {
      const source = req.query.source === 'facebook' || req.query.source === 'indeed'
        ? req.query.source
        : null;
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 100;
      const current = etagOf(await db.getLeadListFingerprint(limit, source));
      if (ifNoneMatchNames(req.get('If-None-Match'), current)) {
        return res.status(304).set('ETag', current).end();
      }
      const { leads, fingerprint } = await db.listLeadsWithFingerprint(limit, source);
      return res.set('ETag', etagOf(fingerprint)).json(leads);
    } catch (err) {
      console.error('[API] Error fetching leads:', err.message);
      return res.status(500).json({ error: 'Failed to fetch leads' });
    }
  });

  return router;
}

module.exports = { createLeadsRoutes };
