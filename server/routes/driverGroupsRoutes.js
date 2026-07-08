/**
 * Driver-group admin routes: list/manage groups, AI status classification,
 * manual status/language/birthday updates, and the driver-list used by the
 * broadcast targeting UI.
 *
 * Routes use their full paths; the router is mounted at the app root, AFTER
 * the group-members router (which only defines /api/groups/:groupId/members),
 * so matching behavior is identical to the previous inline definitions.
 */
const express = require('express');
const { runClassificationRun } = require('../../services/groupStatusAiService');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createDriverGroupsRoutes({ db, authMiddleware }) {
  const router = express.Router();

  // GET /api/groups
  router.get('/api/groups', authMiddleware, async (req, res) => {
    try {
      const groups = await db.getAllGroups();
      res.json(groups);
    } catch (err) {
      console.error('[API] Error fetching groups:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

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

  // GET /api/groups/driver-list — all driver groups for targeting UI
  router.get('/api/groups/driver-list', authMiddleware, async (req, res) => {
    try {
      const groups = await db.getAllDriverGroups();
      res.json(groups);
    } catch (err) {
      console.error('[API] Error fetching driver groups:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/groups/status/run-now — trigger AI status classification (skips manual-locked groups)
  router.post('/api/groups/status/run-now', authMiddleware, async (req, res) => {
    try {
      const result = await runClassificationRun();
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[API] Error running group status AI:', err.message);
      res.status(500).json({ error: err.message || 'Classification run failed' });
    }
  });

  // PUT /api/groups/:id/status — manual active/inactive (locked from AI)
  router.put('/api/groups/:id/status', authMiddleware, async (req, res) => {
    try {
      const { active } = req.body;
      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'active must be a boolean' });
      }
      const group = await db.setGroupStatusByAdmin(req.params.id, active);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      res.json(group);
    } catch (err) {
      console.error('[API] Error updating group status:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // PUT /api/groups/:id/language
  router.put('/api/groups/:id/language', authMiddleware, async (req, res) => {
    try {
      const { language } = req.body;
      if (!['en', 'ru', 'uz'].includes(language)) {
        return res.status(400).json({ error: 'Invalid language. Must be en, ru, or uz.' });
      }
      const group = await db.setGroupLanguage(req.params.id, language);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      res.json(group);
    } catch (err) {
      console.error('[API] Error updating group language:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // PUT /api/groups/:id/birthday
  router.put('/api/groups/:id/birthday', authMiddleware, async (req, res) => {
    try {
      const { birthday } = req.body || {};
      // Allow explicit null to clear, otherwise require strict YYYY-MM-DD.
      if (birthday !== null && birthday !== undefined) {
        if (typeof birthday !== 'string' || !ISO_DATE_RE.test(birthday)) {
          return res.status(400).json({ error: 'birthday must be a YYYY-MM-DD date or null' });
        }
        const d = new Date(birthday);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ error: 'birthday is not a valid calendar date' });
        }
      }
      const group = await db.setGroupBirthday(req.params.id, birthday ?? null);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      res.json(group);
    } catch (err) {
      console.error('[API] Error updating group birthday:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { createDriverGroupsRoutes };
