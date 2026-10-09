/**
 * A route's polyline, read only when the monitor needs it and kept until it
 * changes.
 *
 * OWNER of `remembered`, the in-memory copy keyed by assignment id. The monitor
 * pass reads its routes WITHOUT the polyline — the largest column in the row —
 * because only two things use it: an off-route check (a tracking-active route
 * with Settings → GMaps on) and the repair of a missing final destination from
 * the polyline's end. Each row carries the polyline's md5 instead
 * (`polyline_version`, NULL when there is none); the polyline is fetched the
 * first time it is needed and the same copy serves every later tick until the
 * fingerprint changes, i.e. the route was recomputed. `updated_at` could not be
 * that version: every monitor write moves it.
 *
 * Bounded by the active routes: each pass hands over its route ids and every
 * other entry is dropped.
 *
 * A row read whole (`SELECT r.*` — the admin completion check still reads
 * those) already carries its polyline and is used as it is.
 */
const rc = require('../../database/routeControl');

const remembered = new Map();
const has = (row, key) => Object.prototype.hasOwnProperty.call(row, key);

/**
 * The route's encoded polyline, or null. It is also set on the row as
 * `encoded_polyline`, so the pure evaluators read it exactly as they read a
 * whole row. A failed fetch throws; the caller's per-route handling applies.
 */
async function loadRoutePolyline(assignment) {
  if (!assignment) return null;
  if (has(assignment, 'encoded_polyline') || !has(assignment, 'polyline_version')) {
    return assignment.encoded_polyline ?? null;
  }
  let polyline = null;
  if (assignment.polyline_version == null) {
    remembered.delete(assignment.id);
  } else {
    const kept = remembered.get(assignment.id);
    if (kept && kept.version === assignment.polyline_version) {
      polyline = kept.polyline;
    } else {
      const fresh = await rc.getAssignmentPolyline(assignment.id);
      polyline = fresh?.encoded_polyline ?? null;
      if (fresh?.polyline_version != null) {
        remembered.set(assignment.id, { version: fresh.polyline_version, polyline });
      } else {
        remembered.delete(assignment.id);
      }
    }
  }
  assignment.encoded_polyline = polyline;
  return polyline;
}

/** Forget every route the current pass no longer has. */
function retainRoutePolylines(ids) {
  const keep = new Set(ids);
  for (const id of remembered.keys()) {
    if (!keep.has(id)) remembered.delete(id);
  }
}

module.exports = { loadRoutePolyline, retainRoutePolylines };
