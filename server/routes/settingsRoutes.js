const express = require('express');
const {
  getEldSettingsForAdmin,
  updateEldSettings,
  getEldConfig,
} = require('../../database/eldSettings');
const { fetchAllVehicleStats } = require('../../services/samsaraLocationService');
const {
  fetchAllLatestVehicleStatuses,
  getLiveLocationForGroupTitleFromDriveHos,
} = require('../../services/driveHosEldService');
const { getLiveLocationForGroupTitle } = require('../../services/samsaraLocationService');

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
        const providerKey = String(req.body?.providerKey || '').trim() || cfg.driveHosProviderKey || '';
        const companyKey = String(req.body?.companyKey || '').trim()
          || (provider === 'factor' ? cfg.factorCompanyKey : cfg.leaderCompanyKey) || '';
        const label = provider === 'factor' ? 'Factor ELD' : 'Leader ELD';
        if (!providerKey) {
          return res.json({ connected: false, message: 'No Drive HoS provider key set.' });
        }
        if (!companyKey) {
          return res.json({ connected: false, message: `No ${label} company key set.` });
        }
        if (groupTitle) {
          const loc = await getLiveLocationForGroupTitleFromDriveHos({
            groupTitle,
            providerKey,
            companyKey,
            apiBase: cfg.driveHosApiBase,
            providerLabel: label,
          });
          return res.json({
            connected: true,
            message: `Found unit ${loc.unitNumber} at ${loc.address || `${loc.latitude}, ${loc.longitude}`}.`,
          });
        }
        const vehicles = await fetchAllLatestVehicleStatuses({ providerKey, companyKey, apiBase: cfg.driveHosApiBase });
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

module.exports = { createSettingsRouter };
