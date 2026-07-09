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
const { parseDirectionsUrl, expandShortLink, classifyPoint } = require('./googleMapsUrlParser');
const { decodePolyline, distancePointToPolylineMeters, haversineMeters } = require('./routeGeometry');
const { resolveLiveLocationForGroupTitle } = require('./liveLocationResolver');
const { resolveDriverMentionForGroup, escapeHtml } = require('./driverMention');

const POLL_MS_MIN = 30 * 1000;
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
  // never lose the route text: fall back to the plain text message. When the
  // full message exceeds Telegram's 1024-char photo caption, the photo goes
  // first with a short caption and the details follow as a separate message.
  let screenshot = null;
  try {
    screenshot = await rc.getRouteScreenshot(assignmentId);
  } catch (_) { screenshot = null; /* screenshots are optional — never block the send */ }

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
      console.error(`[ROUTE-CONTROL] Screenshot send failed for assignment #${assignmentId} (falling back to text):`, photoErr.message);
      sentVia = 'text';
    }
  }
  if (sentVia === 'text') {
    const sent = await safeSend(() => telegram.sendMessage(chatId, body, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
    messageId = sent?.message_id ?? null;
  }

  await rc.recordDriverGroupMessageSent(assignmentId, { telegramMessageId: messageId, sentBy });
  await rc.insertRouteMonitorEvent({
    assignmentId,
    eventType: 'driver_group_message_sent',
    detail: `route message sent to driver group${sentBy ? ` by ${sentBy}` : ''}`
      + `${messageId ? ` (telegram msg ${messageId})` : ''}`
      + ` [via:${sentVia}] [mention:${mention.source}/${mention.confidence}]`,
  });

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

  // Phase 1 — PENDING tracking: evaluate start conditions instead of running
  // deviation checks. Live GPS is only resolved for the start-location mode.
  // Hold-reason events are recorded once per reason change, never per tick.
  let activated = 0;
  let pending = [];
  try {
    pending = await rc.listPendingTrackingAssignments();
  } catch (_) { pending = []; /* pre-migration DB — skip the phase */ }
  for (const assignment of pending) {
    try {
      let location = null;
      if (assignment.tracking_start_mode === 'start_location') {
        try {
          const resolved = await resolveLiveLocationForGroupTitle(assignment.group_name || '');
          location = resolved.location;
        } catch (_) { location = null; }
      }
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
    } catch (err) {
      console.error(`[ROUTE-CONTROL] Tracking-start check failed for assignment #${assignment.id}:`, err.message);
    }
  }

  // Phase 2 — ACTIVE tracking: the original deviation checks.
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
  return { enabled: true, checked, notified, activated };
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
  evaluateTrackingStart,
  normalizeTrackingOptions,
  cleanAddressText,
  describeTrackingStartCondition,
  parseRouteLink,
  assignRoute,
  cancelActiveRoutesForGroup,
  computeGeometryForAssignment,
  buildDriverGroupRouteMessage,
  sendDriverGroupRouteMessage,
  startTrackingNow,
  runRouteMonitorCheck,
  buildOffRouteMessage,
  monitorSettingsFromConfig,
  startRouteControlService,
  stopRouteControlService,
  tick,
};
