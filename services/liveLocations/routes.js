/**
 * The drawn ROUTE for one unit on the dispatch map.
 *
 * Split out of services/liveLocationsService.js, which re-exports it.
 */
const samsara = require('../samsaraLocationService');
const eta = require('../etaRoutingService');
const { ROUTE_TTL_MS } = require('./constants');
const { nowMs, routeCache } = require('./caches');
const { toNumberOrNull } = require('./shaping');
const { getSnapshot } = require('./snapshot');
const { getActiveOrders, indexOrdersByDriver, indexOrdersByUnit, computeNextStop } = require('./orders');
const { geocodeStop } = require('./eta');

/**
 * Precise routed ETA + route geometry for ONE selected unit (kept out of the
 * snapshot to keep it fast). Uses the shared etaRoutingService (OSRM → Google →
 * straight-line). Route geometry is returned as a simple current→destination
 * line (the routing helper does not expose full polylines); this is enough to
 * show direction of travel on the map. Cached per unit for ROUTE_TTL_MS.
 */
async function getRouteForUnit(unit) {
  const normalizedUnit = samsara.normalizeUnitNumber(unit);
  if (!normalizedUnit) return { status: 'error', message: 'Invalid unit' };

  const now = nowMs();
  const cached = routeCache.get(normalizedUnit);
  if (cached && now - cached.at < ROUTE_TTL_MS) return cached.route;

  const snapshot = await getSnapshot();
  const entry = (snapshot.units || []).find((u) => u.unit === normalizedUnit);
  if (!entry || !entry.location) {
    return { status: 'unavailable', message: 'No location for this unit' };
  }
  const destAddress = entry.load && entry.load.nextStopAddress;
  if (!destAddress) {
    return { status: 'unavailable', message: 'No next stop for this unit' };
  }

  let route;
  try {
    const routed = await eta.calculateEtaToDestination({
      currentLatitude: entry.location.lat,
      currentLongitude: entry.location.lng,
      destinationQuery: destAddress,
    });
    if (!routed || !routed.destination) {
      route = { status: 'unavailable', message: 'Routing unavailable' };
    } else {
      route = {
        status: 'ok',
        unit: normalizedUnit,
        distanceMiles: routed.remainingMiles ?? null,
        durationMinutes: routed.etaMinutes ?? null,
        arrivalTime: routed.etaChicagoIso ?? null,
        source: routed.approximate ? 'straight-line' : 'osrm',
        origin: { lat: entry.location.lat, lng: entry.location.lng },
        destination: { lat: routed.destination.latitude, lng: routed.destination.longitude },
        // Simple two-point line current → destination.
        geometry: [
          [entry.location.lat, entry.location.lng],
          [routed.destination.latitude, routed.destination.longitude],
        ],
      };
    }
  } catch (err) {
    route = { status: 'error', message: err.message };
  }

  routeCache.set(normalizedUnit, { at: now, route });
  return route;
}

module.exports = {
  getRouteForUnit,
};
