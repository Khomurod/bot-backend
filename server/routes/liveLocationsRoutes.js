const express = require('express');
const config = require('../../config/config');
const liveLocations = require('../../services/liveLocationsService');
const dupReports = require('../../database/duplicateUnitReports');
const duplicateUnitCheck = require('../../services/duplicateUnitCheckService');

/**
 * Live Locations admin API (admin-auth required on every route):
 *   - GET /snapshot        → normalized map-ready snapshot of all active units
 *   - GET /route?unit=1234 → precise routed ETA + route line for one unit
 *   - GET /config          → map tile provider config (no secrets in the bundle)
 *
 * The frontend never talks to Samsara / Datatruck / ELD / routing providers
 * directly — the backend collects, normalizes, and caches everything.
 */
function createLiveLocationsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/snapshot', authMiddleware, async (req, res) => {
    try {
      const force = req.query.force === 'true' || req.query.force === '1';
      const snapshot = await liveLocations.getSnapshot({ force });
      res.json(snapshot);
    } catch (err) {
      console.error('[LIVE-LOCATIONS API] snapshot failed:', err.message);
      res.status(500).json({ error: 'Failed to build live locations snapshot' });
    }
  });

  router.get('/route', authMiddleware, async (req, res) => {
    try {
      const unit = typeof req.query.unit === 'string' ? req.query.unit : '';
      if (!unit.trim()) return res.status(400).json({ error: 'unit is required' });
      const route = await liveLocations.getRouteForUnit(unit);
      res.json(route);
    } catch (err) {
      console.error('[LIVE-LOCATIONS API] route failed:', err.message);
      res.status(500).json({ error: 'Failed to build route' });
    }
  });

  // Map tile configuration. The tile URL / token lives in backend env and is
  // only served to authenticated admins, so no map key is baked into the public
  // frontend bundle. Falls back to OpenStreetMap when nothing is configured.
  router.get('/config', authMiddleware, (req, res) => {
    const tileUrl = config.mapTileUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const attribution = config.mapTileAttribution
      || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    res.json({
      provider: 'leaflet',
      tileUrl,
      attribution,
      maxZoom: 19,
    });
  });

  // ─── Duplicate truck-number sanity check (admin review) ───

  router.get('/duplicate-reports', authMiddleware, async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'open';
      const reports = await dupReports.listDuplicateUnitReports({ status });
      res.json({ reports });
    } catch (err) {
      console.error('[LIVE-LOCATIONS API] duplicate-reports failed:', err.message);
      res.status(500).json({ error: 'Failed to load duplicate unit reports' });
    }
  });

  // Run the scan on demand (in addition to the 15-minute schedule).
  router.post('/duplicate-reports/scan', authMiddleware, async (req, res) => {
    try {
      const summary = await duplicateUnitCheck.runDuplicateUnitCheck();
      res.json({ summary });
    } catch (err) {
      console.error('[LIVE-LOCATIONS API] duplicate scan failed:', err.message);
      res.status(500).json({ error: 'Failed to run duplicate unit scan' });
    }
  });

  router.post('/duplicate-reports/:id/resolve', authMiddleware, async (req, res) => {
    try {
      const report = await dupReports.resolveDuplicateUnitReport(parseInt(req.params.id, 10));
      if (!report) return res.status(404).json({ error: 'Report not found' });
      return res.json({ report });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createLiveLocationsRouter };
