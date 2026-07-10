/**
 * Shared trailer-state presentation helpers (Trailer Tracking + Dispatch Map).
 *
 * The BACKEND (services/trailerStateService.js) owns the business status —
 * possession_status, cargo_status, display_status and the map-marker style are
 * decided server-side. These helpers only READ those fields and turn them into
 * presentation (labels, marker CSS). They never re-decide the business status;
 * when the backend already provides display_status / map_marker they are used
 * verbatim, with a local fallback only for older payloads.
 */
const POSSESSION_LABEL = { with_driver: 'With driver', dropped: 'Dropped', unknown: 'Unknown' };
const CARGO_LABEL = { empty: 'Empty', loaded: 'Loaded', unknown: 'Unknown cargo' };

const COLOR = {
  droppedEmpty: '#f59e0b',
  droppedLoaded: '#a855f7',
  withDriverEmpty: '#22c55e',
  withDriverLoaded: '#8b5cf6',
  withDriverUnknown: '#3b82f6',
  unknown: '#8a94a4',
};

export function possessionStatusLabel(p) {
  return POSSESSION_LABEL[p] || 'Unknown';
}
export function cargoStatusLabel(c) {
  return CARGO_LABEL[c] || 'Unknown cargo';
}

function possessionOf(state) {
  return state.possession_status || state.current_status || 'unknown';
}
function cargoOf(state) {
  return state.cargo_status || 'unknown';
}

export function isDroppedLoaded(state) {
  return possessionOf(state) === 'dropped' && cargoOf(state) === 'loaded';
}
export function isDroppedEmpty(state) {
  return possessionOf(state) === 'dropped' && cargoOf(state) === 'empty';
}

/** Human display status, preferring the backend-computed value. */
export function displayTrailerStatus(state) {
  if (state.display_status) return state.display_status;
  const p = possessionOf(state);
  const c = cargoOf(state);
  const needsReview = Boolean(state.needs_review || state.status_needs_review);
  if (p === 'unknown') return needsReview ? 'Unknown / Needs review' : 'Unknown';
  const cargoLabel = c === 'unknown' ? 'Unknown cargo' : CARGO_LABEL[c];
  return `${POSSESSION_LABEL[p]} / ${cargoLabel}`;
}

/** Marker fill color from possession + cargo (fallback for the backend value). */
export function markerColor(state) {
  const p = possessionOf(state);
  const c = cargoOf(state);
  if (p === 'dropped') return c === 'loaded' ? COLOR.droppedLoaded : COLOR.droppedEmpty;
  if (p === 'with_driver') {
    if (c === 'loaded') return COLOR.withDriverLoaded;
    if (c === 'empty') return COLOR.withDriverEmpty;
    return COLOR.withDriverUnknown;
  }
  return COLOR.unknown;
}

/**
 * Rectangle marker style. Prefers the backend map_marker descriptor; falls back
 * to computing color/outline/dashed locally for older payloads.
 */
export function trailerMarkerStyle(state) {
  const mk = state.map_marker || {};
  const needsReview = Boolean(state.needs_review || state.status_needs_review);
  const source = state.location_source || (state.lat != null || state.current_lat != null ? 'exact' : 'unknown');
  return {
    shape: 'rectangle',
    color: mk.color || markerColor(state),
    outline: mk.outline || (needsReview ? '#ef4444' : '#ffffff'),
    dashed: mk.dashed != null ? mk.dashed : (source === 'approximate_state' || source === 'approximate'),
    attachedToDriver: mk.attached_to_driver != null ? mk.attached_to_driver : possessionOf(state) === 'with_driver',
    tooltip: mk.tooltip || `${state.unit_number} — ${displayTrailerStatus(state)}`,
  };
}

export { COLOR as TRAILER_COLORS };
