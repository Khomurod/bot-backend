/**
 * Current status, DERIVED from the event ledger — never written directly.
 *
 * Only real pickup/dropoff events move a trailer; mentions and unidentified
 * sightings never do. Advancing is out-of-order safe (an older event does not
 * overwrite a newer one) except when a review decision explicitly forces a
 * recompute from an older event.
 *
 * getUnifiedTrailerStates is the single row shape both Trailer Tracking and the
 * Dispatch Map consume.
 */

const { query } = require('../pool');
const { boundedText: s } = require('../sqlValues');
// Reads only: the master list owns trailer records, and nothing here creates one.
const { getTrailerById } = require('../trailerMasterList/masterTrailers');
const {
  OFFICIAL_TRAILER_PREDICATE, derivePossessionCargo, buildDisplayStatus,
} = require('./status');

/**
 * Recompute + persist a trailer's current status from an event. Only real
 * pickup/dropoff events move status; mention/unidentified never do.
 *
 * Normally advances only when the event is newer than the stored last_event_at
 * (out-of-order safe). Pass { force:true } to always overwrite — used by
 * recomputeTrailerCurrentStatus after a decline restores an OLDER event.
 *
 * needs_review / pending_event_id reflect whether the driving event is still
 * pending human review (drives the admin "• review" badge).
 */
async function applyEventToCurrentStatus(trailer, event, { force = false } = {}) {
  if (!trailer || !event) return null;
  if (event.event_type !== 'pickup' && event.event_type !== 'dropoff') return null;

  const eventAt = event.event_time || event.created_at || new Date().toISOString();
  const currentStatus = event.event_type === 'pickup' ? 'with_driver' : 'dropped';
  const isPending = event.review_status === 'pending';
  const { possession, cargo } = derivePossessionCargo(event);
  const displayStatus = buildDisplayStatus(possession, cargo, isPending);

  const guard = force
    ? ''
    : `WHERE trailer_current_status.last_event_at IS NULL
          OR trailer_current_status.last_event_at <= EXCLUDED.last_event_at`;

  const res = await query(
    `INSERT INTO trailer_current_status (
       trailer_id, unit_number, current_status, possession_status, cargo_status, display_status,
       current_driver_group_id, current_driver_profile_id, current_driver_name,
       current_location_text, current_lat, current_lng, current_condition,
       last_reporter_name, last_event_id, last_event_type, last_event_at,
       needs_review, pending_event_id, location_source, location_confidence, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, NOW()
     )
     ON CONFLICT (trailer_id) DO UPDATE SET
       current_status = EXCLUDED.current_status,
       possession_status = EXCLUDED.possession_status,
       cargo_status = EXCLUDED.cargo_status,
       display_status = EXCLUDED.display_status,
       current_driver_group_id = EXCLUDED.current_driver_group_id,
       current_driver_profile_id = EXCLUDED.current_driver_profile_id,
       current_driver_name = EXCLUDED.current_driver_name,
       current_location_text = EXCLUDED.current_location_text,
       current_lat = EXCLUDED.current_lat,
       current_lng = EXCLUDED.current_lng,
       current_condition = EXCLUDED.current_condition,
       last_reporter_name = EXCLUDED.last_reporter_name,
       last_event_id = EXCLUDED.last_event_id,
       last_event_type = EXCLUDED.last_event_type,
       last_event_at = EXCLUDED.last_event_at,
       needs_review = EXCLUDED.needs_review,
       pending_event_id = EXCLUDED.pending_event_id,
       location_source = EXCLUDED.location_source,
       location_confidence = EXCLUDED.location_confidence,
       updated_at = NOW()
     ${guard}
     RETURNING *`,
    [
      Number(trailer.id),
      trailer.unit_number,
      currentStatus,
      possession,
      cargo,
      displayStatus,
      event.driver_group_id != null ? Number(event.driver_group_id) : null,
      event.driver_profile_id != null ? Number(event.driver_profile_id) : null,
      s(event.driver_name, 300),
      s(event.location_text, 500),
      event.location_lat != null ? Number(event.location_lat) : null,
      event.location_lng != null ? Number(event.location_lng) : null,
      s(event.condition_text, 500),
      s(event.reported_by_name || event.reported_by_username, 300),
      Number(event.id),
      event.event_type,
      eventAt,
      isPending,
      isPending ? Number(event.id) : null,
      s(event.location_source, 40),
      event.location_confidence != null ? Number(event.location_confidence) : null,
    ]
  );
  return res.rows[0] || null;
}

/**
 * Rebuild a trailer's current status from its event history, EXCLUDING declined
 * events. The latest non-declined pickup/dropoff drives the status; if none
 * remains the status resets to 'unknown'. Called after accept/decline/edit.
 */
async function recomputeTrailerCurrentStatus(trailerId) {
  const id = Number(trailerId);
  const res = await query(
    `SELECT * FROM trailer_events
     WHERE trailer_id = $1
       AND event_type IN ('pickup', 'dropoff')
       AND review_status <> 'declined'
     ORDER BY COALESCE(event_time, created_at) DESC, id DESC
     LIMIT 1`,
    [id]
  );
  const event = res.rows[0] || null;
  if (!event) {
    // No confirmed pickup/dropoff remains — reset to a clean 'unknown' snapshot.
    const reset = await query(
      `UPDATE trailer_current_status SET
         current_status = 'unknown', possession_status = 'unknown', cargo_status = 'unknown', display_status = 'Unknown',
         current_driver_group_id = NULL, current_driver_profile_id = NULL, current_driver_name = NULL,
         current_location_text = NULL, current_lat = NULL, current_lng = NULL, current_condition = NULL,
         last_reporter_name = NULL, last_event_id = NULL, last_event_type = NULL, last_event_at = NULL,
         needs_review = FALSE, pending_event_id = NULL, location_source = NULL, location_confidence = NULL,
         updated_at = NOW()
       WHERE trailer_id = $1 RETURNING *`,
      [id]
    );
    return reset.rows[0] || null;
  }
  const trailer = await getTrailerById(id);
  if (!trailer) return null;
  return applyEventToCurrentStatus(trailer, event, { force: true });
}

/**
 * The latest pickup/dropoff event for a trailer that is still PENDING review,
 * plus the previous confirmed (accepted/edited, non-declined) status event — so
 * the drawer can show "current detected change" vs "previous confirmed status".
 */
async function getTrailerReviewContext(trailerId) {
  const id = Number(trailerId);
  const pendingRes = await query(
    `SELECT * FROM trailer_events
     WHERE trailer_id = $1 AND event_type IN ('pickup','dropoff') AND review_status = 'pending'
     ORDER BY COALESCE(event_time, created_at) DESC, id DESC LIMIT 1`,
    [id]
  );
  const pending = pendingRes.rows[0] || null;
  let previous = null;
  if (pending) {
    const prevRes = await query(
      `SELECT * FROM trailer_events
       WHERE trailer_id = $1 AND event_type IN ('pickup','dropoff')
         AND review_status <> 'declined' AND id <> $2
       ORDER BY COALESCE(event_time, created_at) DESC, id DESC LIMIT 1`,
      [id, Number(pending.id)]
    );
    previous = prevRes.rows[0] || null;
  }
  return { pendingEvent: pending, previousEvent: previous };
}

/** Current status for one trailer. */
async function getTrailerCurrentStatus(trailerId) {
  const res = await query('SELECT * FROM trailer_current_status WHERE trailer_id = $1', [Number(trailerId)]);
  return res.rows[0] || null;
}




/**
 * Unified trailer states — the single row-shape both Trailer Tracking and the
 * Dispatch Map consume (via services/trailerStateService.js). Superset of the
 * map payload: adds master-list detail (plate/vin/make/model) for the management
 * view. `activeOnly` (default true) mirrors the map query; pass false to include
 * archived trailers in admin lists.
 */
async function getUnifiedTrailerStates({ activeOnly = true, limit = 2000, includeUnofficial = false } = {}) {
  // Default to OFFICIAL trailers only. Pending-review / archived / merged
  // records are not assets: they must not appear on a map or in a default list,
  // only in the dedicated master-list review section (includeUnofficial).
  const officialFilter = activeOnly && !includeUnofficial ? `WHERE ${OFFICIAL_TRAILER_PREDICATE}` : '';
  const res = await query(
    `SELECT t.id AS trailer_id, t.unit_number, t.type, t.ownership_status, t.active, t.physical_status, t.tracking_reference,
            t.needs_review, t.plate_number, t.vin, t.make, t.model, t.year, t.mc_number,
            COALESCE(cs.current_status, 'unknown') AS current_status,
            COALESCE(cs.possession_status, 'unknown') AS possession_status,
            COALESCE(cs.cargo_status, 'unknown') AS cargo_status,
            cs.display_status,
            cs.current_driver_name, cs.current_driver_group_id, cs.current_driver_profile_id,
            cs.current_location_text, cs.current_lat, cs.current_lng,
            cs.current_condition, cs.last_reporter_name,
            cs.last_event_id, cs.last_event_type, cs.last_event_at,
            COALESCE(cs.needs_review, FALSE) AS status_needs_review,
            cs.pending_event_id, cs.location_source, cs.location_confidence, cs.updated_at
     FROM trailers t
     LEFT JOIN trailer_current_status cs ON cs.trailer_id = t.id
     ${officialFilter}
     ORDER BY cs.last_event_at DESC NULLS LAST, t.unit_number ASC
     LIMIT $1`,
    [Math.max(1, Math.min(5000, Number(limit) || 2000))]
  );
  return res.rows;
}

/** Unified state for a single trailer (same shape as getUnifiedTrailerStates). */
async function getUnifiedTrailerStateById(trailerId) {
  const res = await query(
    `SELECT t.id AS trailer_id, t.unit_number, t.type, t.ownership_status, t.active, t.physical_status, t.tracking_reference,
            t.needs_review, t.plate_number, t.vin, t.make, t.model, t.year, t.mc_number,
            COALESCE(cs.current_status, 'unknown') AS current_status,
            COALESCE(cs.possession_status, 'unknown') AS possession_status,
            COALESCE(cs.cargo_status, 'unknown') AS cargo_status,
            cs.display_status,
            cs.current_driver_name, cs.current_driver_group_id, cs.current_driver_profile_id,
            cs.current_location_text, cs.current_lat, cs.current_lng,
            cs.current_condition, cs.last_reporter_name,
            cs.last_event_id, cs.last_event_type, cs.last_event_at,
            COALESCE(cs.needs_review, FALSE) AS status_needs_review,
            cs.pending_event_id, cs.location_source, cs.location_confidence, cs.updated_at
     FROM trailers t
     LEFT JOIN trailer_current_status cs ON cs.trailer_id = t.id
     WHERE t.id = $1`,
    [Number(trailerId)]
  );
  return res.rows[0] || null;
}

/**
 * Recompute current status for a batch of trailers from their event history.
 * Bounded (default 500) so an admin backfill never runs an unbounded loop.
 * Returns { processed }.
 */
async function recomputeAllTrailerCurrentStatuses({ limit = 500 } = {}) {
  const cap = Math.max(1, Math.min(5000, Number(limit) || 500));
  const res = await query(
    `SELECT DISTINCT trailer_id FROM trailer_events
     WHERE trailer_id IS NOT NULL AND event_type IN ('pickup','dropoff')
     ORDER BY trailer_id LIMIT $1`,
    [cap]
  );
  let processed = 0;
  for (const row of res.rows) {
    try {
      await recomputeTrailerCurrentStatus(row.trailer_id);
      processed += 1;
    } catch (err) {
      console.warn('[TRAILER] recompute failed for', row.trailer_id, '-', err.message);
    }
  }
  return { processed };
}

/**
 * Trailers whose latest pickup/dropoff event is still pending review. Drives the
 * "Needs Review" tab and the Dispatch Map "needs review" filter.
 */
async function listTrailersNeedingReview() {
  const res = await query(
    `SELECT t.id AS trailer_id, t.unit_number, t.type,
            COALESCE(cs.possession_status, 'unknown') AS possession_status,
            COALESCE(cs.cargo_status, 'unknown') AS cargo_status,
            cs.display_status, cs.current_driver_name, cs.current_location_text,
            cs.last_reporter_name, cs.last_event_at, cs.pending_event_id,
            e.event_type AS pending_event_type, e.confidence AS pending_confidence,
            e.raw_message_text AS pending_raw_message, e.unidentified_reason AS pending_reason,
            e.location_text AS pending_location, e.reported_by_name AS pending_reporter
     FROM trailer_current_status cs
     JOIN trailers t ON t.id = cs.trailer_id
     LEFT JOIN trailer_events e ON e.id = cs.pending_event_id
     WHERE cs.needs_review = TRUE
     ORDER BY cs.last_event_at DESC NULLS LAST
     LIMIT 1000`
  );
  return res.rows;
}


module.exports = {
  applyEventToCurrentStatus,
  recomputeTrailerCurrentStatus,
  getTrailerReviewContext,
  getTrailerCurrentStatus,
  getUnifiedTrailerStates,
  getUnifiedTrailerStateById,
  recomputeAllTrailerCurrentStatuses,
  listTrailersNeedingReview,
};
