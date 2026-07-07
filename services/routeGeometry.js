/**
 * Route geometry — pure helpers for Route Control.
 *
 * Side-effect free (no network, no DB) so the deviation math can be unit-tested
 * deterministically. Distances are in meters. Points are [lat, lng] pairs.
 */

const EARTH_RADIUS_M = 6_371_000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Decode a Google "encoded polyline" string into an array of [lat, lng] pairs.
 * Standard algorithm (precision 5), matching Routes API `encodedPolyline`.
 */
function decodePolyline(encoded, precision = 5) {
  if (typeof encoded !== 'string' || !encoded) return [];
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push([lat / factor, lng / factor]);
  }
  return points;
}

/** Great-circle distance between two [lat, lng] points, in meters. */
function haversineMeters(a, b) {
  const lat1 = toRadians(a[0]);
  const lat2 = toRadians(b[0]);
  const dLat = toRadians(b[0] - a[0]);
  const dLng = toRadians(b[1] - a[1]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Project [lat, lng] onto a local planar frame (meters east/north) centered on
 * `origin`. Good enough for the short segment distances we care about (truck
 * lane widths → a few hundred meters), and cheap.
 */
function toLocalMeters(point, origin) {
  const x = toRadians(point[1] - origin[1]) * Math.cos(toRadians(origin[0])) * EARTH_RADIUS_M;
  const y = toRadians(point[0] - origin[0]) * EARTH_RADIUS_M;
  return [x, y];
}

/** Perpendicular distance (meters) from a point to a single segment [a, b]. */
function distancePointToSegmentMeters(point, a, b) {
  // Work in a local planar frame centered on `a`.
  const p = toLocalMeters(point, a);
  const bb = toLocalMeters(b, a);
  const segLenSq = bb[0] * bb[0] + bb[1] * bb[1];
  if (segLenSq === 0) {
    return Math.hypot(p[0], p[1]); // degenerate segment → distance to the point
  }
  let t = (p[0] * bb[0] + p[1] * bb[1]) / segLenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = t * bb[0];
  const projY = t * bb[1];
  return Math.hypot(p[0] - projX, p[1] - projY);
}

/**
 * Minimum distance (meters) from a point to a polyline (array of [lat, lng]).
 * Returns null when the polyline has no usable geometry.
 */
function distancePointToPolylineMeters(point, polyline) {
  if (!Array.isArray(polyline) || polyline.length === 0 || !Array.isArray(point)) {
    return null;
  }
  if (polyline.length === 1) {
    return haversineMeters(point, polyline[0]);
  }
  let min = Infinity;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const d = distancePointToSegmentMeters(point, polyline[i], polyline[i + 1]);
    if (d < min) min = d;
  }
  return Number.isFinite(min) ? min : null;
}

module.exports = {
  decodePolyline,
  haversineMeters,
  distancePointToSegmentMeters,
  distancePointToPolylineMeters,
};
