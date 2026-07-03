const express = require('express');
const {
  getEldSettingsForAdmin,
  updateEldSettings,
  getEldConfig,
  looksLikeDocsUrl,
  DEFAULT_DRIVEHOS_API_BASE,
} = require('../../database/eldSettings');
const { fetchAllVehicleStats } = require('../../services/samsaraLocationService');
const {
  fetchAllLatestVehicleStatuses,
  getLiveLocationForGroupTitleFromDriveHos,
} = require('../../services/driveHosEldService');
const { getLiveLocationForGroupTitle } = require('../../services/samsaraLocationService');
const rc = require('../../database/ringcentral');
const {
  getAccessToken,
  getExtensionInfo,
  fetchAccountCallLog,
  fetchExtensionCallLog,
} = require('../../services/ringCentralCallService');
const { DateTime } = require('luxon');

/**
 * Admin Settings API — manage live-location provider credentials.
 *   GET  /            → masked settings (never returns raw secrets)
 *   PUT  /            → update settings (secrets encrypted at rest)
 *   POST /test        → live connectivity check for one provider
 *
 * The "test" endpoint validates a provider's credentials against the live API.
 * It uses candidate keys from the request body when supplied (so the operator
 * can verify a key BEFORE saving it), otherwise the currently-stored keys.
 */
function createSettingsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/eld', authMiddleware, async (req, res) => {
    try {
      const settings = await getEldSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] load failed:', err.message);
      res.status(500).json({ error: 'Failed to load settings' });
    }
  });

  router.put('/eld', authMiddleware, async (req, res) => {
    try {
      const settings = await updateEldSettings(req.body || {});
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] update failed:', err.message);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  router.post('/eld/test', authMiddleware, async (req, res) => {
    const provider = String(req.body?.provider || '').toLowerCase();
    const groupTitle = String(req.body?.groupTitle || '').trim();
    try {
      const cfg = await getEldConfig();

      if (provider === 'samsara') {
        const apiKey = String(req.body?.apiKey || '').trim() || cfg.samsaraApiKeys[0] || '';
        if (!apiKey) {
          return res.json({ connected: false, message: 'No Samsara API key set.' });
        }
        if (groupTitle) {
          const loc = await getLiveLocationForGroupTitle({ groupTitle, apiKey, apiBase: cfg.samsaraApiBase });
          return res.json({
            connected: true,
            message: `Found unit ${loc.unitNumber} at ${loc.address || `${loc.latitude}, ${loc.longitude}`}.`,
          });
        }
        const vehicles = await fetchAllVehicleStats({ apiKey, apiBase: cfg.samsaraApiBase });
        return res.json({ connected: true, message: `Connected. ${vehicles.length} vehicle(s) visible.` });
      }

      if (provider === 'factor' || provider === 'leader') {
        const label = provider === 'factor' ? 'Factor ELD' : 'Leader ELD';
        const companyKeyLabel = provider === 'factor' ? 'Factor Company Key' : 'Leader Company Key';
        const providerKey = String(req.body?.providerKey || '').trim() || cfg.driveHosProviderKey || '';
        const companyKey = String(req.body?.companyKey || '').trim()
          || (provider === 'factor' ? cfg.factorCompanyKey : cfg.leaderCompanyKey) || '';

        // The base URL comes from the body override (verify-before-save) or the
        // stored value. Reject a Swagger/docs URL up front — it will never work.
        const configuredBase = (String(req.body?.apiBase || '').trim() || cfg.driveHosApiBaseConfigured || '')
          .replace(/\/+$/, '');

        // Field-level validation with clear, specific messages.
        if (!providerKey) {
          return res.json({ connected: false, message: `Provider Key is required before testing ${label}.` });
        }
        if (!configuredBase) {
          return res.json({ connected: false, message: `API Base URL is required before testing ${label}.` });
        }
        if (looksLikeDocsUrl(configuredBase)) {
          return res.json({
            connected: false,
            message: 'This looks like a documentation URL, not the actual API base URL. '
              + `Set the API Base URL to the real API host (e.g. ${DEFAULT_DRIVEHOS_API_BASE}).`,
          });
        }
        if (!companyKey) {
          return res.json({ connected: false, message: `${companyKeyLabel} is required before testing ${label}.` });
        }

        const apiBase = configuredBase;
        if (groupTitle) {
          const loc = await getLiveLocationForGroupTitleFromDriveHos({
            groupTitle,
            providerKey,
            companyKey,
            apiBase,
            providerLabel: label,
          });
          return res.json({
            connected: true,
            message: `Found unit ${loc.unitNumber} at ${loc.address || `${loc.latitude}, ${loc.longitude}`}.`,
          });
        }
        const vehicles = await fetchAllLatestVehicleStatuses({ providerKey, companyKey, apiBase });
        return res.json({ connected: true, message: `Connected. ${vehicles.length} vehicle(s) visible.` });
      }

      return res.status(400).json({ error: 'Unknown provider. Use samsara, factor, or leader.' });
    } catch (err) {
      console.error(`[SETTINGS API] test ${provider} failed:`, err.message);
      return res.json({ connected: false, message: err.message });
    }
  });

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

module.exports = { createSettingsRouter };
