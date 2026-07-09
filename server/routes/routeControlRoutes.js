const express = require('express');
const multer = require('multer');
const rc = require('../../database/routeControl');
const routeControl = require('../../services/routeControlService');

// Route screenshots: common image types only, held in memory (they go straight
// to Postgres BYTEA / Telegram) and capped at 8 MB — Telegram's sendPhoto
// rejects photos over 10 MB anyway.
const SCREENSHOT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SCREENSHOT_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (SCREENSHOT_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid screenshot type: ${file.mimetype}. Allowed: jpg, png, webp.`));
  },
});

/** Wrap a multer middleware so its errors become clean JSON (not a 500 page). */
function uploadErrorsAsJson(middleware) {
  return (req, res, next) => middleware(req, res, (err) => {
    if (!err) return next();
    const tooLarge = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge
        ? `Screenshot is too large — the limit is ${Math.round(SCREENSHOT_MAX_BYTES / (1024 * 1024))} MB.`
        : err.message,
      code: tooLarge ? 'SCREENSHOT_TOO_LARGE' : 'SCREENSHOT_INVALID',
    });
  });
}

/**
 * Route Control admin API.
 *   GET    /                        → list route assignments (?status=active|completed|cancelled)
 *   GET    /:id                     → one assignment + its recent monitor events
 *   POST   /                        → assign a route { groupId, url, manual?, sendToDriverGroup?, tracking? }
 *                                     JSON, or multipart with a `screenshot` file + a `payload` JSON field
 *   POST   /parse                   → test-parse a Google Maps link (no store) { url }
 *   POST   /:id/compute             → compute/recompute geometry for an assignment
 *   POST   /:id/send-driver-message → send/re-send the route message (+ screenshot) to the driver group
 *   POST   /:id/screenshot          → upload/replace the route screenshot (multipart `screenshot`)
 *   GET    /:id/screenshot          → the stored screenshot bytes (auth-gated preview)
 *   DELETE /:id/screenshot          → remove the stored screenshot
 *   POST   /:id/start-tracking      → manually start tracking for a pending route
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

  router.post('/', authMiddleware, uploadErrorsAsJson(screenshotUpload.single('screenshot')), async (req, res) => {
    try {
      const by = adminName(req);
      // JSON body (unchanged legacy path), or multipart: the JSON payload rides
      // in a `payload` field next to the `screenshot` file.
      let body = req.body || {};
      if (req.file && typeof body.payload === 'string') {
        try {
          body = JSON.parse(body.payload);
        } catch (_) {
          return res.status(400).json({ error: 'Invalid multipart payload JSON.', code: 'BAD_PAYLOAD' });
        }
      }

      const result = await routeControl.assignRoute({
        groupId: body?.groupId,
        url: body?.url,
        manual: body?.manual || null,
        tracking: body?.tracking || null,
        assignedBy: by,
      });

      // Store the screenshot BEFORE the optional send so send-on-assign already
      // attaches it. A screenshot-store failure must not fail the assignment.
      if (req.file && result?.assignment?.id) {
        try {
          await rc.saveRouteScreenshot(result.assignment.id, {
            mimeType: req.file.mimetype,
            data: req.file.buffer,
            uploadedBy: by,
          });
          result.screenshot = { stored: true, sizeBytes: req.file.size };
        } catch (shotErr) {
          console.error('[ROUTE-CONTROL API] screenshot store failed:', shotErr.message);
          result.screenshot = { stored: false, error: shotErr.message };
        }
      }

      // Optional send-on-assign. A Telegram send failure must NOT fail the
      // assignment — return partial success so the UI can say "assigned, but not
      // sent" and offer a manual re-send.
      if (body?.sendToDriverGroup && result?.assignment?.id) {
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

  // Upload/replace the route screenshot for an existing assignment.
  router.post('/:id/screenshot', authMiddleware, uploadErrorsAsJson(screenshotUpload.single('screenshot')), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!req.file) return res.status(400).json({ error: 'Attach a screenshot file.', code: 'NO_FILE' });
      const assignment = await rc.getRouteAssignment(id);
      if (!assignment) return res.status(404).json({ error: 'Route assignment not found' });
      const saved = await rc.saveRouteScreenshot(id, {
        mimeType: req.file.mimetype,
        data: req.file.buffer,
        uploadedBy: adminName(req),
      });
      return res.json({ stored: true, sizeBytes: saved.file_size_bytes, mimeType: saved.mime_type });
    } catch (err) {
      console.error('[ROUTE-CONTROL API] screenshot upload failed:', err.message);
      return res.status(500).json({ error: 'Failed to store the screenshot' });
    }
  });

  // Auth-gated screenshot preview (bytes are never exposed publicly).
  router.get('/:id/screenshot', authMiddleware, async (req, res) => {
    try {
      const shot = await rc.getRouteScreenshot(parseInt(req.params.id, 10));
      if (!shot) return res.status(404).json({ error: 'No screenshot for this route' });
      res.setHeader('Content-Type', shot.mime_type || 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.end(shot.file_data);
    } catch (err) {
      console.error('[ROUTE-CONTROL API] screenshot fetch failed:', err.message);
      return res.status(500).json({ error: 'Failed to load the screenshot' });
    }
  });

  router.delete('/:id/screenshot', authMiddleware, async (req, res) => {
    try {
      const result = await rc.deleteRouteScreenshot(parseInt(req.params.id, 10));
      return res.json(result);
    } catch (err) {
      console.error('[ROUTE-CONTROL API] screenshot delete failed:', err.message);
      return res.status(500).json({ error: 'Failed to remove the screenshot' });
    }
  });

  // Manually start tracking for a pending route ("Start tracking now").
  router.post('/:id/start-tracking', authMiddleware, async (req, res) => {
    try {
      const result = await routeControl.startTrackingNow(parseInt(req.params.id, 10), adminName(req));
      return res.json(result);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code || 'TRACKING_ERROR' });
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
