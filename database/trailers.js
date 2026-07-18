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
// services/trailerMasterList/normalize is the single owner of unit-number
// normalization, shared with the master-list and Telegram ingest paths so
// matching can never drift between them. Re-exported below for callers.
const { normalizeUnitNumber } = require('../services/trailerMasterList/normalize');
// The master list itself (reads + the single restricted creation path) lives in
// ./trailerMasterList/masterTrailers. Re-exported below so `require('./db')` and
// `require('./trailers')` callers keep working unchanged.
const masterTrailers = require('./trailerMasterList/masterTrailers');

const {
  getTrailerById,
  getTrailerByUnitNumber,
  upsertTrailerByUnitNumber,
  ensureTrailerForDetection,
  TRAILER_FIELDS,
} = masterTrailers;

/**
 * What makes a trailer a real, official asset — the single definition shared by
 * every list, map and picker (`t` must be the trailers alias).
 *
 * Two independent flags must BOTH hold: `active` is the legacy soft-delete, and
 * `master_status` is master-list authority. A pending-review, archived or merged
 * trailer is not an asset: it keeps its history but must never appear on a map,
 * in a default list, or in a rental picker.
 */
const OFFICIAL_TRAILER_PREDICATE = "t.active = TRUE AND t.master_status = 'active'";
// ─── helpers ───

/** Trim to a bounded string, or null for empty/blank. Never throws. */
function s(value, max = 500) {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}
// ─── unified status normalization ───
const POSSESSION_STATES = new Set(['with_driver', 'dropped', 'unknown']);
const CARGO_STATES = new Set(['empty', 'loaded', 'unknown']);
/** Coerce to a valid possession_status; unknown for anything unexpected. */
function normPossession(value) {
  const t = String(value || '').trim().toLowerCase();
  return POSSESSION_STATES.has(t) ? t : 'unknown';
}
/** Coerce to a valid cargo_status; unknown for anything unexpected. */
function normCargo(value) {
  const t = String(value || '').trim().toLowerCase();
  return CARGO_STATES.has(t) ? t : 'unknown';
}
/** Map an event_type to its possession_status (fallback when none was stored). */
function possessionForEventType(eventType) {
  if (eventType === 'pickup') return 'with_driver';
  if (eventType === 'dropoff') return 'dropped';
  return 'unknown';
}
/**
 * Derive the possession + cargo for the current-status row from an event. Honors
 * the event's stored possession_status/cargo_status when present; otherwise falls
 * back to the action (dropoff ⇒ dropped/empty, pickup ⇒ with_driver/unknown) so
 * pre-cargo historical events still resolve sensibly.
 */
function derivePossessionCargo(event) {
  const possession = event.possession_status
    ? normPossession(event.possession_status)
    : possessionForEventType(event.event_type);
  let cargo = normCargo(event.cargo_status);
  if (cargo === 'unknown' && !event.cargo_status && event.event_type === 'dropoff') {
    cargo = 'empty'; // dropped ⇒ empty by default (business rule)
  }
  return { possession, cargo };
}

const POSSESSION_LABEL = { with_driver: 'With driver', dropped: 'Dropped', unknown: 'Unknown' };
const CARGO_LABEL = { empty: 'Empty', loaded: 'Loaded', unknown: 'Unknown cargo' };

/**
 * Human display status, e.g. "Dropped / Empty", "With driver / Loaded".
 * needsReview overrides to "Unknown / Needs review" only when possession is
 * unknown, matching the task's status vocabulary.
 */
function buildDisplayStatus(possession, cargo, needsReview) {
  const p = normPossession(possession);
  const c = normCargo(cargo);
  if (p === 'unknown') return needsReview ? 'Unknown / Needs review' : 'Unknown';
  const cargoLabel = c === 'unknown' ? 'Unknown cargo' : CARGO_LABEL[c];
  return `${POSSESSION_LABEL[p]} / ${cargoLabel}`;
}

// ─── trailers (master list) ───

/**
 * Trailer master list joined to current status, with optional filters.
 * Filters: q (unit/plate/vin substring), status, ownership, type, needs_review,
 * master_status.
 *
 * Defaults to OFFICIAL trailers only. Pending-review, archived and merged
 * records keep all their history but are not assets, so they are reachable only
 * by asking for them explicitly (`master_status`), which is what the dedicated
 * master-list review section does.
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
  if (filters.master_status) {
    where.push(`t.master_status = $${i++}`);
    vals.push(String(filters.master_status));
  } else if (filters.include_unofficial !== true && filters.include_unofficial !== 'true') {
    where.push(OFFICIAL_TRAILER_PREDICATE);
  }
  if (filters.status) { where.push(`COALESCE(cs.current_status,'unknown') = $${i++}`); vals.push(String(filters.status)); }
  if (filters.ownership) { where.push(`t.ownership_status = $${i++}`); vals.push(String(filters.ownership)); }
  if (filters.type) { where.push(`t.type = $${i++}`); vals.push(String(filters.type)); }
  if (filters.needs_review === true || filters.needs_review === 'true') { where.push('t.needs_review = TRUE'); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await query(
    `SELECT t.*,
            cs.current_status,
            COALESCE(cs.possession_status, 'unknown') AS possession_status,
            COALESCE(cs.cargo_status, 'unknown') AS cargo_status,
            cs.display_status,
            cs.current_driver_group_id, cs.current_driver_name,
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

// listTrailerMapData now lives in ./trailerMapData (kept small per the size
// budget); re-exported below so require('./trailers') callers are unaffected.
const { listTrailerMapData } = require('./trailerMapData');


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

// ─── pending instructions (planned pickup/drop-off, NOT completed events) ───

const PLANNED_ACTIONS = new Set(['pickup', 'dropoff']);
const INSTRUCTION_STATES = new Set(['pending', 'confirmed', 'superseded', 'cancelled']);

/**
 * Record a planned/assigned pickup or drop-off INSTRUCTION. This never touches
 * trailer_current_status — an instruction is not a completed action. Idempotent
 * against a re-delivered Telegram message via the partial unique index on
 * (telegram_group_id, source_message_id, unit, action). Returns { instruction, duplicate }.
 */
async function insertTrailerPendingInstruction(input = {}) {
  const unit = normalizeUnitNumber(input.trailer_unit_number);
  const action = String(input.planned_action || '').toLowerCase();
  if (!unit || !PLANNED_ACTIONS.has(action)) return { instruction: null, duplicate: false };

  const telegramGroupId = input.telegram_group_id != null ? String(input.telegram_group_id) : null;
  const sourceMessageId = input.instruction_source_message_id != null ? Number(input.instruction_source_message_id) : null;

  if (telegramGroupId != null && sourceMessageId != null) {
    const dupe = await query(
      `SELECT * FROM trailer_pending_instructions
        WHERE telegram_group_id = $1 AND instruction_source_message_id = $2
          AND trailer_unit_number = $3 AND planned_action = $4
        LIMIT 1`,
      [telegramGroupId, sourceMessageId, unit, action]
    );
    if (dupe.rows[0]) return { instruction: dupe.rows[0], duplicate: true };
  }

  const res = await query(
    `INSERT INTO trailer_pending_instructions (
       trailer_id, trailer_unit_number, planned_action, planned_location, planned_lat, planned_lng,
       driver_group_id, telegram_group_id, telegram_group_name, instruction_source_message_id,
       reported_by_telegram_user_id, reported_by_username, reported_by_name,
       semantic_intent, semantic_confidence, ai_reason, raw_message_text, instruction_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending')
     ON CONFLICT (telegram_group_id, instruction_source_message_id, trailer_unit_number, planned_action)
       WHERE telegram_group_id IS NOT NULL AND instruction_source_message_id IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      input.trailer_id != null ? Number(input.trailer_id) : null,
      unit,
      action,
      s(input.planned_location, 500),
      input.planned_lat != null && Number.isFinite(Number(input.planned_lat)) ? Number(input.planned_lat) : null,
      input.planned_lng != null && Number.isFinite(Number(input.planned_lng)) ? Number(input.planned_lng) : null,
      input.driver_group_id != null ? Number(input.driver_group_id) : null,
      telegramGroupId,
      s(input.telegram_group_name, 300),
      sourceMessageId,
      input.reported_by_telegram_user_id != null ? String(input.reported_by_telegram_user_id) : null,
      s(input.reported_by_username, 200),
      s(input.reported_by_name, 300),
      s(input.semantic_intent, 40),
      input.semantic_confidence != null ? Math.max(0, Math.min(100, Math.round(Number(input.semantic_confidence)))) : null,
      s(input.ai_reason, 500),
      s(input.raw_message_text, 4000),
    ]
  );

  // ON CONFLICT DO NOTHING → re-read the existing row on a race.
  if (!res.rows[0] && telegramGroupId != null && sourceMessageId != null) {
    const again = await query(
      `SELECT * FROM trailer_pending_instructions
        WHERE telegram_group_id = $1 AND instruction_source_message_id = $2
          AND trailer_unit_number = $3 AND planned_action = $4 LIMIT 1`,
      [telegramGroupId, sourceMessageId, unit, action]
    );
    if (again.rows[0]) return { instruction: again.rows[0], duplicate: true };
  }
  return { instruction: res.rows[0] || null, duplicate: false };
}

/**
 * The most recent still-PENDING instruction for a unit (optionally filtered by
 * action). Used to backfill a later CONFIRMED event's location with the planned
 * destination and to link the two.
 */
async function getLatestPendingInstruction(unitNumber, action = null) {
  const unit = normalizeUnitNumber(unitNumber);
  if (!unit) return null;
  const params = [unit];
  let actionClause = '';
  if (action && PLANNED_ACTIONS.has(String(action))) {
    actionClause = ' AND planned_action = $2';
    params.push(String(action));
  }
  const res = await query(
    `SELECT * FROM trailer_pending_instructions
      WHERE trailer_unit_number = $1 AND instruction_status = 'pending'${actionClause}
      ORDER BY instruction_created_at DESC, id DESC LIMIT 1`,
    params
  );
  return res.rows[0] || null;
}

/** Mark a pending instruction confirmed (a completed event fulfilled it). */
async function markPendingInstructionConfirmed(id, { confirmedEventId = null } = {}) {
  const res = await query(
    `UPDATE trailer_pending_instructions
       SET instruction_status = 'confirmed', confirmed_event_id = $2,
           resolved_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND instruction_status = 'pending' RETURNING *`,
    [Number(id), confirmedEventId != null ? Number(confirmedEventId) : null]
  );
  return res.rows[0] || null;
}

/** Set an instruction's status (superseded / cancelled / confirmed). */
async function setPendingInstructionStatus(id, status) {
  const st = INSTRUCTION_STATES.has(String(status)) ? String(status) : null;
  if (!st) return null;
  const res = await query(
    `UPDATE trailer_pending_instructions
       SET instruction_status = $2,
           resolved_at = CASE WHEN $2 = 'pending' THEN NULL ELSE NOW() END,
           updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [Number(id), st]
  );
  return res.rows[0] || null;
}

/** List pending instructions for the Admin UI. Filters: status, trailer_id, unit. */
async function listPendingInstructions(filters = {}) {
  const where = [];
  const vals = [];
  let i = 1;
  if (filters.status && INSTRUCTION_STATES.has(String(filters.status))) {
    where.push(`instruction_status = $${i++}`); vals.push(String(filters.status));
  } else if (filters.status !== 'all') {
    where.push(`instruction_status = 'pending'`);
  }
  if (filters.trailer_id) { where.push(`trailer_id = $${i++}`); vals.push(Number(filters.trailer_id)); }
  if (filters.unit) { where.push(`trailer_unit_number = $${i++}`); vals.push(normalizeUnitNumber(filters.unit)); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 200));
  const res = await query(
    `SELECT * FROM trailer_pending_instructions ${whereClause}
     ORDER BY instruction_created_at DESC LIMIT ${limit}`,
    vals
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
    semantic_ai_required: true, auto_register_confidence: 92, review_confidence: 75,
    silent_driver_group_monitoring: true,
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
    semantic_ai_required: (v) => Boolean(v),
    auto_register_confidence: (v) => Math.max(50, Math.min(100, Math.round(Number(v)) || 92)),
    review_confidence: (v) => Math.max(0, Math.min(100, Math.round(Number(v)) || 75)),
    silent_driver_group_monitoring: (v) => Boolean(v),
    payment_confirmation_group_id: (v) => s(v, 40), overdue_reminder_group_id: (v) => s(v, 40),
    responsible_telegram_username: (v) => s(String(v || '').replace(/^@/, ''), 64), responsible_telegram_user_id: (v) => s(v, 40),
    escalation_telegram_username: (v) => s(String(v || '').replace(/^@/, ''), 64), escalation_telegram_user_id: (v) => s(v, 40),
    reminder_timezone: (v) => s(v, 80) || 'America/Chicago', payment_grace_period_days: (v) => Math.max(0, Math.min(90, Math.round(Number(v)) || 0)),
    reminder_hour: (v) => Math.max(0, Math.min(23, Math.round(Number(v)) || 0)), reminder_repeat_days: (v) => Math.max(1, Math.min(30, Math.round(Number(v)) || 1)),
    reminder_escalation_days: (v) => Math.max(1, Math.min(90, Math.round(Number(v)) || 7)), reminder_weekend_behavior: (v) => v === 'send' ? 'send' : 'skip',
    reminders_enabled: (v) => Boolean(v),
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
  recomputeAllTrailerCurrentStatuses,
  getTrailerReviewContext,
  getTrailerCurrentStatus,
  listTrailerMapData,
  // unified state
  getUnifiedTrailerStates,
  getUnifiedTrailerStateById,
  listTrailersNeedingReview,
  buildDisplayStatus,
  derivePossessionCargo,
  // pending instructions (planned pickup/drop-off)
  insertTrailerPendingInstruction,
  getLatestPendingInstruction,
  markPendingInstructionConfirmed,
  setPendingInstructionStatus,
  listPendingInstructions,
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
