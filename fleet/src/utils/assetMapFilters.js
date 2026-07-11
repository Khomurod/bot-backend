/**
 * Pure asset-map filtering helpers (trucks + trailers) for operational maps
 * (Dispatch Map; mirrored in admin for Live Locations).
 *
 * These helpers ONLY hide/show what the backend already decided. They never
 * reclassify business state: possession_status, cargo_status, needs_review and
 * location_source all come from the unified TrailerStateService payload.
 * The single frontend-side derivation is POSITION: a with-driver trailer
 * renders at its matched live truck's coordinates ("derived_from_driver"),
 * which is presentation, not business status.
 *
 * Everything here is pure (no React, no Leaflet, no IO) so it is unit-testable
 * and shared by the map layer and the side list — both MUST consume the same
 * filtered result.
 */

export const ASSET_VIEWS = ['all', 'trucks', 'trailers'];
export const POSSESSION_FILTERS = ['all', 'with_driver', 'dropped', 'unknown'];
export const CARGO_FILTERS = ['all', 'loaded', 'empty', 'unknown'];
export const REVIEW_FILTERS = ['all', 'needs_review', 'confirmed'];
export const LOCATION_QUALITY_FILTERS = ['all', 'exact', 'derived_from_driver', 'approximate', 'missing'];

export const DEFAULT_FILTERS = Object.freeze({
  assetView: 'all',
  trailerPossession: 'all',
  trailerCargo: 'all',
  trailerReview: 'all',
  locationQuality: 'all',
});

/** Quick-filter chips: each sets the underlying dimensions (no second logic). */
export const QUICK_FILTERS = [
  { key: 'dropped_empty', label: 'Dropped / Empty', patch: { assetView: 'trailers', trailerPossession: 'dropped', trailerCargo: 'empty' } },
  { key: 'dropped_loaded', label: 'Dropped / Loaded', patch: { assetView: 'trailers', trailerPossession: 'dropped', trailerCargo: 'loaded' } },
  { key: 'with_driver', label: 'With driver', patch: { assetView: 'trailers', trailerPossession: 'with_driver' } },
  { key: 'needs_review', label: 'Needs review', patch: { assetView: 'trailers', trailerReview: 'needs_review' } },
  { key: 'location_missing', label: 'Location missing', patch: { assetView: 'trailers', locationQuality: 'missing' } },
];

/**
 * Validate persisted/unknown filter values; anything invalid (old version,
 * corrupted storage, renamed options) falls back to the safe default.
 */
export function sanitizeFilters(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    assetView: ASSET_VIEWS.includes(src.assetView) ? src.assetView : DEFAULT_FILTERS.assetView,
    trailerPossession: POSSESSION_FILTERS.includes(src.trailerPossession) ? src.trailerPossession : DEFAULT_FILTERS.trailerPossession,
    trailerCargo: CARGO_FILTERS.includes(src.trailerCargo) ? src.trailerCargo : DEFAULT_FILTERS.trailerCargo,
    trailerReview: REVIEW_FILTERS.includes(src.trailerReview) ? src.trailerReview : DEFAULT_FILTERS.trailerReview,
    locationQuality: LOCATION_QUALITY_FILTERS.includes(src.locationQuality) ? src.locationQuality : DEFAULT_FILTERS.locationQuality,
  };
}

/** Normalize a driver/group name for truck↔trailer matching. */
export function normalizeDriverName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Build a driver-name → position index ONCE per snapshot (no O(n²) matching).
 * `entries` is shape-neutral: [{ names: [..], lat, lng, unit }]. Pages adapt
 * their own truck payload into entries. The index includes EVERY truck, even
 * ones hidden by the current view — hidden truck data must stay available for
 * trailer coordinate derivation.
 */
export function buildDriverPositionIndex(entries) {
  const index = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.lat == null || e.lng == null) continue;
    for (const name of e.names || []) {
      const key = normalizeDriverName(name);
      if (key && !index.has(key)) index.set(key, { lat: e.lat, lng: e.lng, unit: e.unit || null });
    }
  }
  return index;
}

/**
 * Resolve where a trailer renders. A with-driver trailer rides with its
 * matched truck (derived_from_driver); otherwise its own coordinates are used.
 * Returns { lat, lng, derived, derivedFromUnit } — lat/lng null when the
 * trailer has no usable position (side-list only, no marker).
 */
export function resolveTrailerPosition(trailer, driverIndex) {
  const t = trailer || {};
  let lat = t.lat != null ? t.lat : (t.current_lat != null ? t.current_lat : null);
  let lng = t.lng != null ? t.lng : (t.current_lng != null ? t.current_lng : null);
  let derived = false;
  let derivedFromUnit = null;
  if ((t.possession_status || t.current_status) === 'with_driver' && driverIndex) {
    const hit = driverIndex.get(normalizeDriverName(t.current_driver_name));
    if (hit) {
      lat = hit.lat;
      lng = hit.lng;
      derived = true;
      derivedFromUnit = hit.unit;
    }
  }
  return { lat, lng, derived, derivedFromUnit };
}

/**
 * Location quality from the backend-owned location_source (+ the frontend
 * position derivation). Never rewrites the backend value — this is a read-only
 * normalization for filtering:
 *   exact    : exact / manual / confident geocode
 *   derived_from_driver : position comes from the matched live truck
 *   approximate : approximate / approximate_state / low-confidence geocode
 *   missing  : no usable coordinates
 */
export function classifyLocationQuality(trailer, resolved) {
  const r = resolved || resolveTrailerPosition(trailer, null);
  if (r.derived) return 'derived_from_driver';
  if (r.lat == null || r.lng == null) return 'missing';
  const source = String(trailer?.location_source || 'exact');
  if (source === 'approximate' || source === 'approximate_state') return 'approximate';
  if (source === 'geocoded') {
    const conf = trailer?.location_confidence;
    return conf != null && Number(conf) < 60 ? 'approximate' : 'exact';
  }
  // exact / manual / derived-at-source / unknown-with-coords → exact bucket.
  return 'exact';
}

function trailerNeedsReview(t) {
  return Boolean(t?.needs_review || t?.status_needs_review);
}

/** One search haystack per asset. `kind` is 'truck' | 'trailer'. */
export function matchesAssetSearch(asset, query, kind) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const a = asset || {};
  const parts = kind === 'truck'
    ? [a.driver_name, a.unit, a.load_number, a.status, a.condition, a.location_text]
    : [a.unit_number, a.current_driver_name, a.location_text, a.current_location_text,
      a.plate_number, a.vin, a.condition_text, a.current_condition, a.display_status];
  return parts.filter(Boolean).join(' ').toLowerCase().includes(q);
}

/** Does one trailer pass the trailer filter dimensions (AND logic)? */
export function trailerMatchesFilters(trailer, filters, resolved) {
  const f = sanitizeFilters(filters);
  const t = trailer || {};
  if (f.trailerPossession !== 'all') {
    const p = t.possession_status || t.current_status || 'unknown';
    if (p !== f.trailerPossession) return false;
  }
  if (f.trailerCargo !== 'all') {
    const c = t.cargo_status || 'unknown';
    if (c !== f.trailerCargo) return false;
  }
  if (f.trailerReview !== 'all') {
    const review = trailerNeedsReview(t);
    if (f.trailerReview === 'needs_review' && !review) return false;
    if (f.trailerReview === 'confirmed' && review) return false;
  }
  if (f.locationQuality !== 'all') {
    if (classifyLocationQuality(t, resolved) !== f.locationQuality) return false;
  }
  return true;
}

/**
 * Filter trailers for BOTH the map and the side list. Returns
 * [{ trailer, position, quality }] — position.lat null means "list only, no
 * marker" (a missing-location trailer must still appear in the list).
 */
export function filterTrailers(trailers, filters, { driverIndex = null, search = '' } = {}) {
  const f = sanitizeFilters(filters);
  if (f.assetView === 'trucks') return [];
  const out = [];
  for (const t of Array.isArray(trailers) ? trailers : []) {
    const position = resolveTrailerPosition(t, driverIndex);
    if (!trailerMatchesFilters(t, f, position)) continue;
    if (!matchesAssetSearch(t, search, 'trailer')) continue;
    out.push({ trailer: t, position, quality: classifyLocationQuality(t, position) });
  }
  return out;
}

/**
 * Filter trucks. A truck's location quality is 'exact' when it has GPS
 * coordinates and 'missing' otherwise (noLocation list) — trucks are never
 * derived/approximate. Trailer-only dimensions do not apply to trucks.
 */
export function filterTrucks(trucks, filters, { search = '' } = {}) {
  const f = sanitizeFilters(filters);
  if (f.assetView === 'trailers') return [];
  const out = [];
  for (const truck of Array.isArray(trucks) ? trucks : []) {
    const hasLoc = truck && truck.latitude != null && truck.longitude != null;
    if (f.locationQuality !== 'all') {
      const quality = hasLoc ? 'exact' : 'missing';
      if (quality !== f.locationQuality) continue;
    }
    if (!matchesAssetSearch(truck, search, 'truck')) continue;
    out.push(truck);
  }
  return out;
}

/**
 * Snapshot-wide counts (BEFORE the category filters are applied) so dispatch
 * understands the whole fleet at a glance. Derived locally from the loaded
 * snapshot — never extra API calls.
 */
export function calculateAssetCounts({ trucks = [], trailers = [], driverIndex = null } = {}) {
  const counts = {
    trucks: (Array.isArray(trucks) ? trucks : []).length,
    trailers: 0,
    withDriver: 0,
    dropped: 0,
    unknownPossession: 0,
    loaded: 0,
    empty: 0,
    unknownCargo: 0,
    needsReview: 0,
    locationMissing: 0,
  };
  for (const t of Array.isArray(trailers) ? trailers : []) {
    counts.trailers += 1;
    const p = t.possession_status || t.current_status || 'unknown';
    if (p === 'with_driver') counts.withDriver += 1;
    else if (p === 'dropped') counts.dropped += 1;
    else counts.unknownPossession += 1;
    const c = t.cargo_status || 'unknown';
    if (c === 'loaded') counts.loaded += 1;
    else if (c === 'empty') counts.empty += 1;
    else counts.unknownCargo += 1;
    if (trailerNeedsReview(t)) counts.needsReview += 1;
    if (classifyLocationQuality(t, resolveTrailerPosition(t, driverIndex)) === 'missing') counts.locationMissing += 1;
  }
  return counts;
}

/**
 * The mappable points of the CURRENTLY VISIBLE (filtered) assets — used by
 * "Fit visible". Hidden trucks and filtered-out trailers are never included.
 */
export function getVisibleMapPoints(visibleTrucks, visibleTrailerEntries) {
  const pts = [];
  for (const truck of Array.isArray(visibleTrucks) ? visibleTrucks : []) {
    if (truck.latitude != null && truck.longitude != null) pts.push([truck.latitude, truck.longitude]);
  }
  for (const e of Array.isArray(visibleTrailerEntries) ? visibleTrailerEntries : []) {
    if (e.position && e.position.lat != null && e.position.lng != null) pts.push([e.position.lat, e.position.lng]);
  }
  return pts;
}

/**
 * Accessibility glyph shown INSIDE the trailer rectangle so state is never
 * color-only: E=Empty, L=Loaded, ?=Unknown cargo; ! overrides for needs-review.
 */
export function cargoGlyph(trailer) {
  if (trailerNeedsReview(trailer)) return '!';
  const c = trailer?.cargo_status || 'unknown';
  if (c === 'loaded') return 'L';
  if (c === 'empty') return 'E';
  return '?';
}

/** Accessible label for a trailer marker / list row. */
export function trailerAriaLabel(trailer, quality) {
  const t = trailer || {};
  const bits = [
    `Trailer ${t.unit_number || 'unknown'}`,
    t.display_status || null,
    trailerNeedsReview(t) ? 'needs review' : null,
    quality ? `location ${quality.replace(/_/g, ' ')}` : null,
  ];
  return bits.filter(Boolean).join(', ');
}
