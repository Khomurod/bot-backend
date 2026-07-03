/**
 * currentLoadService — the single shared entry point for "what load is this
 * driver/unit on right now?".
 *
 * Datatruck is the primary source of truth for current load information. This
 * module is a thin, intention-revealing facade over datatruckLoadService (which
 * owns the Datatruck OpenAPI client, normalization, and the short-TTL cache) so
 * every consumer — Live Locations, /load, /status, dispatch ETA — imports the
 * same functions and shares the same cache:
 *
 *   getCurrentLoadByDriver(driverName)  -> normalized load | null
 *   getCurrentLoadByUnit(unitNumber)    -> normalized load | null
 *   getCurrentLoadByGroup(group)        -> normalized load | null
 *   getNextStop(load)                   -> { type, name, address, lat, lng, ... } | null
 *   getLoadStatus(load)                 -> status string | null
 *   isConfigured()                      -> boolean
 *
 * Every resolver returns null (never throws) when Datatruck is unconfigured, no
 * order matches, or the API fails, so callers can cleanly fall back to their
 * existing logic (pinned message / stored load / chat history) only when there
 * is genuinely no Datatruck data.
 */
const datatruckLoadService = require('./datatruckLoadService');

module.exports = {
  isConfigured: datatruckLoadService.isConfigured,
  getCurrentLoadByDriver: datatruckLoadService.getCurrentLoadByDriver,
  getCurrentLoadByUnit: datatruckLoadService.getCurrentLoadByUnit,
  getCurrentLoadByGroup: datatruckLoadService.getCurrentLoadByGroup,
  getNextStop: datatruckLoadService.getNextStop,
  getLoadStatus: datatruckLoadService.getLoadStatus,
  // Escape hatch for the admin diagnostics panel / dispatch testing view.
  getAdminRecentLoadsForGroup: datatruckLoadService.getAdminRecentLoadsForGroup,
};
