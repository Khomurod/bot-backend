/**
 * Route Control service.
 *
 * Assigns a Google Maps directions link to a driver group (parsing the link and
 * computing route geometry via the Routes API), then periodically compares the
 * driver's live GPS to that route and warns the driver group when they drift off
 * it. All Google calls are server-side and gated on Settings → GMaps; with the
 * feature off, assignment still stores the parsed link but monitoring stays idle.
 *
 * `evaluateAssignment` is a PURE decision function (no DB / network / telegram)
 * so the deviation → grace → cooldown → stale/parked logic is unit-tested
 * deterministically. The monitor loop is a thin wrapper around it.
 */
const db = require('../database/db');
const rc = require('../database/routeControl');
const gmaps = require('../database/gmapsSettings');
const googleClient = require('./googleMapsClient');
const { safeSend } = require('./telegramHtml');
const { parseDirectionsUrl, expandShortLink } = require('./googleMapsUrlParser');
const { decodePolyline, distancePointToPolylineMeters } = require('./routeGeometry');
const { resolveLiveLocationForGroupTitle } = require('./liveLocationResolver');

const POLL_MS_MIN = 30 * 1000;
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

/** Map the stored GMaps config to the tunables evaluateAssignment expects. */
function monitorSettingsFromConfig(cfg) {
  return {
    deviationThresholdMeters: cfg.deviationThresholdMeters,
    offRouteGraceChecks: cfg.offRouteGraceChecks,
    warningCooldownMinutes: cfg.warningCooldownMinutes,
    staleGpsMinutes: cfg.staleGpsMinutes,
    parkedSpeedMph: cfg.parkedSpeedMph,
  };
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
    throw serviceError('UNPARSEABLE_LINK', parsed.reason, 422);
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
}) {
  if (!groupId) throw serviceError('NO_GROUP', 'Select a driver group for this route.', 400);
  if (!url && !manual) throw serviceError('NO_URL', 'Paste a Google Maps directions link.', 400);

  let origin;
  let destination;
  let waypoints = [];
  if (manual && manual.origin && manual.destination) {
    const { classifyPoint } = require('./googleMapsUrlParser');
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
    destinationLat: destination.lat, destinationLng: destination.lng,
    encodedPolyline: computed?.encodedPolyline || null,
    distanceMeters: computed?.distanceMeters || null,
    durationSeconds: computed?.durationSeconds || null,
    assignedBy,
  });
  await rc.insertRouteMonitorEvent({
    assignmentId: assignment.id,
    eventType: 'assigned',
    detail: computed ? 'route computed' : 'parsed only — GMaps not configured, geometry pending',
  });

  return {
    assignment,
    computed: Boolean(computed),
    geometryPending: !computed,
  };
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
  return rc.setRouteAssignmentGeometry(id, {
    originText: assignment.origin_text,
    destinationText: assignment.destination_text,
    waypoints,
    originLat: assignment.origin_lat,
    originLng: assignment.origin_lng,
    destinationLat: assignment.destination_lat,
    destinationLng: assignment.destination_lng,
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
 * One monitoring pass over every active assignment that has route geometry.
 * Resolves each driver's live GPS (same resolver as /location), evaluates it,
 * records the outcome, and warns the driver group when a real off-route streak
 * clears the grace + cooldown gate.
 */
async function runRouteMonitorCheck(telegram, { now = new Date() } = {}) {
  const cfg = await gmaps.getGmapsConfig();
  if (!cfg.enabled) return { enabled: false, checked: 0, notified: 0 };
  const settings = monitorSettingsFromConfig(cfg);

  const assignments = await rc.listMonitorableAssignments();
  let checked = 0;
  let notified = 0;
  for (const assignment of assignments) {
    try {
      let location = null;
      try {
        const resolved = await resolveLiveLocationForGroupTitle(assignment.group_name || '');
        location = resolved.location;
      } catch (_) {
        location = null; // treated as not_checked — never a false off-route warning
      }
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
      }
    } catch (err) {
      console.error(`[ROUTE-CONTROL] Check failed for assignment #${assignment.id}:`, err.message);
    }
  }
  return { enabled: true, checked, notified };
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
}

async function startRouteControlService(telegram) {
  if (telegram) telegramClient = telegram;
  serviceStopped = false;
  let intervalMs = POLL_MS_MIN;
  try {
    const cfg = await gmaps.getGmapsConfig();
    intervalMs = Math.max(POLL_MS_MIN, (cfg.checkIntervalSeconds || 300) * 1000);
  } catch (_) { /* use default */ }
  console.log(`[ROUTE-CONTROL] Service started — monitoring every ${Math.round(intervalMs / 1000)}s (idle until GMaps is enabled)`);
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
  parseRouteLink,
  assignRoute,
  computeGeometryForAssignment,
  runRouteMonitorCheck,
  buildOffRouteMessage,
  monitorSettingsFromConfig,
  startRouteControlService,
  stopRouteControlService,
  tick,
};
