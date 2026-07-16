/**
 * Route geometry + link parsing for Route Control.
 *
 * Owns everything that turns a Google Maps link (or a manual entry) into
 * origin / destination / waypoints, and everything that reads coordinates back
 * out of a computed route. No DB, no Telegram — `parseRouteLink` is the only
 * network-touching function (short-link expansion).
 */
const { parseDirectionsUrl, expandShortLink } = require('../googleMapsUrlParser');
const { decodePolyline } = require('../routeGeometry');
const { serviceError } = require('./errors');

/** PURE. Display text for a parsed point: its raw label, else "lat, lng". */
function pointText(point) {
  if (!point) return null;
  if (Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
    return point.raw || `${point.lat}, ${point.lng}`;
  }
  return point.raw || null;
}

/** True when a coordinate value is present AND numeric (null/undefined are NOT
 *  coordinates — Number(null) === 0 must never masquerade as one). */
function hasFiniteCoord(value) {
  return value != null && Number.isFinite(Number(value));
}

/**
 * PURE. The FINAL destination coordinate implied by a computed route: the LAST
 * point of the encoded polyline (Google routes end exactly at the destination).
 * This is the authoritative destination when the parsed link/manual entry gave
 * only an address (no lat/lng) — it needs no geocoding and is never a waypoint.
 *
 * @returns {{ lat:number, lng:number }|null} null when the polyline is empty.
 */
function destinationCoordFromPolyline(encodedPolyline) {
  const points = decodePolyline(encodedPolyline || '');
  if (!points.length) return null;
  const [lat, lng] = points[points.length - 1];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * Resolve the FINAL destination coordinates for a route: prefer the coordinates
 * the parse/manual entry gave us, else fall back to the END of the computed
 * polyline — the exact point Google routed to. Without this, address-only
 * destinations store NULL coordinates and can never auto-complete. Never a
 * waypoint.
 *
 * @returns {{ lat:(number|null|undefined), lng:(number|null|undefined) }}
 */
function resolveDestinationCoords({ lat, lng, encodedPolyline }) {
  if (hasFiniteCoord(lat) && hasFiniteCoord(lng)) return { lat, lng };
  if (!encodedPolyline) return { lat, lng };
  const derived = destinationCoordFromPolyline(encodedPolyline);
  return derived ? { lat: derived.lat, lng: derived.lng } : { lat, lng };
}

/**
 * Parse a Google Maps directions link into origin / destination / waypoints,
 * expanding a shortened link when needed. Never computes/stores anything — backs
 * the "Test parse route" action. Throws a CLEAR error when unparseable.
 */
async function parseRouteLink(url) {
  let parsed = parseDirectionsUrl(url);
  if (!parsed.parseable && parsed.isShortLink) {
    try {
      const expanded = await expandShortLink(url);
      parsed = parseDirectionsUrl(expanded);
      parsed.expandedUrl = expanded;
    } catch (err) {
      throw serviceError('UNPARSEABLE_LINK',
        `Could not expand this shortened Google Maps link (${err.message}). `
        + 'Paste the full directions link, or enter origin, destination and waypoints manually.', 422);
    }
  }
  if (!parsed.parseable) {
    // A place pin / bare map view (e.g. a shortened link that redirects to
    // `/maps/@lat,lng`) is a distinct, common case — give it its own code so the
    // UI can point the user at Directions or manual origin/destination entry.
    const code = parsed.placeOrMapView ? 'PLACE_OR_MAP_VIEW' : 'UNPARSEABLE_LINK';
    throw serviceError(code, parsed.reason, 422);
  }
  return parsed;
}

module.exports = {
  pointText,
  hasFiniteCoord,
  destinationCoordFromPolyline,
  resolveDestinationCoords,
  parseRouteLink,
};
