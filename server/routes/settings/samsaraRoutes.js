/**
 * SAMSARA integration settings — admin API.
 *
 * One logical integration, one settings area: the connection (API key, base
 * URL, enabled), the safety-event operational switches, and the missing-video
 * recovery controls. The driver-group music overlay keeps its own sub-router
 * (`./safetyEventRoutes.js`) and its own `/safety-events*` paths — the Samsara
 * tab just renders both.
 *
 * The row is read by BOTH this app and the separate samsara-integration
 * poller over the shared database, which is why an operator can replace the
 * Samsara API key here instead of redeploying a Render service.
 *
 * THE KEY NEVER COMES BACK OUT. Reads mask it; `/samsara/test` exercises it
 * server-side, against a candidate from the request body when one is supplied
 * so a key can be verified BEFORE it is saved; and nothing here logs it.
 */

const express = require('express');
const {
  getSamsaraSettingsForAdmin,
  updateSamsaraSettings,
  getSamsaraConfig,
} = require('../../../database/samsaraSettings');
const {
  getSamsaraVideoRecoverySummary,
  listSamsaraVideoRecoveryJobs,
} = require('../../../database/samsaraVideoRecovery');
const { fetchAllVehicleStats } = require('../../../services/samsaraLocationService');

function createSamsaraSettingsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/samsara', authMiddleware, async (req, res) => {
    try {
      const [settings, recovery] = await Promise.all([
        getSamsaraSettingsForAdmin(),
        getSamsaraVideoRecoverySummary(),
      ]);
      res.json({ settings, recovery });
    } catch (err) {
      console.error('[SETTINGS API] samsara load failed:', err.message);
      res.status(500).json({ error: 'Failed to load Samsara settings' });
    }
  });

  router.put('/samsara', authMiddleware, async (req, res) => {
    try {
      const settings = await updateSamsaraSettings(req.body || {}, {
        updatedBy: req.admin?.username || null,
      });
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] samsara update failed:', err.message);
      res.status(500).json({ error: 'Failed to save Samsara settings' });
    }
  });

  // Verify a key without saving it: an operator can paste a replacement, prove
  // it works, and only then hit Save — so a bad paste never costs the working
  // credential.
  router.post('/samsara/test', authMiddleware, async (req, res) => {
    try {
      const cfg = await getSamsaraConfig();
      const candidate = String(req.body?.apiKey || '').trim();
      const apiKey = candidate || cfg.apiKey;
      const apiBase = String(req.body?.apiBase || '').trim().replace(/\/+$/, '') || cfg.apiBase;

      if (!apiKey) {
        return res.json({
          connected: false,
          message: cfg.apiKeyUnreadable
            ? 'A key is stored but this server cannot decrypt it. Enter the key again to re-save it.'
            : 'No Samsara API key is configured.',
        });
      }

      const vehicles = await fetchAllVehicleStats({ apiKey, apiBase });
      return res.json({
        connected: true,
        testedSaved: !candidate,
        message: `Connected. ${vehicles.length} vehicle(s) visible.`,
      });
    } catch (err) {
      // The message is Samsara's, which is what an operator needs; it carries
      // a status and a reason, never the key (it is only ever a header).
      console.error('[SETTINGS API] samsara test failed:', err.message);
      return res.json({ connected: false, message: err.message });
    }
  });

  // Missing-video recovery, as an operator sees it: what is waiting, what gave
  // up, and why. No signed media URLs, no payloads — see the data layer.
  router.get('/samsara/video-recovery', authMiddleware, async (req, res) => {
    try {
      const [summary, jobs] = await Promise.all([
        getSamsaraVideoRecoverySummary(),
        listSamsaraVideoRecoveryJobs({
          limit: Number(req.query.limit) || 50,
          status: req.query.status || null,
        }),
      ]);
      res.json({ ...summary, jobs });
    } catch (err) {
      console.error('[SETTINGS API] samsara video-recovery load failed:', err.message);
      res.status(500).json({ error: 'Failed to load video-recovery jobs' });
    }
  });

  return router;
}

module.exports = { createSamsaraSettingsRouter };
