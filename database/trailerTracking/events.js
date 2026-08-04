/**
 * The trailer event ledger: immutable, deduped, and human-reviewable.
 *
 * Events are the source of truth for this feature. They are deduped by
 * (telegram_group_id, telegram_message_id, event_index), never rewritten in
 * place, and a correction or a review decision recomputes the derived current
 * status rather than editing it directly.
 */

const { query } = require('../pool');
const { boundedText: s } = require('../sqlValues');
const { normalizeUnitNumber } = require('../../services/trailerMasterList/normalize');
const { normPossession, normCargo, possessionForEventType } = require('./status');
const { recomputeTrailerCurrentStatus } = require('./currentStatus');

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
       trailer_id, trailer_unit_number, event_type, possession_status, cargo_status, confidence,
       driver_group_id, telegram_group_id, telegram_group_name,
       driver_profile_id, driver_name,
       reported_by_telegram_user_id, reported_by_username, reported_by_name,
       reported_driver_name_from_message,
       location_text, location_lat, location_lng, location_missing,
       condition_text, event_date_text, event_time,
       telegram_message_id, telegram_media_group_id, evidence,
       raw_message_text, ai_summary, unidentified_reason,
       reported_to_test_group, source, beta_mode,
       event_index, review_status, location_source, location_confidence, geocoded_at, geocode_error,
       semantic_intent, semantic_completed, semantic_confidence, semantic_reason,
       unit_grounded, unit_source, unit_evidence, action_evidence,
       ai_model, ai_verified_at, ai_verification_status, raw_ai_result
     ) VALUES (
       $1,$2,$3,$4,$5,$6,
       $7,$8,$9,
       $10,$11,
       $12,$13,$14,
       $15,
       $16,$17,$18,$19,
       $20,$21,$22,
       $23,$24,$25,
       $26,$27,$28,
       $29,$30,$31,
       $32,$33,$34,$35,$36,$37,
       $38,$39,$40,$41,
       $42,$43,$44,$45,
       $46,$47,$48,$49
     )
     ON CONFLICT (telegram_group_id, telegram_message_id, event_index)
       WHERE telegram_group_id IS NOT NULL AND telegram_message_id IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      input.trailer_id != null ? Number(input.trailer_id) : null,
      normalizeUnitNumber(input.trailer_unit_number),
      String(input.event_type),
      normPossession(input.possession_status != null ? input.possession_status : possessionForEventType(input.event_type)),
      normCargo(input.cargo_status),
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
      s(input.semantic_intent, 40),
      input.semantic_completed == null ? null : Boolean(input.semantic_completed),
      input.semantic_confidence != null ? Math.max(0, Math.min(100, Math.round(Number(input.semantic_confidence)))) : null,
      s(input.semantic_reason, 500),
      input.unit_grounded == null ? null : Boolean(input.unit_grounded),
      s(input.unit_source, 40),
      s(input.unit_evidence, 500),
      s(input.action_evidence, 500),
      s(input.ai_model, 100),
      input.ai_verified_at || null,
      s(input.ai_verification_status, 40),
      input.raw_ai_result != null ? JSON.stringify(input.raw_ai_result).slice(0, 20000) : null,
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
    cargo_status: (v) => normCargo(v),
    possession_status: (v) => normPossession(v),
  };

  // ── consistency normalization (server-side, before saving) ──
  // A pickup/dropoff event's possession MUST follow its type: pickup ⇒
  // with_driver, dropoff ⇒ dropped. A contradictory possession in the patch is
  // overridden; a type change with no possession in the patch forces the
  // matching possession. This makes rows like event_type=pickup /
  // possession_status=dropped impossible to create via edit.
  const normalizedPatch = { ...patch };
  const effectiveType = normalizedPatch.event_type !== undefined
    ? (EVENT_TYPES.has(String(normalizedPatch.event_type)) ? String(normalizedPatch.event_type) : existing.event_type)
    : existing.event_type;
  if (effectiveType === 'pickup' || effectiveType === 'dropoff') {
    const requiredPossession = possessionForEventType(effectiveType);
    if (normalizedPatch.event_type !== undefined || normalizedPatch.possession_status !== undefined) {
      normalizedPatch.possession_status = requiredPossession;
    }
    // Business rule on a type change with no explicit cargo: a dropoff with no
    // loaded evidence defaults to empty; a pickup's cargo becomes unknown
    // unless the event already carries an explicit loaded/empty value.
    if (normalizedPatch.event_type !== undefined && normalizedPatch.cargo_status === undefined) {
      const existingCargo = normCargo(existing.cargo_status);
      if (effectiveType === 'dropoff' && existingCargo === 'unknown') normalizedPatch.cargo_status = 'empty';
    }
  }

  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, fn] of Object.entries(allowed)) {
    if (normalizedPatch[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(fn(normalizedPatch[k])); }
  }
  // Editing a location by hand always clears the "missing" flag unless explicit.
  if (normalizedPatch.location_text !== undefined && normalizedPatch.location_missing === undefined) {
    sets.push(`location_missing = $${i++}`); vals.push(!s(normalizedPatch.location_text, 500));
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


module.exports = {
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
};
