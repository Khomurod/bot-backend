/**
 * Maps the stored Settings → GMaps config onto the tunables the Route Control
 * evaluators expect.
 *
 * Its own module because BOTH the monitor pass and the completion-only
 * reconciliation need it, and neither should have to depend on the other.
 */
const { DEFAULT_COMPLETION_RADIUS_MILES } = require('./constants');

/**
 * PURE. Every field falls back to a safe default so completion (which runs even
 * when the settings row is unavailable) never loses its stale-GPS protection.
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

module.exports = { monitorSettingsFromConfig };
