'use strict';

/**
 * Trailer EVENTS: registering one by hand, and correcting one that was detected.
 *
 * These four endpoints are the human-authority half of the trailer timeline —
 * everything else in the Trailer Tracking API reads or maintains state, while
 * these write history on an admin's word:
 *
 *   POST /api/trailers/events/manual        register a pickup/dropoff
 *   POST /api/trailers/events/:id/accept    confirm a detected change
 *   POST /api/trailers/events/:id/decline   reject it (kept in history)
 *   PUT  /api/trailers/events/:id           correct one, then re-derive status
 *
 * THE INVARIANT THAT LIVES HERE: a manual event can never bring a trailer onto
 * the master list. `ensureTrailerForDetection` resolves an existing trailer or
 * returns null, and this responds 422 TRAILER_NOT_IN_MASTER_LIST rather than
 * creating one — the master list has exactly one authority, and it is not the
 * event form. See docs/architecture/trailer-invariants.md.
 *
 * A decline recomputes status from the latest NON-declined pickup/dropoff, and
 * an edit re-derives from the corrected timeline rather than blindly re-applying
 * the edited row, so a changed event type or time lands correctly.
 *
 * Split out of server/routes/trailerRoutes.js (which had passed the 500-line
 * limit); it mounts these on its own router, so every path and middleware chain
 * is unchanged.
 */
const db = require('../../../database/db');
const { geocodeTrailerLocation } = require('../../../services/trailerGeocodeService');

/**
 * @param {import('express').Router} router the trailer router
 * @param {{authMiddleware: Function, edit: Function}} deps the same auth and
 *   permission middleware the rest of the trailer API uses
 */
function registerTrailerEventRoutes(router, { authMiddleware, edit }) {
  router.post('/api/trailers/events/manual', authMiddleware, edit, async (req, res) => {
    try {
      const body = req.body || {};
      const unit = body.trailer_unit_number || body.unit_number;
      if (!unit) return res.status(400).json({ error: 'trailer_unit_number is required.' });
      if (!['pickup', 'dropoff'].includes(body.event_type)) {
        return res.status(400).json({ error: "event_type must be 'pickup' or 'dropoff'." });
      }
      // A manual event must reference an EXISTING official trailer: registering
      // an event can never bring a trailer onto the authoritative master list.
      const trailer = await db.ensureTrailerForDetection(unit);
      if (!trailer) {
        return res.status(422).json({
          error: 'Create or approve the trailer in the master list before registering an event.',
          code: 'TRAILER_NOT_IN_MASTER_LIST',
        });
      }
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
  router.post('/api/trailers/events/:id/accept', authMiddleware, edit, async (req, res) => {
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
  router.post('/api/trailers/events/:id/decline', authMiddleware, edit, async (req, res) => {
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
  router.put('/api/trailers/events/:id', authMiddleware, edit, async (req, res) => {
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

}

module.exports = { registerTrailerEventRoutes };
