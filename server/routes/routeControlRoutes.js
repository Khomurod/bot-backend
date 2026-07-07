const express = require('express');
const rc = require('../../database/routeControl');
const routeControl = require('../../services/routeControlService');

/**
 * Route Control admin API.
 *   GET    /                 → list route assignments (?status=active|completed|cancelled)
 *   GET    /:id              → one assignment + its recent monitor events
 *   POST   /                 → assign a route { groupId, url, manual? }
 *   POST   /parse            → test-parse a Google Maps link (no store) { url }
 *   POST   /:id/compute      → compute/recompute geometry for an assignment
 *   POST   /:id/cancel       → mark cancelled
 *   POST   /:id/complete     → mark completed
 */
function createRouteControlRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      const assignments = await rc.listRouteAssignments({ status });
      res.json({ assignments });
    } catch (err) {
      console.error('[ROUTE-CONTROL API] list failed:', err.message);
      res.status(500).json({ error: 'Failed to load route assignments' });
    }
  });

  router.get('/:id', authMiddleware, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const assignment = await rc.getRouteAssignment(id);
      if (!assignment) return res.status(404).json({ error: 'Route assignment not found' });
      const events = await rc.listRouteMonitorEvents(id);
      return res.json({ assignment, events });
    } catch (err) {
      console.error('[ROUTE-CONTROL API] detail failed:', err.message);
      return res.status(500).json({ error: 'Failed to load route assignment' });
    }
  });

  router.post('/parse', authMiddleware, async (req, res) => {
    try {
      const parsed = await routeControl.parseRouteLink(String(req.body?.url || ''));
      res.json({ parsed });
    } catch (err) {
      res.status(err.status || 422).json({ error: err.message, code: err.code || 'PARSE_ERROR' });
    }
  });

  router.post('/', authMiddleware, async (req, res) => {
    try {
      const result = await routeControl.assignRoute({
        groupId: req.body?.groupId,
        url: req.body?.url,
        manual: req.body?.manual || null,
        assignedBy: req.user?.username || req.user?.email || 'admin',
      });
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message, code: err.code || 'ASSIGN_ERROR' });
    }
  });

  router.post('/:id/compute', authMiddleware, async (req, res) => {
    try {
      const assignment = await routeControl.computeGeometryForAssignment(parseInt(req.params.id, 10));
      res.json({ assignment });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message, code: err.code || 'COMPUTE_ERROR' });
    }
  });

  router.post('/:id/cancel', authMiddleware, async (req, res) => {
    try {
      const assignment = await rc.setRouteAssignmentStatus(parseInt(req.params.id, 10), 'cancelled');
      if (!assignment) return res.status(404).json({ error: 'Route assignment not found' });
      await rc.insertRouteMonitorEvent({ assignmentId: assignment.id, eventType: 'cancelled' });
      return res.json({ assignment });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/complete', authMiddleware, async (req, res) => {
    try {
      const assignment = await rc.setRouteAssignmentStatus(parseInt(req.params.id, 10), 'completed');
      if (!assignment) return res.status(404).json({ error: 'Route assignment not found' });
      await rc.insertRouteMonitorEvent({ assignmentId: assignment.id, eventType: 'completed' });
      return res.json({ assignment });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createRouteControlRouter };
