/**
 * Driver-facing Route Control message formatting. Entirely PURE — every function
 * here takes plain data and returns a string, so the wording is unit-tested
 * without a database, Telegram, or the network.
 *
 * All place-derived text is HTML-escaped for Telegram's parse_mode:'HTML'; the
 * driver mention is injected verbatim (it is already-safe HTML from
 * driverMention).
 */
const { escapeHtml } = require('../driverMention');
const {
  TELEGRAM_TEXT_SAFE_MAX,
  DEFAULT_START_RADIUS_MILES,
} = require('./constants');

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

/** Escape a URL for use inside an HTML href attribute (Telegram HTML mode). */
function escapeHref(url) {
  return escapeHtml(url).replace(/"/g, '&quot;');
}

/**
 * PURE. Conservative estimate of a Telegram caption's length AFTER HTML entity
 * parsing: strips the HTML tags Telegram ignores, but leaves entity refs like
 * &amp; as their escaped text, so it never UNDER-counts. A body we accept for an
 * in-place text→photo conversion therefore always fits Telegram's 1024-char
 * post-parse caption limit; anything borderline is rejected rather than risking
 * a silent truncation.
 */
function estimatedCaptionLength(html) {
  return String(html || '').replace(/<[^>]+>/g, '').length;
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

/** PURE. The start-location label + radius shared by the driver text and events. */
function startLocationSummary(assignment) {
  const radius = Number(assignment.tracking_start_radius_miles) > 0
    ? Number(assignment.tracking_start_radius_miles) : DEFAULT_START_RADIUS_MILES;
  const where = cleanAddressText(assignment.tracking_start_location_text)
    || `${assignment.tracking_start_lat}, ${assignment.tracking_start_lng}`;
  return { radius, where };
}

/** PURE. Short English description of when tracking will start (for events/UI). */
function describeTrackingStartCondition(assignment) {
  switch (assignment?.tracking_start_mode) {
    case 'after_message_sent':
      return 'after the route message is sent to the driver group';
    case 'scheduled_time':
      return `at the scheduled time (${formatCentralTime(assignment.tracking_start_at)})`;
    case 'start_location': {
      const { radius, where } = startLocationSummary(assignment);
      return `when the truck reaches ${where} (within ${radius} mi)`;
    }
    default:
      return 'immediately';
  }
}

/** PURE. Driver-facing line describing when Route Control starts monitoring. */
function buildTrackingSection(assignment) {
  switch (assignment?.tracking_start_mode) {
    case 'scheduled_time':
      return `Route Control will start monitoring at ${escapeHtml(formatCentralTime(assignment.tracking_start_at))}.`;
    case 'start_location': {
      const { radius, where } = startLocationSummary(assignment);
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
 * collapse into "… and N more stops").
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

/** PURE. The off-route warning sent to the driver group. */
function buildOffRouteMessage(assignment, verdict) {
  const miles = verdict.deviationMeters != null
    ? ` (about ${(verdict.deviationMeters / 1609.34).toFixed(1)} mi off)` : '';
  return '🧭 Route Control: you appear to be off the assigned route'
    + `${miles}. Please return to the planned route, or contact dispatch if there is a reason for the change.`;
}

module.exports = {
  cleanAddressText,
  escapeHref,
  estimatedCaptionLength,
  formatCentralTime,
  describeTrackingStartCondition,
  buildTrackingSection,
  buildDriverGroupRouteMessage,
  buildOffRouteMessage,
};
