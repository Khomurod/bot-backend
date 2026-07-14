/**
 * Route Control — shared constants.
 *
 * Completion radius: the ONE authoritative default/range for the auto-complete
 * radius around the FINAL destination. database/gmapsSettings.js (persistence +
 * clamping) and services/routeControlService.js (evaluation fallback) both read
 * from here so the default can never drift between layers. The database column
 * default and its one-shot 10→35 migration live in database/schema.sql and must
 * be kept in sync with ROUTE_COMPLETION_RADIUS_MILES.DEFAULT.
 *
 * Telegram authorization: authorization to assign a route from Telegram
 * normally comes from dispatch team membership (see
 * routeMessageDetection.authorizeRouteAssigner). On top of that, an optional
 * list of GLOBAL admins may assign a route for ANY driver group, mirroring the
 * env-configurable pattern used by mileage-bonus accounting and home-time
 * approvers. Usernames are compared case-insensitively without a leading '@';
 * numeric ids (when set) are also honored.
 *
 *   ROUTE_CONTROL_ADMIN_USERNAMES=alice_dispatch,bob_ops
 *   ROUTE_CONTROL_ADMIN_USER_IDS=2117922421,123456
 */
const { normalizeTelegramUsername } = require('./telegramUsername');

// Auto-complete radius (miles) around the final destination. The DB CHECK
// constraint remains 0.5–100 (pre-existing, additive-safe); reads/writes are
// clamped to this recommended range. A stored legacy value below MIN is read
// as MIN.
const ROUTE_COMPLETION_RADIUS_MILES = Object.freeze({
  DEFAULT: 35,
  MIN: 1,
  MAX: 100,
});

function csvValues(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

const ADMIN_USERNAMES = new Set(
  csvValues(process.env.ROUTE_CONTROL_ADMIN_USERNAMES)
    .map((u) => normalizeTelegramUsername(u))
    .filter(Boolean)
);

const ADMIN_USER_IDS = new Set(
  csvValues(process.env.ROUTE_CONTROL_ADMIN_USER_IDS)
    .map((id) => Number(id))
    .filter(Number.isFinite)
);

/** A global route admin may assign a route for any driver group. */
function isGlobalRouteAdmin(user) {
  if (!user) return false;
  if (user.id != null && ADMIN_USER_IDS.has(Number(user.id))) return true;
  const username = normalizeTelegramUsername(user.username);
  return Boolean(username && ADMIN_USERNAMES.has(username));
}

module.exports = {
  ADMIN_USERNAMES,
  ADMIN_USER_IDS,
  isGlobalRouteAdmin,
  ROUTE_COMPLETION_RADIUS_MILES,
};
