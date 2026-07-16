/**
 * Recovery of missing final-destination coordinates on an EXISTING assignment.
 *
 * Two free paths first (route polyline end, then coordinates embedded in the
 * destination text), and only then a BOUNDED geocoding attempt. Coordinates are
 * never invented, and geocoding never runs on every monitor tick.
 */
const rc = require('../../database/routeControl');
const { classifyPoint } = require('../googleMapsUrlParser');
const { destinationCoordFromPolyline } = require('./geometryService');
const {
  DESTINATION_REPAIR_MAX_ATTEMPTS,
  DESTINATION_REPAIR_MIN_INTERVAL_MS,
} = require('./constants');

/** Persist repaired coordinates, mutate the in-memory row, and audit it. */
async function applyRepair(assignment, { lat, lng, detail }) {
  await rc.setRouteAssignmentDestinationCoords(assignment.id, { lat, lng });
  assignment.destination_lat = lat;
  assignment.destination_lng = lng;
  await rc.insertRouteMonitorEvent({
    assignmentId: assignment.id,
    eventType: 'destination_repaired',
    detail,
  });
  return { repaired: true };
}

/**
 * Safe, BOUNDED repair of missing final-destination coordinates on an existing
 * assignment. Free text-parse first (the destination may literally be
 * "lat, lng"); then the shared geocoding cascade (Nominatim → Photon → Google),
 * at most DESTINATION_REPAIR_MAX_ATTEMPTS times per assignment and never more
 * often than DESTINATION_REPAIR_MIN_INTERVAL_MS — NEVER on every tick, and
 * coordinates are never invented. Mutates the in-memory row on success so the
 * current pass can use the repaired coordinates immediately.
 */
async function maybeRepairDestinationCoordinates(assignment) {
  // Free path #1: the computed route polyline already ends AT the final
  // destination. No network, no attempt budget — this is how existing routes
  // (address-only destination, geometry already computed) self-heal on the next
  // monitor tick after deploy/restart.
  const fromPolyline = destinationCoordFromPolyline(assignment?.encoded_polyline);
  if (fromPolyline) {
    return applyRepair(assignment, {
      lat: fromPolyline.lat,
      lng: fromPolyline.lng,
      detail: 'final destination coordinates recovered from the computed route polyline',
    });
  }

  const text = String(assignment?.destination_text || '').trim();
  if (!text) return { repaired: false, reason: 'no destination text to repair from' };

  // Free path #2: coordinates embedded in the destination text.
  const parsed = classifyPoint(text);
  if (Number.isFinite(parsed?.lat) && Number.isFinite(parsed?.lng)) {
    return applyRepair(assignment, {
      lat: parsed.lat,
      lng: parsed.lng,
      detail: 'final destination coordinates parsed from the stored destination text',
    });
  }

  const attempts = Number(assignment.destination_repair_attempts) || 0;
  if (attempts >= DESTINATION_REPAIR_MAX_ATTEMPTS) {
    return { repaired: false, reason: 'repair attempts exhausted' };
  }
  const lastAt = assignment.destination_repair_last_at
    ? new Date(assignment.destination_repair_last_at).getTime() : 0;
  if (lastAt && Date.now() - lastAt < DESTINATION_REPAIR_MIN_INTERVAL_MS) {
    return { repaired: false, reason: 'repair attempted recently' };
  }

  await rc.recordDestinationRepairAttempt(assignment.id);
  assignment.destination_repair_attempts = attempts + 1;
  assignment.destination_repair_last_at = new Date().toISOString();
  try {
    // Lazy require: keeps startup light and avoids loading the ETA stack unless
    // a repair is actually needed.
    const { geocodePlace } = require('../etaRoutingService');
    const geo = await geocodePlace(text);
    const lat = Number(geo?.latitude);
    const lng = Number(geo?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return applyRepair(assignment, {
        lat,
        lng,
        detail: `final destination geocoded from text (attempt ${attempts + 1}/${DESTINATION_REPAIR_MAX_ATTEMPTS})`,
      });
    }
    await rc.insertRouteMonitorEvent({
      assignmentId: assignment.id,
      eventType: 'destination_repair_failed',
      detail: `geocoding returned no result (attempt ${attempts + 1}/${DESTINATION_REPAIR_MAX_ATTEMPTS})`,
    });
  } catch (err) {
    await rc.insertRouteMonitorEvent({
      assignmentId: assignment.id,
      eventType: 'destination_repair_failed',
      detail: `geocoding failed: ${String(err.message || err).slice(0, 200)} (attempt ${attempts + 1}/${DESTINATION_REPAIR_MAX_ATTEMPTS})`,
    }).catch(() => {});
  }
  return { repaired: false, reason: 'geocoding did not resolve the destination' };
}

module.exports = { maybeRepairDestinationCoordinates };
