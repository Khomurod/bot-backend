/**
 * Route Control constants — limits, defaults and stable machine-readable codes.
 *
 * No business logic and no requires beyond the shared radius constant, so every
 * other Route Control module can depend on this without creating a cycle.
 */
const { ROUTE_COMPLETION_RADIUS_MILES } = require('../routeControlConstants');

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

// Short caption on the PHOTO part when the full route text is too long for a
// caption and rides in its own separate message (photo + text delivery). Kept
// identical between the first send and later in-place edits so a re-edit with no
// changes is a harmless no-op ("message is not modified").
const PHOTO_ONLY_CAPTION = '🚚 <b>Route Assigned</b> — details below.';

const TRACKING_START_MODES = ['immediate', 'after_message_sent', 'scheduled_time', 'start_location'];
const DEFAULT_START_RADIUS_MILES = 2;

module.exports = {
  POLL_MS_MIN,
  METERS_PER_MILE,
  DEFAULT_COMPLETION_RADIUS_MILES,
  COMPLETION_EPSILON_METERS,
  DESTINATION_REPAIR_MAX_ATTEMPTS,
  DESTINATION_REPAIR_MIN_INTERVAL_MS,
  COMPLETION_BLOCKED,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_TEXT_SAFE_MAX,
  PHOTO_ONLY_CAPTION,
  TRACKING_START_MODES,
  DEFAULT_START_RADIUS_MILES,
};
