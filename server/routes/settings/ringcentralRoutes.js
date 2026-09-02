/**
 * RingCentral credentials and recruiter KPI targets — admin API.
 *
 * Reads mask the secrets; only the test endpoint exercises them against the
 * live API. Writing the settings row invalidates the cache in
 * database/ringcentral/settings.js, which is that module's job — do not cache
 * these values here as well.
 *
 * Split out of server/routes/settingsRoutes.js.
 */

const express = require('express');
const { DateTime } = require('luxon');
const rc = require('../../../database/ringcentral');
const {
  getAccessToken,
  getExtensionInfo,
  fetchAccountCallLog,
  fetchExtensionCallLog,
} = require('../../../services/ringCentralCallService');

function createRingCentralSettingsRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();

  // ─── RingCentral settings (credentials + KPI targets/thresholds) ───

  router.get('/ringcentral', authMiddleware, async (req, res) => {
    try {
      const settings = await rc.getRcSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] RC load failed:', err.message);
      res.status(500).json({ error: 'Failed to load RingCentral settings' });
    }
  });

  router.put('/ringcentral', authMiddleware, async (req, res) => {
    try {
      const settings = await rc.updateRcSettings(req.body || {});
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] RC update failed:', err.message);
      res.status(500).json({ error: 'Failed to save RingCentral settings' });
    }
  });

  // Live auth + call-log read test. Uses candidate creds from the body when
  // supplied (verify before saving), otherwise the stored creds.
  router.post('/ringcentral/test', authMiddleware, async (req, res) => {
    try {
      const stored = await rc.getRcConfig();
      const cfg = {
        apiBase: (String(req.body?.apiBase || '').trim() || stored.apiBase).replace(/\/+$/, ''),
        clientId: String(req.body?.clientId || '').trim() || stored.clientId,
        clientSecret: String(req.body?.clientSecret || '').trim() || stored.clientSecret,
        jwtToken: String(req.body?.jwtToken || '').trim() || stored.jwtToken,
      };
      if (!cfg.clientId || !cfg.clientSecret || !cfg.jwtToken) {
        return res.json({ connected: false, message: 'RingCentral credentials are incomplete.' });
      }
      await getAccessToken(cfg);
      // Confirm call-log read scope by pulling the last 24h. Prefer the
      // company log; when the shared JWT isn't an admin (403) fall back to its
      // own extension log — the same strategy the background sync uses.
      const now = DateTime.now();
      const window = { dateFrom: now.minus({ hours: 24 }).toUTC().toISO(), dateTo: now.toUTC().toISO() };
      let scopeNote = 'company-wide call log';
      let records;
      try {
        records = await fetchAccountCallLog({ cfg, ...window });
      } catch (err) {
        if (err.status !== 403) throw err;
        records = await fetchExtensionCallLog({ cfg, ...window });
        const ext = await getExtensionInfo(cfg).catch(() => null);
        const owns = ext?.phoneNumbers?.length ? ` — this JWT covers ${ext.phoneNumbers.join(', ')}` : '';
        scopeNote = `this JWT's own extension only (not an admin)${owns}. Recruiters on other numbers need their own JWT`;
      }
      return res.json({
        connected: true,
        message: `Authenticated. Read ${records.length} call(s) from the last 24h via ${scopeNote}.`,
      });
    } catch (err) {
      console.error('[SETTINGS API] RC test failed:', err.message);
      return res.json({ connected: false, message: err.message });
    }
  });

  return router;
}

module.exports = { createRingCentralSettingsRouter };
