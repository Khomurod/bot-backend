/**
 * Unified Trailer State Service — the single source of truth for trailer state.
 *
 * Both 🚚 Trailer Tracking (management/history/review) and the Dispatch Map
 * (operational live map) call THIS service. It computes each trailer's current
 * operational state ONCE from the maintained current-status snapshot and serves a
 * normalized shape to every view. No frontend re-decides the business status:
 * the backend owns possession_status, cargo_status, display_status and the map
 * marker style; the frontend only positions and renders them.
 *
 * Business rule (enforced upstream in the parser + DB, reflected here):
 *   a DROPPED trailer is EMPTY unless the message clearly says loaded.
 *
 * FAIL-SOFT: every public function swallows errors and returns a safe empty
 * value ([] / null / a degraded payload) so a trailer-store issue can NEVER
 * crash the server or break the Dispatch Map / FleetView.
 */
const db = require('../database/db');

// ── vocabularies ──
const POSSESSION_STATES = new Set(['with_driver', 'dropped', 'unknown']);
const CARGO_STATES = new Set(['empty', 'loaded', 'unknown']);
const POSSESSION_LABEL = { with_driver: 'With driver', dropped: 'Dropped', unknown: 'Unknown' };
const CARGO_LABEL = { empty: 'Empty', loaded: 'Loaded', unknown: 'Unknown cargo' };

// Marker palette (kept in sync with the frontend trailerState helpers).
const COLOR = {
  droppedEmpty: '#f59e0b',   // orange
  droppedLoaded: '#a855f7',  // purple
  withDriverEmpty: '#22c55e',// green
  withDriverLoaded: '#8b5cf6',// violet
  withDriverUnknown: '#3b82f6',// blue
  unknown: '#8a94a4',        // grey
};
const OUTLINE_REVIEW = '#ef4444'; // red
const OUTLINE_NORMAL = '#ffffff';

function normPossession(v) {
  const t = String(v || '').trim().toLowerCase();
  return POSSESSION_STATES.has(t) ? t : 'unknown';
}
function normCargo(v) {
  const t = String(v || '').trim().toLowerCase();
  return CARGO_STATES.has(t) ? t : 'unknown';
}

/** Human display status, e.g. "Dropped / Empty". */
function buildDisplayStatus(possession, cargo, needsReview) {
  const p = normPossession(possession);
  const c = normCargo(cargo);
  if (p === 'unknown') return needsReview ? 'Unknown / Needs review' : 'Unknown';
  const cargoLabel = c === 'unknown' ? 'Unknown cargo' : CARGO_LABEL[c];
  return `${POSSESSION_LABEL[p]} / ${cargoLabel}`;
}

/** Marker fill color from possession + cargo. */
function markerColor(possession, cargo) {
  const p = normPossession(possession);
  const c = normCargo(cargo);
  if (p === 'dropped') return c === 'loaded' ? COLOR.droppedLoaded : COLOR.droppedEmpty;
  if (p === 'with_driver') {
    if (c === 'loaded') return COLOR.withDriverLoaded;
    if (c === 'empty') return COLOR.withDriverEmpty;
    return COLOR.withDriverUnknown;
  }
  return COLOR.unknown;
}

function isApproximateSource(source) {
  return source === 'approximate_state' || source === 'approximate';
}

/**
 * Build the map-marker descriptor. `shape` is always a rectangle for trailers;
 * `attached_to_driver` tells the frontend to derive coordinates from the matched
 * truck marker (a with-driver trailer rides with its truck). Coordinates
 * themselves are resolved by the frontend (presentation), not here.
 */
function buildMapMarker(state) {
  const attached = state.possession_status === 'with_driver';
  const dashed = isApproximateSource(state.location_source);
  return {
    shape: 'rectangle',
    color: markerColor(state.possession_status, state.cargo_status),
    outline: state.needs_review ? OUTLINE_REVIEW : OUTLINE_NORMAL,
    dashed,
    attached_to_driver: attached,
    tooltip: `${state.unit_number} — ${state.display_status}`,
    popup_fields: [
      { label: 'Unit', value: state.unit_number },
      { label: 'Status', value: state.display_status },
      { label: 'Possession', value: POSSESSION_LABEL[state.possession_status] || 'Unknown' },
      { label: 'Cargo', value: CARGO_LABEL[state.cargo_status] || 'Unknown cargo' },
      { label: 'Driver', value: state.current_driver_name || '—' },
      { label: 'Location', value: state.location_text || '—' },
      { label: 'Location source', value: state.location_source || 'unknown' },
      { label: 'Condition', value: state.condition_text || '—' },
      { label: 'Reporter', value: state.last_reporter_name || '—' },
      { label: 'Last event', value: state.last_event_at || '—' },
      { label: 'Review', value: state.needs_review ? 'Needs review' : 'OK' },
    ],
  };
}

/**
 * Normalize a raw DB unified-state row into the canonical state object every view
 * consumes. Recomputes display_status from possession+cargo so it is always
 * consistent even if the stored copy is stale/missing. Never throws.
 */
function normalizeState(row) {
  const possession = normPossession(row.possession_status);
  const cargo = normCargo(row.cargo_status);
  const needsReview = Boolean(row.status_needs_review);
  const displayStatus = row.display_status || buildDisplayStatus(possession, cargo, needsReview);

  const state = {
    trailer_id: row.trailer_id != null ? Number(row.trailer_id) : null,
    unit_number: row.unit_number || null,
    possession_status: possession,
    cargo_status: cargo,
    display_status: displayStatus,
    current_driver_name: row.current_driver_name || null,
    current_driver_group_id: row.current_driver_group_id != null ? Number(row.current_driver_group_id) : null,
    current_driver_profile_id: row.current_driver_profile_id != null ? Number(row.current_driver_profile_id) : null,
    location_text: row.current_location_text || null,
    lat: row.current_lat != null ? Number(row.current_lat) : null,
    lng: row.current_lng != null ? Number(row.current_lng) : null,
    location_source: row.location_source || (row.current_lat != null ? 'exact' : 'unknown'),
    location_confidence: row.location_confidence != null ? Number(row.location_confidence) : null,
    condition_text: row.current_condition || null,
    needs_review: needsReview,
    review_status: needsReview ? 'pending' : 'accepted',
    last_event_id: row.last_event_id != null ? Number(row.last_event_id) : null,
    last_event_type: row.last_event_type || null,
    last_event_at: row.last_event_at || null,
    last_reporter_name: row.last_reporter_name || null,
    last_reporter_username: row.last_reporter_username || null,
    // extra master-list detail for the management view (may be absent on map rows)
    type: row.type || null,
    ownership_status: row.ownership_status || null,
    physical_status: row.physical_status || 'unknown',
    tracking_reference: row.tracking_reference || null,
    plate_number: row.plate_number || null,
    vin: row.vin || null,
    make: row.make || null,
    model: row.model || null,
    pending_event_id: row.pending_event_id != null ? Number(row.pending_event_id) : null,
    updated_at: row.updated_at || null,
  };
  state.map_marker = buildMapMarker(state);
  // Whether this trailer can be placed on the map: it has coordinates OR it is
  // with a driver (frontend derives coordinates from the truck marker).
  state.mappable = state.lat != null || state.possession_status === 'with_driver';
  state.source_event = row.last_event_id != null ? { id: Number(row.last_event_id), type: row.last_event_type || null, at: row.last_event_at || null } : null;
  return state;
}

/** All trailer states, normalized. Fail-soft: returns [] on any error. */
async function getUnifiedTrailerStates(opts = {}) {
  try {
    const rows = await db.getUnifiedTrailerStates(opts);
    return rows.map(normalizeState);
  } catch (err) {
    console.warn('[TRAILER-STATE] getUnifiedTrailerStates failed (degrading to empty):', err.message);
    return [];
  }
}

/** One trailer's normalized state, or null. Fail-soft. */
async function getUnifiedTrailerStateById(trailerId) {
  try {
    const row = await db.getUnifiedTrailerStateById(trailerId);
    return row ? normalizeState(row) : null;
  } catch (err) {
    console.warn('[TRAILER-STATE] getUnifiedTrailerStateById failed:', err.message);
    return null;
  }
}

/**
 * Operational map payload for the Dispatch Map: mappable trailers (with markers)
 * plus a `noLocation` list (needs-review or no coordinates). Trucks are merged in
 * by the caller/frontend. Fail-soft: returns an empty payload on any error.
 */
async function getTrailerMapPayload(opts = {}) {
  try {
    const states = await getUnifiedTrailerStates(opts);
    const trailers = [];
    const noLocation = [];
    for (const s of states) {
      if (s.mappable) trailers.push(s);
      else noLocation.push({ trailer_id: s.trailer_id, unit_number: s.unit_number, display_status: s.display_status, reason: s.needs_review ? 'needs review' : 'no mappable location' });
    }
    return { trailers, noLocation, meta: { count: states.length, generatedAt: new Date().toISOString() } };
  } catch (err) {
    console.warn('[TRAILER-STATE] getTrailerMapPayload failed:', err.message);
    return { trailers: [], noLocation: [], meta: { count: 0, error: true } };
  }
}

module.exports = {
  getUnifiedTrailerStates,
  getUnifiedTrailerStateById,
  getTrailerMapPayload,
  // pure helpers (exported for reuse + tests)
  normalizeState,
  buildDisplayStatus,
  buildMapMarker,
  markerColor,
  normPossession,
  normCargo,
  COLOR,
};
