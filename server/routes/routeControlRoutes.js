const express = require('express');
const rc = require('../../database/routeControl');
const routeControl = require('../../services/routeControlService');

/**
 * Route Control admin API.
 *   GET    /                        → list route assignments (?status=active|completed|cancelled)
 *   GET    /:id                     → one assignment + its recent monitor events
 *   POST   /                        → assign a route { groupId, url, manual?, sendToDriverGroup? }
 *   POST   /parse                   → test-parse a Google Maps link (no store) { url }
 *   POST   /:id/compute             → compute/recompute geometry for an assignment
 *   POST   /:id/send-driver-message → send/re-send the route message to the driver group
 *   POST   /:id/cancel              → mark cancelled
 *   POST   /:id/complete            → mark completed
 */
function createRouteControlRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();

  /** Admin display name for audit trails (never an internal id). */
  function adminName(req) {
    return req.admin?.username || req.admin?.email || 'admin';
  }

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
      const by = adminName(req);
      const result = await routeControl.assignRoute({
        groupId: req.body?.groupId,
        url: req.body?.url,
        manual: req.body?.manual || null,
        assignedBy: by,
      });

      // Optional send-on-assign. A Telegram send failure must NOT fail the
      // assignment — return partial success so the UI can say "assigned, but not
      // sent" and offer a manual re-send.
      if (req.body?.sendToDriverGroup && result?.assignment?.id) {
        try {
          const send = await routeControl.sendDriverGroupRouteMessage({
            assignmentId: result.assignment.id,
            telegram,
            sentBy: by,
          });
          result.driverMessage = { ...send };
        } catch (sendErr) {
          console.error('[ROUTE-CONTROL API] send-on-assign failed:', sendErr.message);
          result.driverMessage = {
            sent: false,
            error: sendErr.message,
            code: sendErr.code || 'SEND_ERROR',
          };
        }
      }
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message, code: err.code || 'ASSIGN_ERROR' });
    }
  });

  router.post('/:id/send-driver-message', authMiddleware, async (req, res) => {
    try {
      const send = await routeControl.sendDriverGroupRouteMessage({
        assignmentId: parseInt(req.params.id, 10),
        telegram,
        sentBy: adminName(req),
        customMessage: req.body?.message ? String(req.body.message) : null,
      });
      res.json(send);
    } catch (err) {
      console.error('[ROUTE-CONTROL API] send-driver-message failed:', err.message);
      res.status(err.status || 400).json({ error: err.message, code: err.code || 'SEND_ERROR' });
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
