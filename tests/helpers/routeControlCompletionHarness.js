/**
 * Shared harness for the destination auto-completion tests: the exact-distance
 * GPS fixtures (pure evaluateDestinationCompletion) and the runRouteMonitorCheck
 * harness with completion-aware routeControl + resolver stubs.
 */
const { loadService, loadServiceWith } = require('./routeControlHarness');

const service = loadService();
const { evaluateDestinationCompletion } = service;

// Distances along a meridian (dLng = 0) are exact for haversine: R * dLatRad.
// This lets us place a GPS point at a KNOWN mileage from the destination.
const EARTH_R_M = 6_371_000;
const M_PER_MILE = 1609.34;
const DEST = { status: 'active', destination_lat: 40, destination_lng: -100 };

/** A fresh GPS ping exactly `miles` due south of the destination. */
function pointMilesFromDest(miles, extra = {}) {
  const dLatDeg = ((miles * M_PER_MILE) / EARTH_R_M) * (180 / Math.PI);
  return {
    latitude: 40 - dLatDeg, longitude: -100, speedMilesPerHour: 55, pingAgeMinutes: 1, ...extra,
  };
}

const COMPLETION_SETTINGS = { staleGpsMinutes: 15, completionRadiusMiles: 50 };

function completion(location, assignmentOverrides = {}, settings = COMPLETION_SETTINGS) {
  return evaluateDestinationCompletion({
    assignment: { ...DEST, ...assignmentOverrides },
    location,
    staleGpsMinutes: settings.staleGpsMinutes,
    completionRadiusMiles: settings.completionRadiusMiles,
  });
}

/** runRouteMonitorCheck harness with completion-aware routeControl + resolver stubs. */
function loadServiceForCompletion({
  assignments, location, completeReturns = 'active', gmapsEnabled = true,
  gmapsThrows = false, resolverThrows = null, resolverCapture = null, extraRcMock = {},
}) {
  const captured = {
    completed: [], events: [], monitorStates: [], telegramSends: [], diagnostics: [], activated: [],
  };
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': {
      async getGmapsConfig() {
        if (gmapsThrows) throw new Error('settings table unavailable');
        return {
          enabled: gmapsEnabled, deviationThresholdMeters: 250, offRouteGraceChecks: 3,
          warningCooldownMinutes: 30, staleGpsMinutes: 15, parkedSpeedMph: 5,
          checkIntervalSeconds: 300, routeCompletionRadiusMiles: 50,
        };
      },
    },
    '../services/liveLocationResolver.js': {
      async resolveLiveLocationForGroupTitle(groupTitle, opts) {
        if (resolverCapture) resolverCapture.push({ groupTitle, opts });
        if (resolverThrows) { const e = new Error(resolverThrows); e.code = resolverThrows; throw e; }
        return { location, source: 'Samsara' };
      },
    },
    '../database/routeControl.js': {
      async listActiveAssignmentsForMonitor() { return assignments; },
      async completeRouteAssignment(id, data) {
        captured.completed.push({ id, data });
        // 'active' → we won the race and get the row back; 'raced' → another tick
        // already completed it (WHERE status='active' matched nothing → null).
        return completeReturns === 'active' ? { id, status: 'completed', ...data } : null;
      },
      async insertRouteMonitorEvent(e) { captured.events.push(e); return e; },
      async updateRouteAssignmentMonitorState(id, s) { captured.monitorStates.push({ id, s }); return null; },
      async updateCompletionDiagnostics(id, d) { captured.diagnostics.push({ id, ...d }); return { id }; },
      async setTrackingHoldReason() { return null; },
      async activateTracking(id) { captured.activated.push(id); return { id }; },
      async setRouteAssignmentDestinationCoords() { return null; },
      async recordDestinationRepairAttempt() { return null; },
      ...extraRcMock,
    },
  });
  const telegram = {
    async sendMessage(chatId, text, extra) { captured.telegramSends.push({ chatId, text, extra }); return { message_id: 1 }; },
  };
  return { svc, telegram, captured };
}

const NEAR_DEST_OFF_ROUTE = pointMilesFromDest(8); // 8 mi from dest, far from the POLYLINE

module.exports = {
  evaluateDestinationCompletion,
  M_PER_MILE,
  DEST,
  pointMilesFromDest,
  COMPLETION_SETTINGS,
  completion,
  loadServiceForCompletion,
  NEAR_DEST_OFF_ROUTE,
};
