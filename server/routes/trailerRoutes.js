/**
 * Trailer Tracking (Beta) — Admin API.
 *
 * All routes require the admin JWT (authMiddleware). Mounted at /api/trailers.
 * The Admin Portal is the only place that can import a trailer master list;
 * FleetView gets read-only endpoints from the fleet router instead.
 */
const express = require('express');
const multer = require('multer');
const db = require('../../database/db');
const trailerImport = require('../../services/trailerImportService');
const config = require('../../config/config');
const { geocodePlace } = require('../../services/etaRoutingService');

// Screenshots held in memory while AI vision reads them; capped at 10 MB each.
const MAX_UPLOAD_MB = 10;
const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) return cb(null, true);
    return cb(new Error('Only PNG, JPG, or WebP images are allowed.'));
  },
});

function createTrailerRoutes({ authMiddleware, telegram = null }) {
  const router = express.Router();

  // ── Trailer master list ──────────────────────────────────────────────────
  router.get('/api/trailers', authMiddleware, async (req, res) => {
    try {
      const rows = await db.listTrailers({
        q: req.query.q || null,
        status: req.query.status || null,
        ownership: req.query.ownership || null,
        type: req.query.type || null,
        needs_review: req.query.needs_review === 'true',
      });
      res.json({ trailers: rows });
    } catch (err) {
      console.error('[TRAILER-API] list trailers failed:', err.message);
      res.status(500).json({ error: 'Failed to load trailers.' });
    }
  });

  router.get('/api/trailers/events', authMiddleware, async (req, res) => {
    try {
      const rows = await db.listTrailerEvents({
        event_type: req.query.event_type || null,
        trailer_id: req.query.trailer_id || null,
        limit: req.query.limit || 200,
      });
      res.json({ events: rows });
    } catch (err) {
      console.error('[TRAILER-API] list events failed:', err.message);
      res.status(500).json({ error: 'Failed to load trailer events.' });
    }
  });

  router.get('/api/trailers/unidentified', authMiddleware, async (req, res) => {
    try {
      const rows = await db.listUnidentifiedTrailerEvents({ includeResolved: req.query.includeResolved === 'true' });
      res.json({ events: rows });
    } catch (err) {
      console.error('[TRAILER-API] list unidentified failed:', err.message);
      res.status(500).json({ error: 'Failed to load unidentified messages.' });
    }
  });

  router.get('/api/trailers/map', authMiddleware, async (req, res) => {
    try {
      const rows = await db.listTrailerMapData();
      res.json({ trailers: rows });
    } catch (err) {
      console.error('[TRAILER-API] map failed:', err.message);
      res.status(500).json({ error: 'Failed to load trailer map data.' });
    }
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  router.get('/api/trailers/settings', authMiddleware, async (req, res) => {
    try {
      const settings = await db.getTrailerSettings();
      res.json({
        settings,
        effective_test_group_id: (settings.automatic_update_test_group_id || config.trailerTestGroupId || null),
      });
    } catch (err) {
      console.error('[TRAILER-API] get settings failed:', err.message);
      res.status(500).json({ error: 'Failed to load settings.' });
    }
  });

  router.put('/api/trailers/settings', authMiddleware, async (req, res) => {
    try {
      const settings = await db.updateTrailerSettings(req.body || {});
      res.json({ settings });
    } catch (err) {
      console.error('[TRAILER-API] update settings failed:', err.message);
      res.status(500).json({ error: 'Failed to update settings.' });
    }
  });

  // ── Single trailer + timeline ──────────────────────────────────────────────
  router.get('/api/trailers/:id', authMiddleware, async (req, res) => {
    try {
      const trailer = await db.getTrailerById(req.params.id);
      if (!trailer) return res.status(404).json({ error: 'Trailer not found.' });
      const status = await db.getTrailerCurrentStatus(trailer.id);
      res.json({ trailer, status });
    } catch (err) {
      console.error('[TRAILER-API] get trailer failed:', err.message);
      res.status(500).json({ error: 'Failed to load trailer.' });
    }
  });

  router.get('/api/trailers/:id/events', authMiddleware, async (req, res) => {
    try {
      const trailer = await db.getTrailerById(req.params.id);
      if (!trailer) return res.status(404).json({ error: 'Trailer not found.' });
      const events = await db.listTrailerTimeline(trailer.id, req.query.limit || 200);
      res.json({ events });
    } catch (err) {
      console.error('[TRAILER-API] trailer timeline failed:', err.message);
      res.status(500).json({ error: 'Failed to load trailer timeline.' });
    }
  });

  // Manual add / edit trailer record.
  router.post('/api/trailers', authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.unit_number || !String(body.unit_number).trim()) {
        return res.status(400).json({ error: 'unit_number is required.' });
      }
      const trailer = await db.upsertTrailerByUnitNumber({ ...body, source: body.source || 'admin_manual' });
      res.json({ trailer });
    } catch (err) {
      console.error('[TRAILER-API] create trailer failed:', err.message);
      res.status(500).json({ error: 'Failed to save trailer.' });
    }
  });

  router.put('/api/trailers/:id', authMiddleware, async (req, res) => {
    try {
      const existing = await db.getTrailerById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Trailer not found.' });
      // Edit by unit number (the stable key). Never overwrite with blanks.
      const trailer = await db.upsertTrailerByUnitNumber({ ...req.body, unit_number: existing.unit_number });
      res.json({ trailer });
    } catch (err) {
      console.error('[TRAILER-API] update trailer failed:', err.message);
      res.status(500).json({ error: 'Failed to update trailer.' });
    }
  });

  // ── Screenshot import ───────────────────────────────────────────────────────
  router.post('/api/trailers/import/screenshot', authMiddleware, (req, res) => {
    screenshotUpload.array('screenshots', 12)(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: `Each image must be under ${MAX_UPLOAD_MB} MB.` });
        }
        return res.status(400).json({ error: uploadErr.message });
      }
      try {
        if (!req.files || !req.files.length) {
          return res.status(400).json({ error: 'Upload at least one image.' });
        }
        const { batch, rows } = await trailerImport.extractAndStage(req.files, {
          uploadedBy: req.admin?.username || null,
          fileName: req.files.map((f) => f.originalname).join(', ').slice(0, 300),
        });
        res.json({ batch, rows });
      } catch (err) {
        const status = err.status || 500;
        console.error('[TRAILER-API] import screenshot failed:', err.message);
        res.status(status).json({ error: err.message || 'Failed to parse screenshot.' });
      }
    });
  });

  router.get('/api/trailers/import/batches', authMiddleware, async (req, res) => {
    try {
      const batches = await db.listImportBatches(req.query.limit || 50);
      res.json({ batches });
    } catch (err) {
      console.error('[TRAILER-API] list batches failed:', err.message);
      res.status(500).json({ error: 'Failed to load import history.' });
    }
  });

  router.get('/api/trailers/import/:batchId', authMiddleware, async (req, res) => {
    try {
      const batch = await db.getImportBatch(req.params.batchId);
      if (!batch) return res.status(404).json({ error: 'Import batch not found.' });
      res.json({ batch });
    } catch (err) {
      console.error('[TRAILER-API] get batch failed:', err.message);
      res.status(500).json({ error: 'Failed to load import batch.' });
    }
  });

  router.post('/api/trailers/import/:batchId/commit', authMiddleware, async (req, res) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
      if (!rows) return res.status(400).json({ error: 'rows array is required.' });
      const summary = await trailerImport.commitRows(req.params.batchId, rows);
      res.json({ summary });
    } catch (err) {
      console.error('[TRAILER-API] commit import failed:', err.message);
      res.status(500).json({ error: 'Failed to commit import.' });
    }
  });

  // ── Manual event registration + correction ─────────────────────────────────
  router.post('/api/trailers/events/manual', authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const unit = body.trailer_unit_number || body.unit_number;
      if (!unit) return res.status(400).json({ error: 'trailer_unit_number is required.' });
      if (!['pickup', 'dropoff'].includes(body.event_type)) {
        return res.status(400).json({ error: "event_type must be 'pickup' or 'dropoff'." });
      }
      const trailer = await db.ensureTrailerForDetection(unit);
      // Optional geocode of a provided location.
      let lat = body.location_lat ?? null;
      let lng = body.location_lng ?? null;
      if ((lat == null || lng == null) && body.location_text) {
        try {
          const geo = await geocodePlace(body.location_text);
          if (geo) { lat = geo.lat; lng = geo.lng; }
        } catch { /* keep text-only */ }
      }
      const { event, duplicate } = await db.insertTrailerEvent({
        trailer_id: trailer?.id || null,
        trailer_unit_number: unit,
        event_type: body.event_type,
        confidence: 100,
        driver_group_id: body.driver_group_id || null,
        driver_name: body.driver_name || null,
        reported_by_name: req.admin?.username || 'admin',
        location_text: body.location_text || null,
        location_lat: lat,
        location_lng: lng,
        location_missing: !body.location_text,
        condition_text: body.condition_text || null,
        event_time: body.event_time || new Date().toISOString(),
        source: 'admin_manual',
        beta_mode: false,
      });
      if (trailer && event) await db.applyEventToCurrentStatus(trailer, event);
      res.json({ event, duplicate });
    } catch (err) {
      console.error('[TRAILER-API] manual event failed:', err.message);
      res.status(500).json({ error: 'Failed to register event.' });
    }
  });

  router.put('/api/trailers/events/:id', authMiddleware, async (req, res) => {
    try {
      const event = await db.updateTrailerEvent(req.params.id, req.body || {});
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      // Re-derive current status if a pickup/dropoff was corrected.
      if (event.trailer_id && (event.event_type === 'pickup' || event.event_type === 'dropoff')) {
        const trailer = await db.getTrailerById(event.trailer_id);
        if (trailer) await db.applyEventToCurrentStatus(trailer, event);
      }
      res.json({ event });
    } catch (err) {
      console.error('[TRAILER-API] update event failed:', err.message);
      res.status(500).json({ error: 'Failed to update event.' });
    }
  });

  router.post('/api/trailers/unidentified/:id/resolve', authMiddleware, async (req, res) => {
    try {
      const event = await db.resolveTrailerEvent(req.params.id);
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      res.json({ event });
    } catch (err) {
      console.error('[TRAILER-API] resolve failed:', err.message);
      res.status(500).json({ error: 'Failed to resolve message.' });
    }
  });

  return router;
}

module.exports = { createTrailerRoutes };
