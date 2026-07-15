/**
 * Route Control service.
 *
 * Assigns a Google Maps directions link to a driver group (parsing the link and
 * computing route geometry via the Routes API), then periodically compares the
 * driver's live GPS to that route and warns the driver group when they drift off
 * it. All Google calls are server-side and gated on Settings → GMaps.
 *
 * Two independent concerns run in the monitor, with different gates:
 *   1. DESTINATION AUTO-COMPLETION — needs only stored destination coordinates,
 *      live ELD GPS and a haversine distance. It runs for EVERY lifecycle-active
 *      route (tracking active OR pending) and does NOT require Google Maps to
 *      be enabled: existing routes keep completing even with the GMaps switch
 *      off. Completion is silent (no driver-group message) and atomic.
 *   2. OFF-ROUTE WARNINGS — need computed route geometry, so they stay gated on
 *      Settings → GMaps `enabled` and only run for tracking-active routes.
 *
 * `evaluateAssignment` / `evaluateDestinationCompletion` are PURE decision
 * functions (no DB / network / telegram) so the logic is unit-tested
 * deterministically. The monitor loop is a thin wrapper around them.
 */
const db = require('../database/db');
const rc = require('../database/routeControl');
const gmaps = require('../database/gmapsSettings');
const googleClient = require('./googleMapsClient');
const { safeSend } = require('./telegramHtml');
const { parseDirectionsUrl, expandShortLink, classifyPoint } = require('./googleMapsUrlParser');
const { decodePolyline, distancePointToPolylineMeters, haversineMeters } = require('./routeGeometry');
const { resolveLiveLocationForGroupTitle } = require('./liveLocationResolver');
const { resolveDriverMentionForGroup, escapeHtml } = require('./driverMention');
const { ROUTE_COMPLETION_RADIUS_MILES } = require('./routeControlConstants');

const POLL_MS_MIN = 30 * 1000;
const METERS_PER_MILE = 1609.34;
// Default auto-complete radius (miles) when GMaps config omits it. The single
// authoritative value lives in routeControlConstants (50 mi).
const DEFAULT_COMPLETION_RADIUS_MILES = ROUTE_COMPLETION_RADIUS_MILES.DEFAULT;
// Boundary tolerance (meters): floating-point haversine at exactly the radius can
// land a hair over, so "exactly 50 miles" still completes while 50.01 mi (≈16 m
// past the radius) stays comfortably outside.
const COMPLETION_EPSILON_METERS = 1;
// Bounded destination-coordinate repair: at most this many geocode attempts per
// assignment, spaced at least this far apart — never on every monitor tick.
const DESTINATION_REPAIR_MAX_ATTEMPTS = 3;
const DESTINATION_REPAIR_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Machine-readable reasons written to route_assignments.completion_blocked_reason
// (surfaced verbatim in the Admin panel — keep them stable and PII-free).
const COMPLETION_BLOCKED = Object.freeze({
  DESTINATION_COORDINATES_MISSING: 'DESTINATION_COORDINATES_MISSING',
  LIVE_GPS_MISSING: 'LIVE_GPS_MISSING',
  LIVE_GPS_STALE: 'LIVE_GPS_STALE',
  UNIT_RESOLUTION_FAILED: 'UNIT_RESOLUTION_FAILED',
  OUTSIDE_COMPLETION_RADIUS: 'OUTSIDE_COMPLETION_RADIUS',
});
// Telegram caps photo captions at 1024 chars and text messages at 4096.
const TELEGRAM_CAPTION_MAX = 1024;
const TELEGRAM_TEXT_SAFE_MAX = 3900;
const TRACKING_START_MODES = ['immediate', 'after_message_sent', 'scheduled_time', 'start_location'];
const DEFAULT_START_RADIUS_MILES = 2;
let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let telegramClient = null;

function serviceError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function nowIso(now) {
  const d = now instanceof Date ? now : (now ? new Date(now) : new Date());
  return d.toISOString();
}

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
 * Map the stored GMaps config to the tunables the evaluators expect. Every
 * field falls back to a safe default so completion (which runs even when the
 * settings row is unavailable) never loses its stale-GPS protection.
 */
function monitorSettingsFromConfig(cfg) {
  const c = cfg || {};
  const numOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    deviationThresholdMeters: numOr(c.deviationThresholdMeters, 250),
    offRouteGraceChecks: numOr(c.offRouteGraceChecks, 3),
    warningCooldownMinutes: numOr(c.warningCooldownMinutes, 30),
    staleGpsMinutes: numOr(c.staleGpsMinutes, 15),
    parkedSpeedMph: numOr(c.parkedSpeedMph, 5),
    completionRadiusMiles: c.routeCompletionRadiusMiles != null
      ? c.routeCompletionRadiusMiles : DEFAULT_COMPLETION_RADIUS_MILES,
  };
}

// Google Maps often returns addresses with a localized country suffix (the
// admin's Google session may be Russian → "…, TN 37356, США"). Drivers read
// English; the country adds nothing for US routes — strip it entirely.
const COUNTRY_SUFFIX_RE = new RegExp(
  '(?:,\\s*)?(?:'
  + 'США|Соединённые\\s+Штаты(?:\\s+Америки)?|Соединенные\\s+Штаты(?:\\s+Америки)?'
  + '|USA|U\\.S\\.A\\.|United\\s+States(?:\\s+of\\s+America)?'
  + ')\\s*\\.?\\s*$', 'i'
);

/**
 * PURE. Clean a Google/Maps-derived address for driver-facing display: trims,
 * strips trailing country labels (both Cyrillic "США"/"Соединенные Штаты" and
 * English "USA"/"United States"), and drops leftover trailing punctuation.
 */
function cleanAddressText(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(COUNTRY_SUFFIX_RE, '').trim();
    s = s.replace(/[\s,;]+$/, '');
    if (s === before) break;
  }
  return s;
}

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
    if (meters != null && meters <= radiusMiles * 1609.34) {
      return { shouldStart: true, holdReason: null, reason: `driver is within ${radiusMiles} mi of the start location` };
    }
    return { shouldStart: false, holdReason: 'waiting_for_location', reason: 'driver has not reached the start location yet' };
  }
  // Unknown mode (future value?) — fail open so a route is never silently stuck.
  return { shouldStart: true, holdReason: null, reason: `unknown start mode "${mode}" — starting tracking` };
}

/**
 * PURE. Decide the outcome of one monitoring check for an assignment.
 *
 * @returns {{ result:string, deviationMeters:(number|null),
 *             consecutiveOffRoute:number, shouldNotify:boolean, reason:string }}
 * result ∈ on_route | off_route | parked | stale | not_checked | no_geometry | not_monitored
 */
function evaluateAssignment({ assignment, location, settings, now = new Date() }) {
  const prev = Math.max(0, Number(assignment?.consecutive_off_route) || 0);
  const base = { deviationMeters: null, consecutiveOffRoute: prev, shouldNotify: false };

  // Completed / cancelled routes are never monitored.
  if (assignment?.status && assignment.status !== 'active') {
    return { ...base, result: 'not_monitored', reason: `route is ${assignment.status}` };
  }
  // Tracking hasn't started yet (waiting for message / time / location) —
  // deviation checks are skipped until the start condition is met.
  if (assignment?.tracking_status === 'pending') {
    return { ...base, result: 'not_monitored', reason: 'tracking has not started yet' };
  }
  const polyline = decodePolyline(assignment?.encoded_polyline || '');
  if (!polyline.length) {
    return { ...base, result: 'no_geometry', reason: 'no route geometry to compare against' };
  }
  // Missing / unavailable GPS → do not warn.
  if (!location || location.latitude == null || location.longitude == null) {
    return { ...base, result: 'not_checked', reason: 'no GPS available' };
  }
  // Stale GPS → do not warn.
  const ageMin = location.pingAgeMinutes;
  if (ageMin != null && Number.isFinite(Number(ageMin)) && Number(ageMin) > settings.staleGpsMinutes) {
    return { ...base, result: 'stale', reason: `GPS is ${Math.round(Number(ageMin))}min old (> ${settings.staleGpsMinutes})` };
  }

  const deviationMeters = distancePointToPolylineMeters(
    [location.latitude, location.longitude], polyline
  );
  if (deviationMeters == null) {
    return { ...base, result: 'not_checked', reason: 'could not measure deviation' };
  }

  // On route → reset the off-route streak.
  if (deviationMeters <= settings.deviationThresholdMeters) {
    return {
      result: 'on_route', deviationMeters, consecutiveOffRoute: 0, shouldNotify: false, reason: 'within threshold',
    };
  }

  // Off route but parked / crawling → likely a legitimate stop, don't escalate.
  const speed = location.speedMilesPerHour;
  if (speed != null && Number.isFinite(Number(speed)) && Number(speed) <= settings.parkedSpeedMph) {
    return {
      result: 'parked', deviationMeters, consecutiveOffRoute: prev, shouldNotify: false,
      reason: `off route but parked/slow (${speed} mph)`,
    };
  }

  // Off route and moving → count a consecutive miss.
  const consecutiveOffRoute = prev + 1;
  if (consecutiveOffRoute < settings.offRouteGraceChecks) {
    return {
      result: 'off_route', deviationMeters, consecutiveOffRoute, shouldNotify: false,
      reason: `off route ${consecutiveOffRoute}/${settings.offRouteGraceChecks} (within grace)`,
    };
  }
  // Past the grace threshold — respect the warning cooldown.
  const cooldownMs = settings.warningCooldownMinutes * 60 * 1000;
  const lastNotif = assignment.last_notification_at
    ? new Date(assignment.last_notification_at).getTime() : 0;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (lastNotif && nowMs - lastNotif < cooldownMs) {
    return {
      result: 'off_route', deviationMeters, consecutiveOffRoute, shouldNotify: false,
      reason: 'off route but within warning cooldown',
    };
  }
  return {
    result: 'off_route', deviationMeters, consecutiveOffRoute, shouldNotify: true,
    reason: 'off route beyond grace, cooldown elapsed',
  };
}

/**
 * PURE. Decide whether an active route should auto-complete because the driver's
 * FRESH GPS is within the completion radius of the FINAL destination
 * (destination_lat/destination_lng — never an intermediate waypoint).
 *
 * Safe by construction: only active assignments, only fresh GPS, only valid
 * destination coordinates ever return shouldComplete=true. Anything missing or
 * stale returns false. The boundary is inclusive (exactly the radius completes).
 *
 * @returns {{ shouldComplete:boolean, distanceMeters:(number|null),
 *             distanceMiles:(number|null), reason:string, code:string }}
 * `code` is a stable machine-readable classification: COMPLETED_WITHIN_RADIUS |
 * OUTSIDE_COMPLETION_RADIUS | DESTINATION_COORDINATES_MISSING |
 * LIVE_GPS_MISSING | LIVE_GPS_STALE | NOT_ACTIVE | DISTANCE_UNMEASURABLE.
 */
function evaluateDestinationCompletion({
  assignment, location, staleGpsMinutes, completionRadiusMiles,
} = {}) {
  const fail = (code, reason) => ({
    shouldComplete: false, distanceMeters: null, distanceMiles: null, reason, code,
  });

  // Only active (lifecycle) routes complete; completed/cancelled stay unchanged.
  if (!assignment || (assignment.status && assignment.status !== 'active')) {
    return fail('NOT_ACTIVE', `route is ${assignment?.status || 'missing'}`);
  }
  // Final destination coordinates must be present and valid. NOTE: null is
  // checked explicitly because Number(null) === 0 would otherwise silently
  // point a missing destination at latitude/longitude 0.
  if (!hasFiniteCoord(assignment.destination_lat) || !hasFiniteCoord(assignment.destination_lng)) {
    return fail(COMPLETION_BLOCKED.DESTINATION_COORDINATES_MISSING, 'no destination coordinates');
  }
  const dLat = Number(assignment.destination_lat);
  const dLng = Number(assignment.destination_lng);
  // GPS must exist.
  if (!location || location.latitude == null || location.longitude == null) {
    return fail(COMPLETION_BLOCKED.LIVE_GPS_MISSING, 'no GPS available');
  }
  const lat = Number(location.latitude);
  const lng = Number(location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return fail(COMPLETION_BLOCKED.LIVE_GPS_MISSING, 'invalid GPS coordinates');
  }
  // GPS must be fresh — stale GPS must NEVER complete a route.
  const stale = Number(staleGpsMinutes);
  const ageMin = location.pingAgeMinutes;
  if (ageMin != null && Number.isFinite(Number(ageMin)) && Number.isFinite(stale) && Number(ageMin) > stale) {
    return fail(COMPLETION_BLOCKED.LIVE_GPS_STALE, `GPS is ${Math.round(Number(ageMin))}min old (> ${stale})`);
  }

  const radiusMiles = Number(completionRadiusMiles) > 0
    ? Number(completionRadiusMiles) : DEFAULT_COMPLETION_RADIUS_MILES;
  const distanceMeters = haversineMeters([lat, lng], [dLat, dLng]);
  if (distanceMeters == null || !Number.isFinite(distanceMeters)) {
    return fail('DISTANCE_UNMEASURABLE', 'could not measure distance to destination');
  }
  const distanceMiles = distanceMeters / METERS_PER_MILE;
  const radiusMeters = radiusMiles * METERS_PER_MILE;
  const shouldComplete = distanceMeters <= radiusMeters + COMPLETION_EPSILON_METERS;
  return {
    shouldComplete,
    distanceMeters,
    distanceMiles,
    code: shouldComplete ? 'COMPLETED_WITHIN_RADIUS' : COMPLETION_BLOCKED.OUTSIDE_COMPLETION_RADIUS,
    reason: shouldComplete
      ? `fresh GPS is ${distanceMiles.toFixed(1)} mi from the final destination (≤ ${radiusMiles} mi)`
      : `${distanceMiles.toFixed(1)} mi from the final destination (> ${radiusMiles} mi)`,
  };
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

  // Final-destination coordinates. Prefer the coordinates the parse/manual entry
  // gave us; otherwise (an address-only destination) fall back to the END of the
  // computed route polyline — the exact point Google routed to. Without this,
  // address-destination routes stored NULL destination coordinates and could
  // never auto-complete (the reported production bug). Never a waypoint.
  let destinationLat = destination.lat;
  let destinationLng = destination.lng;
  if ((!Number.isFinite(destinationLat) || !Number.isFinite(destinationLng)) && computed?.encodedPolyline) {
    const derived = destinationCoordFromPolyline(computed.encodedPolyline);
    if (derived) { destinationLat = derived.lat; destinationLng = derived.lng; }
  }

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

/** PURE. Short English description of when tracking will start (for events/UI). */
function describeTrackingStartCondition(assignment) {
  switch (assignment?.tracking_start_mode) {
    case 'after_message_sent':
      return 'after the route message is sent to the driver group';
    case 'scheduled_time':
      return `at the scheduled time (${formatCentralTime(assignment.tracking_start_at)})`;
    case 'start_location': {
      const radius = Number(assignment.tracking_start_radius_miles) > 0
        ? Number(assignment.tracking_start_radius_miles) : DEFAULT_START_RADIUS_MILES;
      const where = cleanAddressText(assignment.tracking_start_location_text)
        || `${assignment.tracking_start_lat}, ${assignment.tracking_start_lng}`;
      return `when the truck reaches ${where} (within ${radius} mi)`;
    }
    default:
      return 'immediately';
  }
}

/** Format a timestamp for drivers/dispatch (fleet convention: US Central time). */
function formatCentralTime(value) {
  if (!value) return 'unknown time';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'unknown time';
  try {
    return `${d.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    })} CST`;
  } catch (_) {
    return d.toISOString();
  }
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

/** Escape a URL for use inside an HTML href attribute (Telegram HTML mode). */
function escapeHref(url) {
  return escapeHtml(url).replace(/"/g, '&quot;');
}

/**
 * PURE. Classify a Telegram sendPhoto failure into a safe, admin-readable
 * reason string (no tokens, no internal stack traces). 403 = bot permission /
 * group access; 413 or size wording = file too large; 400 = rejected payload;
 * timeouts are called out so a retry is the obvious next step.
 */
function classifyTelegramPhotoError(err) {
  const code = err?.response?.error_code;
  const desc = String(err?.response?.description || err?.message || '').slice(0, 160);
  if (code === 403) return 'TELEGRAM_PHOTO_REJECTED: the bot lacks permission in the driver group (403)';
  if (code === 413 || /too large|too big|entity too large/i.test(desc)) {
    return 'TELEGRAM_PHOTO_REJECTED: the file is too large for Telegram (413)';
  }
  if (code === 400) return `TELEGRAM_PHOTO_REJECTED: Telegram rejected the photo (400${desc ? ` — ${desc}` : ''})`;
  if (/timeout|timed out|etimedout|esockettimedout|econnreset|network/i.test(desc)) {
    return 'TELEGRAM_PHOTO_TIMEOUT';
  }
  return `TELEGRAM_PHOTO_SEND_FAILED${desc ? `: ${desc}` : ''}`;
}

/** PURE. Driver-facing line describing when Route Control starts monitoring. */
function buildTrackingSection(assignment) {
  switch (assignment?.tracking_start_mode) {
    case 'scheduled_time':
      return `Route Control will start monitoring at ${escapeHtml(formatCentralTime(assignment.tracking_start_at))}.`;
    case 'start_location': {
      const radius = Number(assignment.tracking_start_radius_miles) > 0
        ? Number(assignment.tracking_start_radius_miles) : DEFAULT_START_RADIUS_MILES;
      const where = cleanAddressText(assignment.tracking_start_location_text)
        || `${assignment.tracking_start_lat}, ${assignment.tracking_start_lng}`;
      return `Route Control will start monitoring when the truck reaches ${escapeHtml(where)} (within ${radius} mi).`;
    }
    case 'after_message_sent':
      // By the time the driver reads this, the message HAS been delivered.
      return 'Route Control starts monitoring this route once this message is delivered.';
    default:
      return 'Route Control is now monitoring this route.';
  }
}

/**
 * PURE. Build the Telegram-HTML route message sent to a driver group.
 *
 * Clean, English-only format: localized country suffixes from Google (e.g.
 * Cyrillic "США") are stripped, waypoints are numbered one per line, and the
 * total length is kept under Telegram's text limit (waypoints past the budget
 * collapse into "… and N more stops"). All place-derived text is HTML-escaped;
 * the driver mention is injected verbatim (already-safe HTML).
 *
 * @param {object} assignment  a route_assignments row (with group_name etc.)
 * @param {{ mentionHtml:string }} mention
 * @returns {string} HTML body for parse_mode:'HTML'
 */
function buildDriverGroupRouteMessage(assignment, mention) {
  const waypoints = (Array.isArray(assignment?.waypoints) ? assignment.waypoints : [])
    .map((w) => cleanAddressText(w && w.raw))
    .filter(Boolean);

  const build = (wpCount) => {
    const lines = ['🚚 <b>Route Assigned</b>', ''];
    lines.push(`<b>Driver:</b> ${mention?.mentionHtml || 'driver'}`);
    lines.push('');
    lines.push('Please follow the assigned route below.');

    const url = assignment?.original_url;
    if (url && /^https?:\/\//i.test(url)) {
      lines.push('');
      lines.push(`🔗 <a href="${escapeHref(url)}">Open route in Google Maps</a>`);
    }

    const origin = cleanAddressText(assignment?.origin_text);
    if (origin) {
      lines.push('', '<b>Origin</b>', escapeHtml(origin));
    }
    const destination = cleanAddressText(assignment?.destination_text);
    if (destination) {
      lines.push('', '<b>Destination</b>', escapeHtml(destination));
    }

    if (waypoints.length) {
      lines.push('', '<b>Stops / Waypoints</b>');
      waypoints.slice(0, wpCount).forEach((w, i) => lines.push(`${i + 1}. ${escapeHtml(w)}`));
      if (wpCount < waypoints.length) {
        lines.push(`… and ${waypoints.length - wpCount} more stops (see the map link).`);
      }
    }

    lines.push('', '<b>Tracking</b>', buildTrackingSection(assignment));
    lines.push('', 'Please stay on the assigned route and notify dispatch if anything changes.');
    return lines.join('\n');
  };

  // Fit within Telegram's text limit by dropping trailing waypoints if needed.
  let wpCount = waypoints.length;
  let text = build(wpCount);
  while (text.length > TELEGRAM_TEXT_SAFE_MAX && wpCount > 0) {
    wpCount -= 1;
    text = build(wpCount);
  }
  return text;
}

/**
 * Send (or re-send) the assigned route message to the driver group's Telegram
 * chat. Tags the driver when a Telegram id/username is known, else uses the
 * plain name. Records the send on the assignment + an audit event. Throws a
 * CLEAR error when the group has no Telegram chat id or the send fails — the
 * caller decides how to surface it, and NEVER rolls back the assignment.
 *
 * @param {{ assignmentId:number, telegram:object, sentBy?:string,
 *           customMessage?:string }} p
 * @returns {Promise<{ sent:boolean, sentAt:string, messageId:(number|null),
 *                     chatId:number, mentionSource:string, mentionConfidence:string }>}
 */
async function sendDriverGroupRouteMessage({ assignmentId, telegram, sentBy = null, customMessage = null }) {
  const assignment = await rc.getRouteAssignment(assignmentId);
  if (!assignment) throw serviceError('NOT_FOUND', 'Route assignment not found.', 404);
  if (!assignment.group_id) {
    throw serviceError('NO_GROUP', 'This route is not tied to a driver group.', 400);
  }
  const chatId = assignment.telegram_group_id;
  if (chatId == null) {
    throw serviceError('NO_TELEGRAM_GROUP',
      'This driver group has no Telegram chat id, so the route message cannot be sent.', 400);
  }
  if (!telegram || typeof telegram.sendMessage !== 'function') {
    throw serviceError('NO_TELEGRAM', 'Telegram client is unavailable right now.', 503);
  }

  const mention = await resolveDriverMentionForGroup(assignment.group_id);
  const body = customMessage && String(customMessage).trim()
    ? escapeHtml(String(customMessage).trim())
    : buildDriverGroupRouteMessage(assignment, mention);

  // Attach the route screenshot when one is stored. A photo-send failure must
  // never lose the route text: fall back to the plain text message AND report
  // the failure truthfully (screenshotError in the result + persisted on the
  // assignment) — never claim the screenshot was delivered when it wasn't.
  // When the full message exceeds Telegram's 1024-char photo caption, the photo
  // goes first with a short caption and the details follow as a separate message.
  let screenshot = null;
  let screenshotError = null;
  try {
    screenshot = await rc.getRouteScreenshot(assignmentId);
  } catch (readErr) {
    screenshot = null;
    screenshotError = 'SCREENSHOT_DB_READ_FAILED';
    console.error(`[ROUTE-CONTROL] assignment=${assignmentId} screenshot=read_failed:`, readErr.message);
  }

  let messageId = null;
  let sentVia = 'text';
  if (screenshot?.file_data) {
    try {
      if (body.length <= TELEGRAM_CAPTION_MAX) {
        const sent = await safeSend(() => telegram.sendPhoto(chatId, { source: screenshot.file_data }, {
          caption: body,
          parse_mode: 'HTML',
        }));
        messageId = sent?.message_id ?? null;
        sentVia = 'photo';
      } else {
        const sentPhoto = await safeSend(() => telegram.sendPhoto(chatId, { source: screenshot.file_data }, {
          caption: '🚚 <b>Route Assigned</b> — details below.',
          parse_mode: 'HTML',
        }));
        const sentText = await safeSend(() => telegram.sendMessage(chatId, body, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }));
        messageId = sentText?.message_id ?? sentPhoto?.message_id ?? null;
        sentVia = 'photo+text';
      }
    } catch (photoErr) {
      screenshotError = classifyTelegramPhotoError(photoErr);
      console.error(
        `[ROUTE-CONTROL] assignment=${assignmentId} screenshot=send_failed reason=${screenshotError}`
        + ' (falling back to text)'
      );
      sentVia = 'text';
    }
  }
  if (sentVia === 'text') {
    try {
      const sent = await safeSend(() => telegram.sendMessage(chatId, body, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }));
      messageId = sent?.message_id ?? null;
    } catch (textErr) {
      // Photo (if any) AND text failed → complete failure. Nothing is marked
      // sent and after-message tracking is NOT activated; the screenshot stays
      // stored so a later retry can use it.
      if (!textErr.code) textErr.code = 'TELEGRAM_TEXT_SEND_FAILED';
      throw textErr;
    }
  }

  await rc.recordDriverGroupMessageSent(assignmentId, {
    telegramMessageId: messageId, sentBy, via: sentVia, screenshotError,
  });
  await rc.insertRouteMonitorEvent({
    assignmentId,
    eventType: 'driver_group_message_sent',
    detail: `route message sent to driver group${sentBy ? ` by ${sentBy}` : ''}`
      + `${messageId ? ` (telegram msg ${messageId})` : ''}`
      + ` [via:${sentVia}]${screenshotError ? ` [screenshot_error:${screenshotError}]` : ''}`
      + ` [mention:${mention.source}/${mention.confidence}]`,
  });
  console.log(
    `[ROUTE-CONTROL] assignment=${assignmentId} screenshot=${screenshot?.file_data ? 'stored' : 'none'}`
    + ` send_via=${sentVia}${messageId ? ` telegram_message_id=${messageId}` : ''}`
    + `${screenshotError ? ` screenshot_error=${screenshotError}` : ''}`
  );

  // After-message start mode: a successful send is the start condition.
  let trackingActivated = false;
  if (assignment.tracking_start_mode === 'after_message_sent' && assignment.tracking_status === 'pending') {
    const activated = await rc.activateTracking(assignmentId);
    if (activated) {
      trackingActivated = true;
      await rc.insertRouteMonitorEvent({
        assignmentId,
        eventType: 'tracking_started',
        detail: 'route message sent — tracking is now active',
      });
    }
  }

  return {
    sent: true,
    sentAt: new Date().toISOString(),
    messageId,
    chatId,
    sentVia,
    withScreenshot: sentVia !== 'text',
    screenshotStored: Boolean(screenshot?.file_data),
    screenshotError,
    trackingActivated,
    mentionSource: mention.source,
    mentionConfidence: mention.confidence,
  };
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
  let destinationLat = assignment.destination_lat;
  let destinationLng = assignment.destination_lng;
  if ((!hasFiniteCoord(destinationLat) || !hasFiniteCoord(destinationLng)) && computed.encodedPolyline) {
    const derived = destinationCoordFromPolyline(computed.encodedPolyline);
    if (derived) { destinationLat = derived.lat; destinationLng = derived.lng; }
  }
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

function buildOffRouteMessage(assignment, verdict) {
  const miles = verdict.deviationMeters != null
    ? ` (about ${(verdict.deviationMeters / 1609.34).toFixed(1)} mi off)` : '';
  return '🧭 Route Control: you appear to be off the assigned route'
    + `${miles}. Please return to the planned route, or contact dispatch if there is a reason for the change.`;
}

/**
 * Resolve an assignment's live GPS, preferring stable stored identifiers:
 * the assignment's stored unit_number → the group's current driver-profile
 * unit → group-title parsing (compatibility fallback inside the resolver).
 * Never throws — a failure is returned so the caller can diagnose it.
 */
async function resolveAssignmentLocation(assignment) {
  let unitNumber = assignment?.unit_number != null && String(assignment.unit_number).trim()
    ? String(assignment.unit_number).trim() : null;
  if (!unitNumber && assignment?.group_id) {
    try {
      const profile = await db.getDriverProfileByGroupId(assignment.group_id);
      if (profile?.unit_number) unitNumber = String(profile.unit_number).trim() || null;
    } catch (_) { /* fall through to group-title parsing */ }
  }
  try {
    const resolved = await resolveLiveLocationForGroupTitle(assignment?.group_name || '', { unitNumber });
    return { location: resolved.location, source: resolved.source, error: null };
  } catch (err) {
    return { location: null, source: null, error: err };
  }
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
    await rc.setRouteAssignmentDestinationCoords(assignment.id, { lat: fromPolyline.lat, lng: fromPolyline.lng });
    assignment.destination_lat = fromPolyline.lat;
    assignment.destination_lng = fromPolyline.lng;
    await rc.insertRouteMonitorEvent({
      assignmentId: assignment.id,
      eventType: 'destination_repaired',
      detail: 'final destination coordinates recovered from the computed route polyline',
    });
    return { repaired: true };
  }

  const text = String(assignment?.destination_text || '').trim();
  if (!text) return { repaired: false, reason: 'no destination text to repair from' };

  // Free path #2: coordinates embedded in the destination text.
  const parsed = classifyPoint(text);
  if (Number.isFinite(parsed?.lat) && Number.isFinite(parsed?.lng)) {
    await rc.setRouteAssignmentDestinationCoords(assignment.id, { lat: parsed.lat, lng: parsed.lng });
    assignment.destination_lat = parsed.lat;
    assignment.destination_lng = parsed.lng;
    await rc.insertRouteMonitorEvent({
      assignmentId: assignment.id,
      eventType: 'destination_repaired',
      detail: 'final destination coordinates parsed from the stored destination text',
    });
    return { repaired: true };
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
    const { geocodePlace } = require('./etaRoutingService');
    const geo = await geocodePlace(text);
    const lat = Number(geo?.latitude);
    const lng = Number(geo?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      await rc.setRouteAssignmentDestinationCoords(assignment.id, { lat, lng });
      assignment.destination_lat = lat;
      assignment.destination_lng = lng;
      await rc.insertRouteMonitorEvent({
        assignmentId: assignment.id,
        eventType: 'destination_repaired',
        detail: `final destination geocoded from text (attempt ${attempts + 1}/${DESTINATION_REPAIR_MAX_ATTEMPTS})`,
      });
      return { repaired: true };
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

/**
 * Destination-completion gate for ONE assignment with an already-resolved
 * location. Attempts a bounded coordinate repair when needed, evaluates the
 * pure completion decision, atomically completes inside the radius (exactly one
 * audit event ever — overlapping checks lose the atomic UPDATE race and write
 * nothing), and records diagnostics (distance, blocked reason) otherwise.
 *
 * @returns {{ completed:boolean, duplicate:boolean, blockedReason:(string|null),
 *             distanceMeters:(number|null), distanceMiles:(number|null) }}
 */
async function checkAssignmentCompletion(assignment, { location, resolveError = null, settings, now = new Date() }) {
  const hasCoords = hasFiniteCoord(assignment.destination_lat)
    && hasFiniteCoord(assignment.destination_lng);
  if (!hasCoords && assignment.status === 'active') {
    try { await maybeRepairDestinationCoordinates(assignment); } catch (_) { /* diagnosed below */ }
  }

  const completion = evaluateDestinationCompletion({
    assignment, location,
    staleGpsMinutes: settings.staleGpsMinutes,
    completionRadiusMiles: settings.completionRadiusMiles,
  });

  if (completion.shouldComplete) {
    const detail = `Auto-completed: fresh GPS was ${completion.distanceMiles.toFixed(1)} miles from the final destination`
      + ` (radius ${settings.completionRadiusMiles} mi, GPS age ${location.pingAgeMinutes != null ? `${Math.round(Number(location.pingAgeMinutes))}min` : 'unknown'}).`;
    const done = await rc.completeRouteAssignment(assignment.id, {
      latitude: location.latitude,
      longitude: location.longitude,
      distanceMeters: completion.distanceMeters,
      reason: detail,
    });
    // done === null → another overlapping check already completed it: no
    // duplicate event, no double-processing.
    if (done) {
      await rc.insertRouteMonitorEvent({
        assignmentId: assignment.id,
        eventType: 'destination_reached',
        result: 'completed',
        latitude: location.latitude,
        longitude: location.longitude,
        deviationMeters: completion.distanceMeters,
        detail,
      });
    }
    return {
      completed: true, duplicate: !done, blockedReason: null,
      distanceMeters: completion.distanceMeters, distanceMiles: completion.distanceMiles,
    };
  }

  // Not completed — classify why, for the Admin diagnostics. A GPS resolution
  // failure (unit unparseable / ambiguous / provider error) beats the generic
  // "no GPS" so the admin sees the actionable cause.
  let blockedReason = completion.code;
  if (blockedReason === COMPLETION_BLOCKED.LIVE_GPS_MISSING && resolveError) {
    blockedReason = COMPLETION_BLOCKED.UNIT_RESOLUTION_FAILED;
  }
  try {
    await rc.updateCompletionDiagnostics(assignment.id, {
      lastCompletionCheckAt: nowIso(now),
      distanceMeters: completion.distanceMeters,
      blockedReason,
    });
  } catch (_) { /* diagnostics must never break monitoring */ }
  return {
    completed: false, duplicate: false, blockedReason,
    distanceMeters: completion.distanceMeters, distanceMiles: completion.distanceMiles,
  };
}

/** Tally a completion blocked-reason into the monitor summary counters. */
function tallyBlockedReason(summary, blockedReason) {
  if (blockedReason === COMPLETION_BLOCKED.OUTSIDE_COMPLETION_RADIUS) summary.outside_radius += 1;
  else if (blockedReason === COMPLETION_BLOCKED.DESTINATION_COORDINATES_MISSING) summary.missing_destination += 1;
  else if (blockedReason === COMPLETION_BLOCKED.LIVE_GPS_STALE) summary.stale_gps += 1;
  else if (blockedReason === COMPLETION_BLOCKED.UNIT_RESOLUTION_FAILED) summary.resolution_errors += 1;
  else if (blockedReason === COMPLETION_BLOCKED.LIVE_GPS_MISSING) summary.missing_gps += 1;
}

/**
 * One monitoring pass over EVERY lifecycle-active assignment (tracking active
 * AND pending). Per assignment, in order:
 *   1. Resolve live GPS once (stored unit number preferred).
 *   2. Destination auto-completion FIRST — runs for every route, needs no
 *      Google Maps config, and short-circuits everything else when it fires.
 *   3. Pending tracking → evaluate the start condition (never warnings).
 *   4. Active tracking → off-route deviation checks, gated on Settings → GMaps.
 */
async function runRouteMonitorCheck(telegram, { now = new Date() } = {}) {
  let cfg = null;
  try { cfg = await gmaps.getGmapsConfig(); } catch (_) { cfg = null; }
  const settings = monitorSettingsFromConfig(cfg || {});
  const offRouteMonitoringEnabled = Boolean(cfg && cfg.enabled);

  let assignments = [];
  try {
    assignments = await rc.listActiveAssignmentsForMonitor();
  } catch (err) {
    console.error('[ROUTE-CONTROL] Could not load active assignments:', err.message);
    return { enabled: offRouteMonitoringEnabled, checked: 0, notified: 0, activated: 0, completed: 0 };
  }

  const summary = {
    eligible: assignments.length, completed: 0, outside_radius: 0, missing_destination: 0,
    missing_gps: 0, stale_gps: 0, resolution_errors: 0, warnings_sent: 0,
  };
  let checked = 0;
  let notified = 0;
  let activated = 0;
  let completed = 0;

  for (const assignment of assignments) {
    try {
      const { location, error: resolveError } = await resolveAssignmentLocation(assignment);

      // 1) Destination auto-completion — before ANY off-route logic. A completed
      // route sends no message, is excluded from every later pass, and can never
      // warn again.
      const gate = await checkAssignmentCompletion(assignment, { location, resolveError, settings, now });
      if (gate.completed) {
        if (!gate.duplicate) { completed += 1; summary.completed += 1; }
        continue;
      }
      tallyBlockedReason(summary, gate.blockedReason);

      // 2) Pending tracking: evaluate the start condition only. Pending routes
      // NEVER receive off-route warnings (evaluateAssignment also guards this).
      if (assignment.tracking_status === 'pending') {
        const startVerdict = evaluateTrackingStart({ assignment, location, now });
        if (startVerdict.shouldStart) {
          await rc.activateTracking(assignment.id);
          await rc.insertRouteMonitorEvent({
            assignmentId: assignment.id,
            eventType: 'tracking_started',
            latitude: location?.latitude,
            longitude: location?.longitude,
            detail: startVerdict.reason,
          });
          activated += 1;
        } else if ((assignment.tracking_hold_reason || null) !== (startVerdict.holdReason || null)) {
          await rc.setTrackingHoldReason(assignment.id, startVerdict.holdReason);
          await rc.insertRouteMonitorEvent({
            assignmentId: assignment.id,
            eventType: `tracking_start_${startVerdict.holdReason || 'pending'}`,
            detail: startVerdict.reason,
          });
        }
        continue;
      }

      // 3) Off-route deviation checks — the Google-geometry feature, still gated
      // on Settings → GMaps. Completion above already ran regardless.
      if (!offRouteMonitoringEnabled) continue;
      const verdict = evaluateAssignment({ assignment, location, settings, now });
      checked += 1;

      await rc.updateRouteAssignmentMonitorState(assignment.id, {
        lastCheckedAt: nowIso(now),
        lastLatitude: location?.latitude ?? null,
        lastLongitude: location?.longitude ?? null,
        lastDeviationMeters: verdict.deviationMeters,
        lastCheckResult: verdict.result,
        consecutiveOffRoute: verdict.consecutiveOffRoute,
        lastNotificationAt: verdict.shouldNotify ? nowIso(now) : null,
      });
      await rc.insertRouteMonitorEvent({
        assignmentId: assignment.id,
        eventType: verdict.shouldNotify ? 'notification' : 'check',
        result: verdict.result,
        latitude: location?.latitude,
        longitude: location?.longitude,
        deviationMeters: verdict.deviationMeters,
        detail: verdict.reason,
      });

      if (verdict.shouldNotify && telegram && assignment.telegram_group_id) {
        await safeSend(() => telegram.sendMessage(
          assignment.telegram_group_id,
          buildOffRouteMessage(assignment, verdict),
          { disable_web_page_preview: true }
        ));
        notified += 1;
        summary.warnings_sent += 1;
      }
    } catch (err) {
      console.error(`[ROUTE-CONTROL] Check failed for assignment #${assignment.id}:`, err.message);
    }
  }
  if (assignments.length) {
    console.log(
      `[ROUTE-CONTROL] eligible=${summary.eligible} completed=${summary.completed}`
      + ` outside_radius=${summary.outside_radius} missing_destination=${summary.missing_destination}`
      + ` missing_gps=${summary.missing_gps} stale_gps=${summary.stale_gps}`
      + ` resolution_errors=${summary.resolution_errors} warnings_sent=${summary.warnings_sent}`
    );
  }
  return { enabled: offRouteMonitoringEnabled, checked, notified, activated, completed, summary };
}

let completionCheckRunning = false;

/**
 * Idempotent completion-only reconciliation over existing routes — the "Run
 * completion check now" admin action (optionally scoped to one assignment).
 * Resolves GPS, repairs destinations (bounded), completes routes inside the
 * radius and reports a per-route diagnostic. NEVER sends off-route warnings and
 * never touches tracking state, so it is safe to run at any time. Guarded
 * against overlapping manual runs; overlap with the monitor tick is safe
 * because completion is an atomic conditional UPDATE.
 */
async function runCompletionCheckNow({ assignmentId = null, now = new Date() } = {}) {
  if (completionCheckRunning) return { alreadyRunning: true, results: [] };
  completionCheckRunning = true;
  try {
    let cfg = null;
    try { cfg = await gmaps.getGmapsConfig(); } catch (_) { cfg = null; }
    const settings = monitorSettingsFromConfig(cfg || {});

    let assignments;
    if (assignmentId != null) {
      const one = await rc.getRouteAssignment(assignmentId);
      if (!one) throw serviceError('NOT_FOUND', 'Route assignment not found.', 404);
      if (one.status !== 'active') {
        return {
          alreadyRunning: false,
          completionRadiusMiles: settings.completionRadiusMiles,
          results: [{ id: one.id, completed: false, blockedReason: null, note: `route is ${one.status}` }],
        };
      }
      assignments = [one];
    } else {
      assignments = await rc.listActiveAssignmentsForMonitor();
    }

    const results = [];
    for (const assignment of assignments) {
      try {
        const { location, source, error: resolveError } = await resolveAssignmentLocation(assignment);
        const gate = await checkAssignmentCompletion(assignment, { location, resolveError, settings, now });
        results.push({
          id: assignment.id,
          groupName: assignment.group_name || null,
          completed: gate.completed,
          blockedReason: gate.blockedReason,
          distanceMeters: gate.distanceMeters,
          distanceMiles: gate.distanceMiles != null ? Number(gate.distanceMiles.toFixed(1)) : null,
          gpsSource: source,
          gpsAgeMinutes: location?.pingAgeMinutes ?? null,
          resolveError: resolveError ? String(resolveError.message || resolveError).slice(0, 200) : null,
        });
      } catch (err) {
        results.push({ id: assignment.id, completed: false, error: String(err.message || err).slice(0, 200) });
      }
    }
    return {
      alreadyRunning: false,
      completionRadiusMiles: settings.completionRadiusMiles,
      results,
    };
  } finally {
    completionCheckRunning = false;
  }
}

async function tick() {
  if (tickRunning || !telegramClient) return;
  tickRunning = true;
  try {
    await runRouteMonitorCheck(telegramClient);
  } catch (err) {
    console.error('[ROUTE-CONTROL] Monitor tick error:', err.message);
  } finally {
    tickRunning = false;
  }
  // Pick up an admin-changed check interval without a restart (single timer —
  // the old one is always cleared before a new one is created).
  await maybeRescheduleTimer().catch(() => {});
}

let currentIntervalMs = POLL_MS_MIN;

async function maybeRescheduleTimer() {
  if (serviceStopped || !serviceTimer) return;
  let intervalMs = currentIntervalMs;
  try {
    const cfg = await gmaps.getGmapsConfig();
    intervalMs = Math.max(POLL_MS_MIN, (cfg.checkIntervalSeconds || 300) * 1000);
  } catch (_) { return; }
  if (intervalMs === currentIntervalMs || serviceStopped || !serviceTimer) return;
  clearInterval(serviceTimer);
  currentIntervalMs = intervalMs;
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, intervalMs);
  serviceTimer.unref?.();
  console.log(`[ROUTE-CONTROL] Check interval updated — monitoring every ${Math.round(intervalMs / 1000)}s`);
}

async function startRouteControlService(telegram) {
  if (telegram) telegramClient = telegram;
  serviceStopped = false;
  // Never leave two timers running if start is called twice (e.g. a re-init).
  if (serviceTimer) { clearInterval(serviceTimer); serviceTimer = null; }
  let intervalMs = POLL_MS_MIN;
  try {
    const cfg = await gmaps.getGmapsConfig();
    intervalMs = Math.max(POLL_MS_MIN, (cfg.checkIntervalSeconds || 300) * 1000);
  } catch (_) { /* use default */ }
  currentIntervalMs = intervalMs;
  console.log(`[ROUTE-CONTROL] Service started — monitoring every ${Math.round(intervalMs / 1000)}s`
    + ' (destination completion always on; off-route warnings gated on Settings → GMaps)');
  // First pass ~25s after boot doubles as the existing-route reconciliation:
  // every lifecycle-active route (tracking active OR pending) gets a completion
  // check, so routes already inside the radius complete on startup.
  setTimeout(() => { if (!serviceStopped) tick(); }, 25 * 1000).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, intervalMs);
  serviceTimer.unref?.();
}

function stopRouteControlService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

module.exports = {
  evaluateAssignment,
  evaluateDestinationCompletion,
  destinationCoordFromPolyline,
  evaluateTrackingStart,
  normalizeTrackingOptions,
  cleanAddressText,
  describeTrackingStartCondition,
  classifyTelegramPhotoError,
  parseRouteLink,
  assignRoute,
  cancelActiveRoutesForGroup,
  computeGeometryForAssignment,
  buildDriverGroupRouteMessage,
  sendDriverGroupRouteMessage,
  startTrackingNow,
  runRouteMonitorCheck,
  runCompletionCheckNow,
  buildOffRouteMessage,
  monitorSettingsFromConfig,
  startRouteControlService,
  stopRouteControlService,
  tick,
};
