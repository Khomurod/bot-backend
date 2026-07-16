/**
 * When does a route's tracking start?
 *
 * The two decision functions (`normalizeTrackingOptions`, `evaluateTrackingStart`)
 * are PURE — no DB, no network — so every start mode is unit-tested
 * deterministically. `startTrackingNow` is the one persistence operation and is
 * kept explicitly separate from them.
 */
const rc = require('../../database/routeControl');
const { classifyPoint } = require('../googleMapsUrlParser');
const { haversineMeters } = require('../routeGeometry');
const { serviceError } = require('./errors');
const { TRACKING_START_MODES, DEFAULT_START_RADIUS_MILES, METERS_PER_MILE } = require('./constants');

/**
 * PURE. Validate + normalize the tracking start options for a new assignment.
 * Defaults: Telegram-assigned routes keep the legacy immediate start; admin
 * assignments start only after the route message reaches the driver group
 * (regardless of whether "send now" was checked — an unsent message simply
 * holds tracking as pending until a later manual send).
 *
 * @returns {{ trackingStatus:'active'|'pending', trackingStartMode:string,
 *             trackingStartAt:(string|null), trackingStartLat:(number|null),
 *             trackingStartLng:(number|null), trackingStartLocationText:(string|null),
 *             trackingStartRadiusMiles:(number|null), trackingHoldReason:(string|null) }}
 */
function normalizeTrackingOptions({ tracking = null, source = 'admin' } = {}) {
  const t = tracking || {};
  let mode = String(t.startMode || '').trim();
  if (mode && !TRACKING_START_MODES.includes(mode)) {
    throw serviceError('BAD_TRACKING_MODE',
      `Unknown tracking start mode "${mode}". Use one of: ${TRACKING_START_MODES.join(', ')}.`, 400);
  }
  if (!mode) mode = source === 'telegram' ? 'immediate' : 'after_message_sent';

  const out = {
    trackingStatus: mode === 'immediate' ? 'active' : 'pending',
    trackingStartMode: mode,
    trackingStartAt: null,
    trackingStartLat: null,
    trackingStartLng: null,
    trackingStartLocationText: null,
    trackingStartRadiusMiles: null,
    trackingHoldReason: null,
  };

  if (mode === 'after_message_sent') {
    out.trackingHoldReason = 'waiting_for_message';
  } else if (mode === 'scheduled_time') {
    const at = new Date(String(t.startAt || ''));
    if (!t.startAt || Number.isNaN(at.getTime())) {
      throw serviceError('BAD_TRACKING_TIME',
        'Scheduled tracking start needs a valid date/time.', 400);
    }
    out.trackingStartAt = at.toISOString();
    out.trackingHoldReason = 'waiting_for_time';
  } else if (mode === 'start_location') {
    const raw = String(t.startLocation || '').trim();
    if (!raw) {
      throw serviceError('BAD_TRACKING_LOCATION',
        'Start-location tracking needs a location.', 400);
    }
    const point = classifyPoint(raw);
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
      throw serviceError('START_LOCATION_NEEDS_COORDS',
        'Enter the start location as coordinates — e.g. "35.2331, -85.7095" '
        + '(right-click the spot in Google Maps and copy the lat, lng).', 400);
    }
    out.trackingStartLat = point.lat;
    out.trackingStartLng = point.lng;
    out.trackingStartLocationText = raw;
    const radius = Number(t.startRadiusMiles);
    out.trackingStartRadiusMiles = Number.isFinite(radius) && radius > 0
      ? Math.min(100, Math.max(0.25, radius))
      : DEFAULT_START_RADIUS_MILES;
    out.trackingHoldReason = 'waiting_for_location';
  }
  return out;
}

/**
 * PURE. Decide whether a PENDING assignment's tracking should start now.
 * @returns {{ shouldStart:boolean, holdReason:(string|null), reason:string }}
 */
function evaluateTrackingStart({ assignment, location = null, now = new Date() }) {
  if (!assignment || assignment.tracking_status !== 'pending') {
    return { shouldStart: false, holdReason: null, reason: 'tracking is not pending' };
  }
  const mode = assignment.tracking_start_mode || 'immediate';
  if (mode === 'immediate') {
    return { shouldStart: true, holdReason: null, reason: 'immediate start mode' };
  }
  if (mode === 'after_message_sent') {
    if (assignment.driver_group_message_sent_at) {
      return { shouldStart: true, holdReason: null, reason: 'route message delivered to the driver group' };
    }
    return { shouldStart: false, holdReason: 'waiting_for_message', reason: 'waiting for the route message to be sent to the driver group' };
  }
  if (mode === 'scheduled_time') {
    const at = assignment.tracking_start_at ? new Date(assignment.tracking_start_at).getTime() : NaN;
    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    if (Number.isFinite(at) && nowMs >= at) {
      return { shouldStart: true, holdReason: null, reason: 'scheduled start time reached' };
    }
    return { shouldStart: false, holdReason: 'waiting_for_time', reason: 'waiting for the scheduled start time' };
  }
  if (mode === 'start_location') {
    const lat = Number(assignment.tracking_start_lat);
    const lng = Number(assignment.tracking_start_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { shouldStart: false, holdReason: 'waiting_for_location', reason: 'start location has no coordinates' };
    }
    if (!location || location.latitude == null || location.longitude == null) {
      return { shouldStart: false, holdReason: 'waiting_for_location', reason: 'waiting for GPS to reach the start location' };
    }
    const radiusMiles = Number(assignment.tracking_start_radius_miles) > 0
      ? Number(assignment.tracking_start_radius_miles) : DEFAULT_START_RADIUS_MILES;
    const meters = haversineMeters([location.latitude, location.longitude], [lat, lng]);
    if (meters != null && meters <= radiusMiles * METERS_PER_MILE) {
      return { shouldStart: true, holdReason: null, reason: `driver is within ${radiusMiles} mi of the start location` };
    }
    return { shouldStart: false, holdReason: 'waiting_for_location', reason: 'driver has not reached the start location yet' };
  }
  // Unknown mode (future value?) — fail open so a route is never silently stuck.
  return { shouldStart: true, holdReason: null, reason: `unknown start mode "${mode}" — starting tracking` };
}

/**
 * Manually start tracking for a pending assignment ("Start tracking now" in the
 * admin UI). Only active (lifecycle) routes can start; already-active tracking
 * is a no-op.
 */
async function startTrackingNow(assignmentId, startedBy = null) {
  const assignment = await rc.getRouteAssignment(assignmentId);
  if (!assignment) throw serviceError('NOT_FOUND', 'Route assignment not found.', 404);
  if (assignment.status !== 'active') {
    throw serviceError('NOT_ACTIVE', `Tracking cannot start on a ${assignment.status} route.`, 400);
  }
  if (assignment.tracking_status === 'active') {
    return { alreadyActive: true, assignment };
  }
  const updated = await rc.activateTracking(assignmentId);
  await rc.insertRouteMonitorEvent({
    assignmentId,
    eventType: 'tracking_started',
    detail: `tracking started manually${startedBy ? ` by ${startedBy}` : ''}`,
  });
  return { alreadyActive: false, assignment: updated || assignment };
}

module.exports = {
  normalizeTrackingOptions,
  evaluateTrackingStart,
  startTrackingNow,
};
