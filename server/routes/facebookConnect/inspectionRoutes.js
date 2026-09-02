/**
 * Admin-guarded inspection of the Facebook webhook queue: the recent-events log
 * and a manual retry of one event.
 *
 * Retry is deliberately idempotent at the service layer — the queue dedupes on
 * event_key — so a double-tap in the panel cannot deliver a lead twice.
 *
 * Split out of server/routes/facebookConnectRoutes.js.
 */
const express = require('express');
const {
  retryFacebookWebhookEvent,
  getFacebookWebhookLog,
} = require('../../../services/facebookWebhookService');

function createFacebookInspectionRoutes({ proxyAuthGuard }) {
  const router = express.Router();

  router.get('/leads-log', proxyAuthGuard, async (req, res) => {
    try {
      const entries = await getFacebookWebhookLog(50);
      res.json({ count: entries.length, entries });
    } catch (err) {
      console.error('[API] Error loading Facebook leads log:', err.message);
      res.status(500).json({ error: 'Failed to load Facebook leads log', detail: err.message });
    }
  });

  router.get('/retry/:id', proxyAuthGuard, async (req, res) => {
    try {
      const event = await retryFacebookWebhookEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ error: 'No Facebook webhook event found for that identifier' });
      }
      return res.json({ success: true, event });
    } catch (err) {
      console.error('[API] Error retrying Facebook webhook event:', err.message);
      return res.status(500).json({ error: 'Failed to retry Facebook webhook event', detail: err.message });
    }
  });

  return router;

  return router;
}

module.exports = { createFacebookInspectionRoutes };
