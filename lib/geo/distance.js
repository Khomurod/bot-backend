'use strict';

/**
 * Great-circle distance — the one implementation.
 *
 * WHY IT IS HERE. There were two: `haversineMeters([lat,lng],[lat,lng])` in
 * services/routeGeometry.js (asin form, radius 6 371 000 m) and
 * `haversineMiles(lat1,lon1,lat2,lon2)` in services/etaRoutingService.js
 * (atan2 form, radius 3 958.8 mi). Same mathematics, two signatures, two
 * radii — and four consumers between them deciding "is the truck there yet":
 * route completion, off-route tracking, fuel-stop proximity and ETA remaining
 * distance. Two copies of a distance function is two chances for those answers
 * to disagree by a few hundred metres, on exactly the decisions where a few
 * hundred metres is the whole question.
 *
 * Both call shapes are kept, because both read naturally at their call sites
 * (route geometry works in `[lat, lng]` pairs; ETA works in scalars), and both
 * now derive from `haversineMeters` so there is one formula and one earth
 * radius. Unit conversion, not a second calculation.
 *
 * Pure: no I/O, no state. See lib/README.md.
 */

/** Mean earth radius. The value route geometry has always used. */
const EARTH_RADIUS_M = 6_371_000;
// The value services/routeControl/constants.js has always used for radius
// conversion; it re-exports this one now, so the tree holds a single number.
const METERS_PER_MILE = 1609.34;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance between two [lat, lng] points, in meters.
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number}
 */
function haversineMeters(a, b) {
  const lat1 = toRadians(a[0]);
  const lat2 = toRadians(b[0]);
  const dLat = toRadians(b[0] - a[0]);
  const dLng = toRadians(b[1] - a[1]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  // asin form with a clamp: floating-point error can push h just over 1 for
  // antipodal points, and Math.sqrt of that is NaN.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The same distance in statute miles, in the scalar call shape the ETA and
 * fuel-stop code uses.
 */
function haversineMiles(lat1, lon1, lat2, lon2) {
  return haversineMeters([lat1, lon1], [lat2, lon2]) / METERS_PER_MILE;
}

module.exports = {
  EARTH_RADIUS_M,
  METERS_PER_MILE,
  toRadians,
  haversineMeters,
  haversineMiles,
};
