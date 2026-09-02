/**
 * Live Locations (the dispatch map) — service façade.
 *
 * RE-EXPORT ONLY. The dispatch routes and several tests import
 * `services/liveLocationsService`, so the path stays the stable public seam
 * while the work lives in focused modules:
 *
 *   ./liveLocations/constants.js  cache TTLs and ETA knobs (the cost control)
 *   ./liveLocations/caches.js     every cache + in-flight map, single owner
 *   ./liveLocations/shaping.js    PURE coercion, sort keys, bounded concurrency
 *   ./liveLocations/providers.js  Samsara + Drive HoS fan-out, normalized
 *   ./liveLocations/orders.js     the Datatruck order window, indexed
 *   ./liveLocations/eta.js        straight-line ETA (no routing API on purpose)
 *   ./liveLocations/snapshot.js   the assembled map payload, TTL-cached
 *   ./liveLocations/routes.js     the drawn route for one unit
 *
 * This is the SMALL live-GPS lookup that stayed in this process when the
 * Samsara safety-event poller moved to its own service. Do not grow it into a
 * poller — see docs/architecture/samsara-separation.md.
 */
const { SNAPSHOT_TTL_MS, STALE_MINUTES } = require('./liveLocations/constants');
const { clearCaches } = require('./liveLocations/caches');
const { orderSortKey, unitNumberForRow } = require('./liveLocations/shaping');
const {
  resolveLocationForUnit, buildLocationFromSamsaraVehicle, buildLocationFromDriveHosVehicle,
} = require('./liveLocations/providers');
const {
  computeNextStop, indexOrdersByDriver, indexOrdersByUnit,
} = require('./liveLocations/orders');
const { getSnapshot, buildSnapshot } = require('./liveLocations/snapshot');
const { getRouteForUnit } = require('./liveLocations/routes');

module.exports = {
  getSnapshot,
  getRouteForUnit,
  buildSnapshot,
  clearCaches,
  // exported for unit tests
  computeNextStop,
  indexOrdersByDriver,
  indexOrdersByUnit,
  orderSortKey,
  resolveLocationForUnit,
  buildLocationFromSamsaraVehicle,
  buildLocationFromDriveHosVehicle,
  unitNumberForRow,
  SNAPSHOT_TTL_MS,
  STALE_MINUTES,
};
