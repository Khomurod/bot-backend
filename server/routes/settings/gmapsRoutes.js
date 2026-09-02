/**
 * Google Maps Platform settings — admin API.
 *
 * Route Control's off-route warnings are GATED on this key being present and
 * valid: destination-completion detection always runs, but off-route warnings
 * stay off until Maps is configured (APP_BRIEF §7).
 *
 * Split out of server/routes/settingsRoutes.js.
 */

const express = require('express');
const gmaps = require('../../../database/gmapsSettings');
const googleMapsClient = require('../../../services/googleMapsClient');

function createGmapsSettingsRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();

  // ─── Google Maps Platform settings (Route Control) ───
  // The server API key is a secret: masked on GET, encrypted at rest, never
  // returned raw. Group IDs above are not secrets; the Google key is.

  router.get('/gmaps', authMiddleware, async (req, res) => {
    try {
      const settings = await gmaps.getGmapsSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] gmaps load failed:', err.message);
      res.status(500).json({ error: 'Failed to load Google Maps settings' });
    }
  });

  router.put('/gmaps', authMiddleware, async (req, res) => {
    try {
      const settings = await gmaps.updateGmapsSettings(req.body || {});
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] gmaps update failed:', err.message);
      res.status(500).json({ error: 'Failed to save Google Maps settings' });
    }
  });

  // Live "Test connection" — uses a candidate key from the body (verify before
  // saving) or the stored key. Never echoes the key back.
  router.post('/gmaps/test', authMiddleware, async (req, res) => {
    try {
      const apiKey = String(req.body?.apiKey || '').trim() || undefined;
      const result = await googleMapsClient.testConnection({ apiKey });
      res.json(result);
    } catch (err) {
      console.error('[SETTINGS API] gmaps test failed:', err.message);
      res.json({ connected: false, message: err.message });
    }
  });

  return router;
}

module.exports = { createGmapsSettingsRouter };
