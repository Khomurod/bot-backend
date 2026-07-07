/**
 * Route Control — Telegram authorization constants.
 *
 * Authorization to assign a route from Telegram normally comes from dispatch
 * team membership (see routeMessageDetection.authorizeRouteAssigner). On top of
 * that, an optional list of GLOBAL admins may assign a route for ANY driver
 * group, mirroring the env-configurable pattern used by mileage-bonus
 * accounting and home-time approvers. Usernames are compared case-insensitively
 * without a leading '@'; numeric ids (when set) are also honored.
 *
 *   ROUTE_CONTROL_ADMIN_USERNAMES=alice_dispatch,bob_ops
 *   ROUTE_CONTROL_ADMIN_USER_IDS=2117922421,123456
 */
const { normalizeTelegramUsername } = require('./telegramUsername');

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
};
