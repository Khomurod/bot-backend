const express = require('express');
const multer = require('multer');
const rc = require('../../database/routeControl');
const routeControl = require('../../services/routeControlService');
const gmaps = require('../../database/gmapsSettings');

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

/**
 * Basic file-signature (magic bytes) check so a renamed non-image can't get in
 * on a spoofed Content-Type alone. PNG: \x89PNG. JPEG: FF D8 FF. WEBP:
 * "RIFF"…"WEBP". Returns true when the bytes plausibly match ANY allowed type
 * (the claimed MIME already passed the fileFilter).
 */
function looksLikeAllowedImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true; // PNG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true; // JPEG
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return true; // WEBP
  return false;
}

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
 *   POST   /:id/send-driver-message → send a NEW route message (+ screenshot) to the driver group
 *   POST   /:id/update-driver-message → EDIT the already-sent route message(s) in place (no new message)
 *   POST   /:id/screenshot          → upload/replace the route screenshot (multipart `screenshot`);
 *                                     edits the already-sent message in place, never posts a new one
 *   GET    /:id/screenshot          → the stored screenshot bytes (auth-gated preview)
 *   DELETE /:id/screenshot          → remove the stored screenshot; edits the sent message in place
 *   POST   /:id/start-tracking      → manually start tracking for a pending route
 *   POST   /:id/run-completion-check → destination-completion check for one route (no warnings)
 *   POST   /run-completion-check    → destination-completion reconciliation over all active routes
 *   POST   /:id/cancel              → mark cancelled
 *   POST   /:id/complete            → mark completed
 */
function createRouteControlRouter({ authMiddleware, telegram = null, mediaTelegram = null }) {
  const router = express.Router();

  /** Admin display name for audit trails (never an internal id). */
  function adminName(req) {
    return req.admin?.username || req.admin?.email || 'admin';
  }

  /**
   * After a screenshot storage change (upload/replace/remove), update the
   * ALREADY-SENT driver-group route message IN PLACE — never a new message, so
   * the driver group is not spammed. Media edits go through the dedicated
   * fresh-socket client so a transient reset is retried on a clean connection.
   * Returns a structured status object for the Admin portal; a Telegram-side
   * failure is reported, never thrown (storage already succeeded). When the
   * route was never sent, it is a storage-only no-op.
   */
  async function maybeUpdateSentMessage(id, assignment) {
    if (!assignment || !assignment.driver_group_message_sent_at) {
      return {
        ok: false, updated: false, code: 'NOT_SENT', status: 'not_sent',
        detail: 'No route message has been sent to the driver group yet — the stored route was updated only.',
      };
    }
    try {
      return await routeControl.updateDriverGroupRouteMessage({ assignmentId: id, telegram, mediaTelegram });
    } catch (err) {
      return { ok: false, updated: false, code: err.code || 'UPDATE_ERROR', status: 'failed', error: err.message };
    }
  }

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      const assignments = await rc.listRouteAssignments({ status });
      // Current completion radius rides along so the UI can explain the
      // distance diagnostics ("52.4 mi from destination, completes at 50").
      let completionRadiusMiles = null;
      try { completionRadiusMiles = (await gmaps.getGmapsConfig()).routeCompletionRadiusMiles; } catch (_) { /* optional */ }
      res.json({ assignments, completionRadiusMiles });
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
      // in a `payload` field next to the `screenshot` file. The payload is
      // parsed whenever it is present — a multipart request whose file part was
      // dropped must still assign the route (partial success), not fail with a
      // confusing "no group" error.
      let body = req.body || {};
      if (typeof body.payload === 'string') {
        try {
          body = JSON.parse(body.payload);
        } catch (_) {
          return res.status(400).json({ error: 'Invalid multipart payload JSON.', code: 'BAD_PAYLOAD' });
        }
      }
      // Server-side signature check on top of the MIME filter.
      if (req.file && !looksLikeAllowedImage(req.file.buffer)) {
        return res.status(400).json({
          error: 'The uploaded file does not look like a PNG, JPG or WEBP image.',
          code: 'SCREENSHOT_TYPE_UNSUPPORTED',
        });
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

  // Upload/replace the route screenshot for an existing assignment. Replacement
  // is an atomic UPSERT — a failed upload can never destroy the stored one.
  // NEVER posts a new Telegram message: when the route was already delivered, it
  // EDITS the existing message(s) in place so the driver group is not spammed.
  router.post('/:id/screenshot', authMiddleware, uploadErrorsAsJson(screenshotUpload.single('screenshot')), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!req.file) return res.status(400).json({ error: 'Attach a screenshot file.', code: 'SCREENSHOT_FILE_MISSING' });
      if (!looksLikeAllowedImage(req.file.buffer)) {
        return res.status(400).json({
          error: 'The uploaded file does not look like a PNG, JPG or WEBP image.',
          code: 'SCREENSHOT_TYPE_UNSUPPORTED',
        });
      }
      const assignment = await rc.getRouteAssignment(id);
      if (!assignment) return res.status(404).json({ error: 'Route assignment not found' });
      const saved = await rc.saveRouteScreenshot(id, {
        mimeType: req.file.mimetype,
        data: req.file.buffer,
        uploadedBy: adminName(req),
      });
      const result = {
        stored: true,
        sizeBytes: saved.file_size_bytes,
        mimeType: saved.mime_type,
        screenshot: { stored: true, operation: assignment.has_screenshot ? 'replaced' : 'stored' },
        newMessageSent: false,
      };
      result.telegram = await maybeUpdateSentMessage(id, assignment);
      return res.json(result);
    } catch (err) {
      console.error('[ROUTE-CONTROL API] screenshot upload failed:', err.message);
      return res.status(500).json({ error: 'Failed to store the screenshot', code: 'SCREENSHOT_DB_SAVE_FAILED' });
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
      const id = parseInt(req.params.id, 10);
      // Read the delivery state BEFORE deleting so we know whether to update the
      // already-sent message. Removing a screenshot never posts a new message.
      const assignment = await rc.getRouteAssignment(id);
      const result = await rc.deleteRouteScreenshot(id);
      result.screenshot = { stored: false, operation: 'removed' };
      result.newMessageSent = false;
      result.telegram = await maybeUpdateSentMessage(id, assignment);
      return res.json(result);
    } catch (err) {
      console.error('[ROUTE-CONTROL API] screenshot delete failed:', err.message);
      return res.status(500).json({ error: 'Failed to remove the screenshot' });
    }
  });

  // Destination-completion reconciliation over ALL active routes — same service
  // logic as the automatic monitor, never sends off-route warnings.
  router.post('/run-completion-check', authMiddleware, async (req, res) => {
    try {
      const result = await routeControl.runCompletionCheckNow();
      return res.json(result);
    } catch (err) {
      console.error('[ROUTE-CONTROL API] run-completion-check failed:', err.message);
      return res.status(err.status || 500).json({ error: err.message, code: err.code || 'COMPLETION_CHECK_ERROR' });
    }
  });

  // Destination-completion check for ONE route ("Run completion check now").
  router.post('/:id/run-completion-check', authMiddleware, async (req, res) => {
    try {
      const result = await routeControl.runCompletionCheckNow({ assignmentId: parseInt(req.params.id, 10) });
      return res.json(result);
    } catch (err) {
      console.error('[ROUTE-CONTROL API] run-completion-check failed:', err.message);
      return res.status(err.status || 500).json({ error: err.message, code: err.code || 'COMPLETION_CHECK_ERROR' });
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

  // Explicit "Send route message" / "Send as new message" — the ONLY path that
  // posts a NEW Telegram message. Never triggered by a screenshot change.
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

  // Explicit "Update message in Telegram" / retry-edit — edits the ALREADY-SENT
  // route message(s) in place. Never posts a new message. Used by the admin to
  // push a text edit (or retry a failed in-place edit) without spamming.
  router.post('/:id/update-driver-message', authMiddleware, async (req, res) => {
    try {
      const result = await routeControl.updateDriverGroupRouteMessage({
        assignmentId: parseInt(req.params.id, 10),
        telegram,
        mediaTelegram,
        customMessage: req.body?.message ? String(req.body.message) : null,
      });
      res.json(result);
    } catch (err) {
      console.error('[ROUTE-CONTROL API] update-driver-message failed:', err.message);
      res.status(err.status || 400).json({ error: err.message, code: err.code || 'UPDATE_ERROR' });
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
