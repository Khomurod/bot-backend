/**
 * The Live Locations caches — SHARED MUTABLE STATE with one owner.
 *
 * Every cache and in-flight promise for the dispatch map lives here, so there
 * is exactly one place that holds them and exactly one clearCaches(). The
 * in-flight maps are what collapse a burst of admin tabs polling at once into a
 * single provider fan-out; dropping them would multiply external calls.
 *
 * Split out of services/liveLocationsService.js, which re-exports clearCaches.
 */

function nowMs() {
  return Date.now();
}

// ─── In-memory caches ────────────────────────────────────────────────────────
let snapshotCache = null;      // { at, data }

let snapshotInFlight = null;   // Promise

let ordersCache = null;        // { at, orders }

let ordersInFlight = null;     // Promise

const etaCache = new Map();    // key -> { at, eta }

const geocodeCache = new Map();// normalizedAddress -> { at, coords }

const routeCache = new Map();  // unit -> { at, route }

/** Test/maintenance helper — clear every in-memory cache. */
function clearCaches() {
  snapshotCache = null;
  snapshotInFlight = null;
  ordersCache = null;
  ordersInFlight = null;
  etaCache.clear();
  geocodeCache.clear();
  routeCache.clear();
}

module.exports = {
  nowMs,
  snapshotCache,
  snapshotInFlight,
  ordersCache,
  ordersInFlight,
  etaCache,
  geocodeCache,
  routeCache,
  clearCaches,
};
