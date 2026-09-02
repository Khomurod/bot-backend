/**
 * ELD provider settings (Samsara, Factor, Leader) — admin API.
 *
 * The admin panel is the PRIMARY home for these credentials; the matching env
 * vars are only a fallback used when the panel has no value. Keys are stored
 * encrypted and never returned in full — reads mask them.
 *
 * The `/eld/test` endpoint validates candidate keys from the request body when
 * supplied, so an operator can verify a key BEFORE saving it, otherwise the
 * stored ones.
 *
 * Split out of server/routes/settingsRoutes.js.
 */

const express = require('express');
const {
  getEldSettingsForAdmin,
  updateEldSettings,
  getEldConfig,
  looksLikeDocsUrl,
  DEFAULT_DRIVEHOS_API_BASE,
} = require('../../../database/eldSettings');
const {
  fetchAllVehicleStats, getLiveLocationForGroupTitle,
} = require('../../../services/samsaraLocationService');
const {
  fetchAllLatestVehicleStatuses,
  getLiveLocationForGroupTitleFromDriveHos,
} = require('../../../services/driveHosEldService');

function createEldSettingsRouter({ authMiddleware, telegram = null }) {
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

  return router;
}

module.exports = { createEldSettingsRouter };
