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
const { geocodeTrailerLocation } = require('../../services/trailerGeocodeService');

// Screenshots are held in memory while AI vision reads them, so the batch size
// is bounded to protect the 256 MB heap / 512 MB Render instance. Before the
// follow-up this allowed 12 × 10 MB = 120 MB (a real OOM vector); now each file
// is ≤ 10 MB, at most MAX_UPLOAD_FILES files, AND the whole batch is capped at
// MAX_UPLOAD_TOTAL_MB regardless of per-file size.
const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_FILES = 4;
const MAX_UPLOAD_TOTAL_MB = 35;
const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_UPLOAD_FILES },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) return cb(null, true);
    return cb(new Error('Only PNG, JPG, or WebP images are allowed.'));
  },
});

/** Backfill geocoding is admin-triggered and bounded per run (never on boot). */
const GEOCODE_BACKFILL_MAX_PER_RUN = 25;

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
  // Includes the latest PENDING review event (and the previous confirmed one),
  // so the drawer can show "detected change" vs "current/previous confirmed".
  router.get('/api/trailers/:id', authMiddleware, async (req, res) => {
    try {
      const trailer = await db.getTrailerById(req.params.id);
      if (!trailer) return res.status(404).json({ error: 'Trailer not found.' });
      const status = await db.getTrailerCurrentStatus(trailer.id);
      const review = await db.getTrailerReviewContext(trailer.id);
      res.json({ trailer, status, review });
    } catch (err) {
      console.error('[TRAILER-API] get trailer failed:', err.message);
      res.status(500).json({ error: 'Failed to load trailer.' });
    }
  });

  // Recompute a trailer's current status from its (non-declined) event history.
  router.post('/api/trailers/:id/recompute-status', authMiddleware, async (req, res) => {
    try {
      const trailer = await db.getTrailerById(req.params.id);
      if (!trailer) return res.status(404).json({ error: 'Trailer not found.' });
      const status = await db.recomputeTrailerCurrentStatus(trailer.id);
      res.json({ status });
    } catch (err) {
      console.error('[TRAILER-API] recompute status failed:', err.message);
      res.status(500).json({ error: 'Failed to recompute status.' });
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
    screenshotUpload.array('screenshots', MAX_UPLOAD_FILES)(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: `Each image must be under ${MAX_UPLOAD_MB} MB.` });
        }
        if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ error: `Upload at most ${MAX_UPLOAD_FILES} images per batch.` });
        }
        return res.status(400).json({ error: uploadErr.message });
      }
      try {
        if (!req.files || !req.files.length) {
          return res.status(400).json({ error: 'Upload at least one image.' });
        }
        // Total-batch memory guard (protects the small Render heap even when each
        // file is individually under the per-file limit).
        const totalBytes = req.files.reduce((sum, f) => sum + (f.size || f.buffer?.length || 0), 0);
        if (totalBytes > MAX_UPLOAD_TOTAL_MB * 1024 * 1024) {
          return res.status(400).json({ error: `Total upload must be under ${MAX_UPLOAD_TOTAL_MB} MB per batch.` });
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
      // Optional geocode of a provided location (fail-soft, cached).
      let lat = body.location_lat ?? null;
      let lng = body.location_lng ?? null;
      let locationSource = (lat != null && lng != null) ? 'manual' : null;
      if ((lat == null || lng == null) && body.location_text) {
        const geo = await geocodeTrailerLocation(body.location_text, { enabled: true });
        if (geo && geo.lat != null) { lat = geo.lat; lng = geo.lng; locationSource = geo.source; }
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
        location_source: locationSource,
        location_missing: !body.location_text,
        condition_text: body.condition_text || null,
        event_time: body.event_time || new Date().toISOString(),
        review_status: 'accepted', // admin-entered events are confirmed
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

  // Accept the latest detected change for an event (clears review, keeps status).
  router.post('/api/trailers/events/:id/accept', authMiddleware, async (req, res) => {
    try {
      const event = await db.acceptTrailerEvent(req.params.id, {
        reviewedBy: req.admin?.username || 'admin',
        reviewNote: (req.body && req.body.note) || null,
      });
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      const status = event.trailer_id ? await db.getTrailerCurrentStatus(event.trailer_id) : null;
      res.json({ event, status });
    } catch (err) {
      console.error('[TRAILER-API] accept event failed:', err.message);
      res.status(500).json({ error: 'Failed to accept change.' });
    }
  });

  // Decline the latest detected change (kept in history; status recomputed from
  // the latest non-declined pickup/dropoff, restoring the previous status).
  router.post('/api/trailers/events/:id/decline', authMiddleware, async (req, res) => {
    try {
      const event = await db.declineTrailerEvent(req.params.id, {
        reviewedBy: req.admin?.username || 'admin',
        reviewNote: (req.body && req.body.note) || null,
      });
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      const status = event.trailer_id ? await db.getTrailerCurrentStatus(event.trailer_id) : null;
      res.json({ event, status });
    } catch (err) {
      console.error('[TRAILER-API] decline event failed:', err.message);
      res.status(500).json({ error: 'Failed to decline change.' });
    }
  });

  // Edit an event's fields (records who/when + a one-time original snapshot,
  // marks it 'edited') and recompute current status from the corrected timeline.
  router.put('/api/trailers/events/:id', authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      // If the admin supplied a location text but no coordinates, geocode it.
      if (body.location_text && body.location_lat == null && body.location_lng == null) {
        const geo = await geocodeTrailerLocation(body.location_text, { enabled: true });
        if (geo && geo.lat != null) {
          body.location_lat = geo.lat;
          body.location_lng = geo.lng;
          if (body.location_source == null) body.location_source = geo.source;
        }
      }
      const event = await db.updateTrailerEvent(req.params.id, body, {
        correctedBy: req.admin?.username || 'admin',
        correctionNote: body.note || null,
        markEdited: body.markEdited !== false,
      });
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      // Re-derive current status from the non-declined timeline (handles type/
      // time changes correctly, not just a blind re-apply of this event).
      if (event.trailer_id) await db.recomputeTrailerCurrentStatus(event.trailer_id);
      const status = event.trailer_id ? await db.getTrailerCurrentStatus(event.trailer_id) : null;
      res.json({ event, status });
    } catch (err) {
      console.error('[TRAILER-API] update event failed:', err.message);
      res.status(500).json({ error: 'Failed to update event.' });
    }
  });

  // ── Admin-triggered geocode backfill ───────────────────────────────────────
  // Geocodes a BOUNDED batch of pickup/dropoff events that have location text but
  // no coordinates, then recomputes the affected trailers' current status. Never
  // runs on boot and never geocodes more than GEOCODE_BACKFILL_MAX_PER_RUN rows.
  router.post('/api/trailers/geocode-backfill', authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(GEOCODE_BACKFILL_MAX_PER_RUN, Math.max(1, Number(req.body?.limit) || GEOCODE_BACKFILL_MAX_PER_RUN));
      const events = await db.listTrailerEventsNeedingGeocode(limit);
      const summary = { considered: events.length, geocoded: 0, approximate: 0, failed: 0 };
      const touchedTrailers = new Set();
      for (const ev of events) {
        const geo = await geocodeTrailerLocation(ev.location_text, { enabled: true });
        if (geo && geo.lat != null && geo.lng != null) {
          await db.setTrailerEventGeocode(ev.id, {
            lat: geo.lat, lng: geo.lng, source: geo.source, confidence: geo.confidence, error: geo.error || null,
          });
          if (geo.source === 'approximate_state') summary.approximate += 1; else summary.geocoded += 1;
          if (ev.trailer_id) touchedTrailers.add(ev.trailer_id);
        } else {
          await db.setTrailerEventGeocode(ev.id, { lat: null, lng: null, source: 'text_only', error: geo?.error || null });
          summary.failed += 1;
        }
      }
      for (const trailerId of touchedTrailers) {
        await db.recomputeTrailerCurrentStatus(trailerId).catch(() => {});
      }
      summary.remaining = Math.max(0, (await db.listTrailerEventsNeedingGeocode(GEOCODE_BACKFILL_MAX_PER_RUN)).length);
      res.json({ summary });
    } catch (err) {
      console.error('[TRAILER-API] geocode backfill failed:', err.message);
      res.status(500).json({ error: 'Failed to run geocode backfill.' });
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
