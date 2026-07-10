/**
 * Trailer Tracking (Beta) — data access.
 *
 * Owns the `trailers`, `trailer_events`, `trailer_current_status`,
 * `trailer_import_batches`, `trailer_import_rows`, and `trailer_settings`
 * tables. db.js re-exports every helper here so `require('./db')` callers keep
 * working. Depends only on ./pool — never back on db.js — so the require graph
 * stays acyclic.
 *
 * Correctness notes (this feature is a driver-responsibility ledger):
 *   - Events are immutable and deduped by (telegram_group_id, telegram_message_id).
 *   - Trailer upserts NEVER overwrite an existing non-empty field with a blank.
 *   - current_status is derived from the latest pickup/dropoff event only.
 */
const { query } = require('./pool');

// ─── helpers ───

/** Trim to a bounded string, or null for empty/blank. Never throws. */
function s(value, max = 500) {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

/** Normalize a unit number for stable matching/storage: upper, strip spaces/#. */
function normalizeUnitNumber(value) {
  if (value == null) return null;
  const t = String(value).toUpperCase().replace(/[#\s]+/g, '').trim();
  return t || null;
}

const TRAILER_FIELDS = ['make', 'model', 'mc_number', 'plate_number', 'type', 'vin', 'year', 'ownership_status'];

// ─── trailers (master list) ───

async function getTrailerById(id) {
  const res = await query('SELECT * FROM trailers WHERE id = $1', [Number(id)]);
  return res.rows[0] || null;
}

async function getTrailerByUnitNumber(unitNumber) {
  const unit = normalizeUnitNumber(unitNumber);
  if (!unit) return null;
  const res = await query('SELECT * FROM trailers WHERE unit_number = $1', [unit]);
  return res.rows[0] || null;
}

/**
 * Upsert a trailer by unit number. Only NON-EMPTY provided fields are written;
 * existing values are never clobbered with blanks. Returns the row.
 *
 * `source` defaults to 'admin_manual'. On insert, `needs_review` follows the
 * caller; on update it is only set when explicitly provided.
 */
async function upsertTrailerByUnitNumber(input = {}) {
  const unit = normalizeUnitNumber(input.unit_number);
  if (!unit) return null;

  const existing = await getTrailerByUnitNumber(unit);
  const source = s(input.source) || (existing ? existing.source : 'admin_manual');

  if (!existing) {
    const cols = ['unit_number', 'source'];
    const vals = [unit, source];
    for (const f of TRAILER_FIELDS) {
      if (input[f] != null && s(input[f]) != null) { cols.push(f); vals.push(s(input[f])); }
    }
    if (input.needs_review != null) { cols.push('needs_review'); vals.push(Boolean(input.needs_review)); }
    if (input.active != null) { cols.push('active'); vals.push(Boolean(input.active)); }
    const placeholders = vals.map((_, i) => `$${i + 1}`);
    const res = await query(
      `INSERT INTO trailers (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      vals
    );
    return res.rows[0];
  }

  // Update: only overwrite with non-blank provided values.
  const sets = [];
  const vals = [];
  let i = 1;
  for (const f of TRAILER_FIELDS) {
    if (input[f] != null && s(input[f]) != null) {
      sets.push(`${f} = $${i++}`);
      vals.push(s(input[f]));
    }
  }
  if (input.needs_review != null) { sets.push(`needs_review = $${i++}`); vals.push(Boolean(input.needs_review)); }
  if (input.active != null) { sets.push(`active = $${i++}`); vals.push(Boolean(input.active)); }
  if (!sets.length) return existing;
  sets.push('updated_at = NOW()');
  vals.push(existing.id);
  const res = await query(
    `UPDATE trailers SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return res.rows[0];
}

/**
 * Ensure a minimal trailer row exists for a unit the bot detected. Creates it
 * with source='telegram_detected' + needs_review=true when absent. Returns the
 * row (existing or newly created).
 */
async function ensureTrailerForDetection(unitNumber) {
  const unit = normalizeUnitNumber(unitNumber);
  if (!unit) return null;
  const existing = await getTrailerByUnitNumber(unit);
  if (existing) return existing;
  const res = await query(
    `INSERT INTO trailers (unit_number, source, needs_review)
     VALUES ($1, 'telegram_detected', TRUE)
     ON CONFLICT (unit_number) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [unit]
  );
  return res.rows[0];
}

/**
 * Trailer master list joined to current status, with optional filters.
 * Filters: q (unit/plate/vin substring), status, ownership, type, needs_review.
 */
async function listTrailers(filters = {}) {
  const where = [];
  const vals = [];
  let i = 1;
  if (filters.q) {
    where.push(`(UPPER(t.unit_number) LIKE $${i} OR UPPER(COALESCE(t.plate_number,'')) LIKE $${i} OR UPPER(COALESCE(t.vin,'')) LIKE $${i})`);
    vals.push(`%${String(filters.q).toUpperCase()}%`);
    i++;
  }
  if (filters.status) { where.push(`COALESCE(cs.current_status,'unknown') = $${i++}`); vals.push(String(filters.status)); }
  if (filters.ownership) { where.push(`t.ownership_status = $${i++}`); vals.push(String(filters.ownership)); }
  if (filters.type) { where.push(`t.type = $${i++}`); vals.push(String(filters.type)); }
  if (filters.needs_review === true || filters.needs_review === 'true') { where.push('t.needs_review = TRUE'); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await query(
    `SELECT t.*,
            cs.current_status, cs.current_driver_group_id, cs.current_driver_name,
            cs.current_location_text, cs.current_lat, cs.current_lng,
            cs.current_condition, cs.last_reporter_name,
            cs.last_event_type, cs.last_event_at,
            cs.needs_review AS status_needs_review, cs.pending_event_id,
            cs.location_source AS current_location_source
     FROM trailers t
     LEFT JOIN trailer_current_status cs ON cs.trailer_id = t.id
     ${whereClause}
     ORDER BY cs.last_event_at DESC NULLS LAST, t.unit_number ASC
     LIMIT 1000`,
    vals
  );
  return res.rows;
}

// ─── events ───

const REVIEW_STATES = new Set(['pending', 'accepted', 'declined', 'edited']);

/**
 * Insert a trailer event. Idempotent against duplicate Telegram messages: the
 * dedupe key is (telegram_group_id, telegram_message_id, event_index) so ONE
 * message can register several trailers (event_index 0, 1, 2 …) while a re-send
 * of the same message+index is still a no-op. Returns { event, duplicate }.
 */
async function insertTrailerEvent(input = {}) {
  const telegramGroupId = input.telegram_group_id != null ? String(input.telegram_group_id) : null;
  const telegramMessageId = input.telegram_message_id != null ? Number(input.telegram_message_id) : null;
  const eventIndex = Number.isFinite(Number(input.event_index)) ? Math.max(0, Math.trunc(Number(input.event_index))) : 0;

  if (telegramGroupId != null && telegramMessageId != null) {
    const dupe = await query(
      `SELECT * FROM trailer_events
       WHERE telegram_group_id = $1 AND telegram_message_id = $2 AND event_index = $3
       LIMIT 1`,
      [telegramGroupId, telegramMessageId, eventIndex]
    );
    if (dupe.rows[0]) return { event: dupe.rows[0], duplicate: true };
  }

  const reviewStatus = REVIEW_STATES.has(String(input.review_status)) ? String(input.review_status) : 'accepted';

  const res = await query(
    `INSERT INTO trailer_events (
       trailer_id, trailer_unit_number, event_type, confidence,
       driver_group_id, telegram_group_id, telegram_group_name,
       driver_profile_id, driver_name,
       reported_by_telegram_user_id, reported_by_username, reported_by_name,
       reported_driver_name_from_message,
       location_text, location_lat, location_lng, location_missing,
       condition_text, event_date_text, event_time,
       telegram_message_id, telegram_media_group_id, evidence,
       raw_message_text, ai_summary, unidentified_reason,
       reported_to_test_group, source, beta_mode,
       event_index, review_status, location_source, location_confidence, geocoded_at, geocode_error
     ) VALUES (
       $1,$2,$3,$4,
       $5,$6,$7,
       $8,$9,
       $10,$11,$12,
       $13,
       $14,$15,$16,$17,
       $18,$19,$20,
       $21,$22,$23,
       $24,$25,$26,
       $27,$28,$29,
       $30,$31,$32,$33,$34,$35
     )
     ON CONFLICT (telegram_group_id, telegram_message_id, event_index)
       WHERE telegram_group_id IS NOT NULL AND telegram_message_id IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      input.trailer_id != null ? Number(input.trailer_id) : null,
      normalizeUnitNumber(input.trailer_unit_number),
      String(input.event_type),
      input.confidence != null ? Math.max(0, Math.min(100, Math.round(Number(input.confidence)))) : null,
      input.driver_group_id != null ? Number(input.driver_group_id) : null,
      telegramGroupId,
      s(input.telegram_group_name, 300),
      input.driver_profile_id != null ? Number(input.driver_profile_id) : null,
      s(input.driver_name, 300),
      input.reported_by_telegram_user_id != null ? String(input.reported_by_telegram_user_id) : null,
      s(input.reported_by_username, 200),
      s(input.reported_by_name, 300),
      s(input.reported_driver_name_from_message, 300),
      s(input.location_text, 500),
      input.location_lat != null && Number.isFinite(Number(input.location_lat)) ? Number(input.location_lat) : null,
      input.location_lng != null && Number.isFinite(Number(input.location_lng)) ? Number(input.location_lng) : null,
      Boolean(input.location_missing),
      s(input.condition_text, 500),
      s(input.event_date_text, 100),
      input.event_time || null,
      telegramMessageId,
      s(input.telegram_media_group_id, 100),
      input.evidence != null ? JSON.stringify(input.evidence) : null,
      s(input.raw_message_text, 4000),
      s(input.ai_summary, 2000),
      s(input.unidentified_reason, 500),
      Boolean(input.reported_to_test_group),
      s(input.source, 40) || 'telegram',
      input.beta_mode == null ? true : Boolean(input.beta_mode),
      eventIndex,
      reviewStatus,
      s(input.location_source, 40),
      input.location_confidence != null ? Math.max(0, Math.min(100, Math.round(Number(input.location_confidence)))) : null,
      input.geocoded_at || null,
      s(input.geocode_error, 300),
    ]
  );

  // ON CONFLICT DO NOTHING returns no row on a race — re-read the existing one.
  if (!res.rows[0] && telegramGroupId != null && telegramMessageId != null) {
    const again = await query(
      `SELECT * FROM trailer_events WHERE telegram_group_id = $1 AND telegram_message_id = $2 AND event_index = $3 LIMIT 1`,
      [telegramGroupId, telegramMessageId, eventIndex]
    );
    if (again.rows[0]) return { event: again.rows[0], duplicate: true };
  }
  return { event: res.rows[0] || null, duplicate: false };
}

async function getTrailerEventById(id) {
  const res = await query('SELECT * FROM trailer_events WHERE id = $1', [Number(id)]);
  return res.rows[0] || null;
}

const EVENT_TYPES = new Set(['pickup', 'dropoff', 'mention_only', 'unidentified']);

/**
 * Edit an event (admin correction). Only provided keys change. Records who
 * corrected it and when, snapshots the pre-edit row (once) into
 * original_event_snapshot, and marks review_status='edited' unless the caller
 * overrides it. Never deletes — full audit trail is preserved.
 *
 * Options: { correctedBy, correctionNote, markEdited=true }.
 */
async function updateTrailerEvent(id, patch = {}, { correctedBy = null, correctionNote = null, markEdited = true } = {}) {
  const existing = await getTrailerEventById(id);
  if (!existing) return null;

  const allowed = {
    event_type: (v) => (EVENT_TYPES.has(String(v)) ? String(v) : existing.event_type),
    location_text: (v) => s(v, 500),
    location_lat: (v) => (v == null || v === '' ? null : Number(v)),
    location_lng: (v) => (v == null || v === '' ? null : Number(v)),
    location_source: (v) => s(v, 40),
    location_missing: (v) => Boolean(v),
    condition_text: (v) => s(v, 500),
    trailer_unit_number: (v) => normalizeUnitNumber(v),
    driver_name: (v) => s(v, 300),
    reported_driver_name_from_message: (v) => s(v, 300),
    event_date_text: (v) => s(v, 100),
    event_time: (v) => (v == null || v === '' ? null : v),
    resolved: (v) => Boolean(v),
  };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, fn] of Object.entries(allowed)) {
    if (patch[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(fn(patch[k])); }
  }
  // Editing a location by hand always clears the "missing" flag unless explicit.
  if (patch.location_text !== undefined && patch.location_missing === undefined) {
    sets.push(`location_missing = $${i++}`); vals.push(!s(patch.location_text, 500));
  }

  // Audit: who/when, one-time original snapshot, and (by default) mark edited.
  if (correctedBy != null) { sets.push(`corrected_by = $${i++}`); vals.push(s(correctedBy, 200)); }
  if (correctionNote != null) { sets.push(`correction_note = $${i++}`); vals.push(s(correctionNote, 500)); }
  sets.push('corrected_at = NOW()');
  if (existing.original_event_snapshot == null) {
    sets.push(`original_event_snapshot = $${i++}`);
    vals.push(JSON.stringify(existing));
  }
  if (markEdited) { sets.push(`review_status = $${i++}`); vals.push('edited'); }

  if (!sets.length) return existing;
  vals.push(Number(id));
  const res = await query(
    `UPDATE trailer_events SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return res.rows[0] || null;
}

/**
 * Accept the latest detected change: confirm the event, clear its review state,
 * record who/when. Current status is left as detected (recompute keeps it).
 */
async function acceptTrailerEvent(id, { reviewedBy = null, reviewNote = null } = {}) {
  const res = await query(
    `UPDATE trailer_events
     SET review_status = 'accepted', reviewed_by = $2, reviewed_at = NOW(), review_note = $3
     WHERE id = $1 RETURNING *`,
    [Number(id), s(reviewedBy, 200), s(reviewNote, 500)]
  );
  const event = res.rows[0] || null;
  if (event && event.trailer_id) await recomputeTrailerCurrentStatus(event.trailer_id);
  return event;
}

/**
 * Decline the latest detected change: mark it declined (kept in history) and
 * record who/when. Current status is recomputed from the latest non-declined
 * pickup/dropoff, which restores the previous confirmed status.
 */
async function declineTrailerEvent(id, { reviewedBy = null, reviewNote = null } = {}) {
  const res = await query(
    `UPDATE trailer_events
     SET review_status = 'declined', reviewed_by = $2, reviewed_at = NOW(), review_note = $3
     WHERE id = $1 RETURNING *`,
    [Number(id), s(reviewedBy, 200), s(reviewNote, 500)]
  );
  const event = res.rows[0] || null;
  if (event && event.trailer_id) await recomputeTrailerCurrentStatus(event.trailer_id);
  return event;
}

/** Recent events, newest first. Optional filters: event_type, trailer_id. */
async function listTrailerEvents(filters = {}) {
  const where = [];
  const vals = [];
  let i = 1;
  if (filters.event_type) { where.push(`event_type = $${i++}`); vals.push(String(filters.event_type)); }
  if (filters.trailer_id) { where.push(`trailer_id = $${i++}`); vals.push(Number(filters.trailer_id)); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 200));
  const res = await query(
    `SELECT * FROM trailer_events ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`,
    vals
  );
  return res.rows;
}

/** Full timeline for one trailer (all event types), newest first. */
async function listTrailerTimeline(trailerId, limit = 200) {
  const res = await query(
    `SELECT * FROM trailer_events
     WHERE trailer_id = $1
     ORDER BY COALESCE(event_time, created_at) DESC
     LIMIT ${Math.min(500, Math.max(1, Number(limit) || 200))}`,
    [Number(trailerId)]
  );
  return res.rows;
}

/** Unidentified / mention-only events awaiting review. */
async function listUnidentifiedTrailerEvents({ includeResolved = false } = {}) {
  const res = await query(
    `SELECT * FROM trailer_events
     WHERE event_type IN ('unidentified', 'mention_only')
       ${includeResolved ? '' : 'AND resolved = FALSE'}
     ORDER BY created_at DESC
     LIMIT 300`
  );
  return res.rows;
}

async function resolveTrailerEvent(id) {
  const res = await query(
    `UPDATE trailer_events SET resolved = TRUE WHERE id = $1 RETURNING *`,
    [Number(id)]
  );
  return res.rows[0] || null;
}

/**
 * Pickup/dropoff events that have a location_text but no coordinates yet — the
 * work list for the admin-triggered geocode backfill. Bounded by `limit`.
 */
async function listTrailerEventsNeedingGeocode(limit = 25) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 25));
  const res = await query(
    `SELECT * FROM trailer_events
     WHERE location_text IS NOT NULL
       AND (location_lat IS NULL OR location_lng IS NULL)
       AND event_type IN ('pickup', 'dropoff')
     ORDER BY COALESCE(event_time, created_at) DESC
     LIMIT ${lim}`
  );
  return res.rows;
}

/** Set only the geocode columns on an event (used by backfill; no review side effects). */
async function setTrailerEventGeocode(id, { lat, lng, source = null, confidence = null, error = null } = {}) {
  const res = await query(
    `UPDATE trailer_events
     SET location_lat = $2, location_lng = $3, location_source = $4,
         location_confidence = $5, geocoded_at = NOW(), geocode_error = $6
     WHERE id = $1 RETURNING *`,
    [Number(id), lat != null ? Number(lat) : null, lng != null ? Number(lng) : null,
      s(source, 40), confidence != null ? Number(confidence) : null, s(error, 300)]
  );
  return res.rows[0] || null;
}

// ─── current status (derived) ───

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

  const guard = force
    ? ''
    : `WHERE trailer_current_status.last_event_at IS NULL
          OR trailer_current_status.last_event_at <= EXCLUDED.last_event_at`;

  const res = await query(
    `INSERT INTO trailer_current_status (
       trailer_id, unit_number, current_status,
       current_driver_group_id, current_driver_profile_id, current_driver_name,
       current_location_text, current_lat, current_lng, current_condition,
       last_reporter_name, last_event_id, last_event_type, last_event_at,
       needs_review, pending_event_id, location_source, location_confidence, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, NOW()
     )
     ON CONFLICT (trailer_id) DO UPDATE SET
       current_status = EXCLUDED.current_status,
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
         current_status = 'unknown',
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
 * Map/list payload: every trailer with its current status. `mappable` rows have
 * coordinates. Used by both the admin and FleetView trailer map sections.
 */
async function listTrailerMapData() {
  const res = await query(
    `SELECT t.id AS trailer_id, t.unit_number, t.type, t.ownership_status, t.needs_review,
            COALESCE(cs.current_status, 'unknown') AS current_status,
            cs.current_driver_name, cs.current_driver_group_id,
            cs.current_location_text, cs.current_lat, cs.current_lng,
            cs.current_condition, cs.last_reporter_name,
            cs.last_event_type, cs.last_event_at,
            COALESCE(cs.needs_review, FALSE) AS status_needs_review,
            cs.location_source, cs.location_confidence
     FROM trailers t
     LEFT JOIN trailer_current_status cs ON cs.trailer_id = t.id
     WHERE t.active = TRUE
     ORDER BY cs.last_event_at DESC NULLS LAST, t.unit_number ASC
     LIMIT 2000`
  );
  return res.rows;
}

// ─── import batches / rows ───

async function createImportBatch({ uploadedBy = null, fileName = null, parsedCount = 0, errorCount = 0, rawAiResult = null } = {}) {
  const res = await query(
    `INSERT INTO trailer_import_batches (uploaded_by, file_name, status, parsed_count, error_count, raw_ai_result)
     VALUES ($1, $2, 'parsed', $3, $4, $5)
     RETURNING *`,
    [s(uploadedBy, 200), s(fileName, 300), Number(parsedCount) || 0, Number(errorCount) || 0,
      rawAiResult != null ? JSON.stringify(rawAiResult).slice(0, 200000) : null]
  );
  return res.rows[0];
}

async function insertImportRows(batchId, rows = []) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const res = await query(
      `INSERT INTO trailer_import_rows (
         batch_id, unit_number, make, model, mc_number, plate_number,
         type, vin, year, ownership_status, confidence, needs_review, raw_row
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        Number(batchId),
        normalizeUnitNumber(r.unit_number),
        s(r.make, 100), s(r.model, 100), s(r.mc_number, 100), s(r.plate_number, 100),
        s(r.type, 100), s(r.vin, 100), s(r.year, 20), s(r.ownership_status, 100),
        r.confidence != null ? Math.max(0, Math.min(100, Math.round(Number(r.confidence)))) : null,
        Boolean(r.needs_review),
        r.raw_row != null ? JSON.stringify(r.raw_row) : null,
      ]
    );
    out.push(res.rows[0]);
  }
  return out;
}

async function getImportBatch(batchId) {
  const res = await query('SELECT * FROM trailer_import_batches WHERE id = $1', [Number(batchId)]);
  const batch = res.rows[0] || null;
  if (!batch) return null;
  const rowsRes = await query('SELECT * FROM trailer_import_rows WHERE batch_id = $1 ORDER BY id ASC', [Number(batchId)]);
  batch.rows = rowsRes.rows;
  return batch;
}

async function listImportBatches(limit = 50) {
  const res = await query(
    `SELECT * FROM trailer_import_batches ORDER BY created_at DESC LIMIT ${Math.min(200, Math.max(1, Number(limit) || 50))}`
  );
  return res.rows;
}

async function markImportBatchCommitted(batchId) {
  const res = await query(
    `UPDATE trailer_import_batches SET status = 'committed' WHERE id = $1 RETURNING *`,
    [Number(batchId)]
  );
  return res.rows[0] || null;
}

// ─── settings ───

async function getTrailerSettings() {
  const res = await query('SELECT * FROM trailer_settings WHERE id = 1');
  return res.rows[0] || {
    id: 1, enabled: true, beta_mode: true, automatic_update_test_group_id: null,
    send_driver_group_confirmation: true, send_reaction: true,
    ai_fallback_enabled: true, geocoding_enabled: true,
  };
}

async function updateTrailerSettings(patch = {}) {
  const allowed = {
    enabled: (v) => Boolean(v),
    beta_mode: (v) => Boolean(v),
    automatic_update_test_group_id: (v) => s(v, 40),
    send_driver_group_confirmation: (v) => Boolean(v),
    send_reaction: (v) => Boolean(v),
    ai_fallback_enabled: (v) => Boolean(v),
    geocoding_enabled: (v) => Boolean(v),
  };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, fn] of Object.entries(allowed)) {
    if (patch[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(fn(patch[k])); }
  }
  if (!sets.length) return getTrailerSettings();
  sets.push('updated_at = NOW()');
  const res = await query(
    `UPDATE trailer_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    vals
  );
  return res.rows[0];
}

module.exports = {
  normalizeUnitNumber,
  // trailers
  getTrailerById,
  getTrailerByUnitNumber,
  upsertTrailerByUnitNumber,
  ensureTrailerForDetection,
  listTrailers,
  // events
  insertTrailerEvent,
  getTrailerEventById,
  updateTrailerEvent,
  acceptTrailerEvent,
  declineTrailerEvent,
  listTrailerEvents,
  listTrailerTimeline,
  listUnidentifiedTrailerEvents,
  resolveTrailerEvent,
  listTrailerEventsNeedingGeocode,
  setTrailerEventGeocode,
  // current status
  applyEventToCurrentStatus,
  recomputeTrailerCurrentStatus,
  getTrailerReviewContext,
  getTrailerCurrentStatus,
  listTrailerMapData,
  // import
  createImportBatch,
  insertImportRows,
  getImportBatch,
  listImportBatches,
  markImportBatchCommitted,
  // settings
  getTrailerSettings,
  updateTrailerSettings,
};
