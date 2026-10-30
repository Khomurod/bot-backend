/**
 * Driver-group list for the admin's targeting pickers (Messages → Send
 * Message, Scheduled).
 *
 * The rest of this file — the old group list, the driver-list, manual
 * status / language / birthday writes and the "run AI status check now"
 * trigger — was removed on 2026-10-30: no screen called any of it. A driver's
 * language, birthday and status are edited on the Driver Groups popup through
 * `/api/driver-profiles/:id`, which copies them onto the group
 * (`database/driverProfiles.js` `syncGroupFromDriverProfile`), and the AI
 * status check keeps its twice-daily schedule (`group_status_ai`).
 *
 * Routes use their full paths; the router is mounted at the app root, AFTER
 * the group-members router (which only defines /api/groups/:groupId/members).
 */
const express = require('express');

function createDriverGroupsRoutes({ db, authMiddleware }) {
  const router = express.Router();

  // GET /api/groups/manage — all driver groups (active + inactive) for admin manage UI
  router.get('/api/groups/manage', authMiddleware, async (req, res) => {
    try {
      const groups = await db.getDriverGroupsByActiveFilter('all');
      res.json(groups);
    } catch (err) {
      console.error('[API] Error fetching manage groups:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { createDriverGroupsRoutes };
