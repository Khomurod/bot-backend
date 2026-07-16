/**
 * Route assignment lifecycle: create, replace, cancel and (re)compute geometry.
 *
 * Orchestration only — parsing/geometry live in geometryService, wording in
 * messageFormatter, tracking validation in trackingStartService. This module
 * decides the ORDER of those steps and owns the persistence calls.
 */
const db = require('../../database/db');
const rc = require('../../database/routeControl');
const gmaps = require('../../database/gmapsSettings');
const googleClient = require('../googleMapsClient');
const { classifyPoint } = require('../googleMapsUrlParser');
const { serviceError } = require('./errors');
const { pointText, parseRouteLink, resolveDestinationCoords } = require('./geometryService');
const { describeTrackingStartCondition } = require('./messageFormatter');
const { normalizeTrackingOptions } = require('./trackingStartService');

/**
 * Assign a route to a driver group. Parses the link (or uses a manual
 * origin/destination/waypoints override), computes geometry when GMaps is
 * configured, and stores the assignment. Returns `{ assignment, computed }`.
 */
async function assignRoute({
  groupId, url, assignedBy, manual = null,
  source = 'admin', assignedByUserId = null, telegramChatId = null, telegramMessageId = null,
  tracking = null,
}) {
  if (!groupId) throw serviceError('NO_GROUP', 'Select a driver group for this route.', 400);
  if (!url && !manual) throw serviceError('NO_URL', 'Paste a Google Maps directions link.', 400);

  // Validate tracking options FIRST so a bad mode/time/location fails the
  // request before anything is stored.
  const trackingOpts = normalizeTrackingOptions({ tracking, source });

  let origin;
  let destination;
  let waypoints = [];
  if (manual && manual.origin && manual.destination) {
    origin = classifyPoint(manual.origin);
    destination = classifyPoint(manual.destination);
    waypoints = (manual.waypoints || []).map(classifyPoint);
  } else {
    const parsed = await parseRouteLink(url);
    origin = parsed.origin;
    destination = parsed.destination;
    waypoints = parsed.waypoints || [];
  }

  // Best-effort driver label / unit for display.
  let driverLabel = null;
  let unitNumber = null;
  let driverProfileId = null;
  try {
    const profile = await db.getDriverProfileByGroupId(groupId);
    if (profile) {
      driverProfileId = profile.id || null;
      unitNumber = profile.unit_number || null;
      driverLabel = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() || null;
    }
  } catch (_) { /* label is cosmetic */ }

  // Compute geometry when GMaps is configured; otherwise store the parsed link
  // and let the admin compute it once a key is entered (monitoring stays idle).
  const cfg = await gmaps.getGmapsConfig();
  let computed = null;
  if (cfg.enabled && cfg.routesApiEnabled && cfg.serverApiKey) {
    computed = await googleClient.computeRoute({ origin, destination, waypoints }, { cfg });
  }

  // Final-destination coordinates: the parsed/manual point, else the END of the
  // computed polyline (see geometryService.resolveDestinationCoords). Without
  // this, address-destination routes stored NULL destination coordinates and
  // could never auto-complete.
  const { lat: destinationLat, lng: destinationLng } = resolveDestinationCoords({
    lat: destination.lat,
    lng: destination.lng,
    encodedPolyline: computed?.encodedPolyline,
  });

  const assignment = await rc.createRouteAssignment({
    groupId,
    driverProfileId,
    driverLabel,
    unitNumber,
    originalUrl: url || '(manual entry)',
    originText: pointText(origin),
    destinationText: pointText(destination),
    waypoints: waypoints.map((w) => ({ raw: w.raw, lat: w.lat, lng: w.lng })),
    originLat: origin.lat, originLng: origin.lng,
    destinationLat, destinationLng,
    encodedPolyline: computed?.encodedPolyline || null,
    distanceMeters: computed?.distanceMeters || null,
    durationSeconds: computed?.durationSeconds || null,
    assignedBy,
    source,
    assignedByUserId,
    telegramChatId,
    telegramMessageId,
    ...trackingOpts,
  });
  const originDetail = source === 'telegram'
    ? `assigned from Telegram${assignedBy ? ` by ${assignedBy}` : ''}`
    : 'assigned';
  await rc.insertRouteMonitorEvent({
    assignmentId: assignment.id,
    eventType: 'assigned',
    detail: `${originDetail} — ${computed ? 'route computed' : 'GMaps not configured, geometry pending'}`,
  });
  if (trackingOpts.trackingStatus === 'pending') {
    await rc.insertRouteMonitorEvent({
      assignmentId: assignment.id,
      eventType: 'tracking_pending',
      detail: `tracking will start: ${describeTrackingStartCondition(assignment)}`,
    });
  }

  return {
    assignment,
    computed: Boolean(computed),
    geometryPending: !computed,
    trackingStatus: assignment.tracking_status,
    trackingStartMode: assignment.tracking_start_mode,
  };
}

/**
 * Cancel every active assignment for a driver group and record a 'cancelled'
 * event on each (used when a new Telegram route replaces the current one).
 * @returns {Promise<number>} how many were cancelled
 */
async function cancelActiveRoutesForGroup(groupId, { detail } = {}) {
  let cancelled = 0;
  for (;;) {
    const active = await rc.getActiveRouteAssignmentByGroupId(groupId);
    if (!active) break;
    await rc.setRouteAssignmentStatus(active.id, 'cancelled');
    await rc.insertRouteMonitorEvent({
      assignmentId: active.id,
      eventType: 'cancelled',
      detail: detail || 'cancelled',
    });
    cancelled += 1;
    if (cancelled > 25) break; // safety valve — should only ever be 1
  }
  return cancelled;
}

/** Compute (or recompute) geometry for an existing assignment. */
async function computeGeometryForAssignment(id) {
  const assignment = await rc.getRouteAssignment(id);
  if (!assignment) throw serviceError('NOT_FOUND', 'Route assignment not found.', 404);
  const cfg = await gmaps.getGmapsConfig();
  const origin = { raw: assignment.origin_text, lat: assignment.origin_lat, lng: assignment.origin_lng };
  const destination = {
    raw: assignment.destination_text, lat: assignment.destination_lat, lng: assignment.destination_lng,
  };
  const waypoints = Array.isArray(assignment.waypoints) ? assignment.waypoints : [];
  const computed = await googleClient.computeRoute({ origin, destination, waypoints }, { cfg });
  // Backfill the final-destination coordinates from the computed polyline end
  // when the stored ones are missing, so recomputing geometry also unblocks
  // auto-completion for an address-only destination.
  const { lat: destinationLat, lng: destinationLng } = resolveDestinationCoords({
    lat: assignment.destination_lat,
    lng: assignment.destination_lng,
    encodedPolyline: computed.encodedPolyline,
  });
  return rc.setRouteAssignmentGeometry(id, {
    originText: assignment.origin_text,
    destinationText: assignment.destination_text,
    waypoints,
    originLat: assignment.origin_lat,
    originLng: assignment.origin_lng,
    destinationLat,
    destinationLng,
    encodedPolyline: computed.encodedPolyline,
    distanceMeters: computed.distanceMeters,
    durationSeconds: computed.durationSeconds,
  });
}

module.exports = {
  assignRoute,
  cancelActiveRoutesForGroup,
  computeGeometryForAssignment,
};
