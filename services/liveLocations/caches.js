'use strict';

/**
 * The Live Locations caches — SHARED MUTABLE STATE with one owner.
 *
 * Every cache and in-flight promise for the dispatch map lives here, so there
 * is exactly one place that holds them and exactly one clearCaches(). The
 * in-flight slots are what collapse a burst of admin tabs polling at once into
 * a single provider fan-out and a single database read; without them, every
 * poll from every tab costs a full rebuild.
 *
 * WHY SLOTS AND NOT `let` EXPORTS. This module used to export four `let`
 * bindings by value. `module.exports = { snapshotCache, … }` copies whatever
 * they held at load time — `null` — and a consumer doing
 * `const { snapshotCache } = require('./caches')` binds a CONST. So
 * `snapshotCache = { at, data }` inside snapshot.js threw
 * "TypeError: Assignment to constant variable." on the first uncached request,
 * which is a 500 from the live map, and getActiveOrders had the same break.
 * A slot is an object, so the reference exported here never changes and both
 * reads and writes reach the one owner.
 *
 * Split out of services/liveLocationsService.js, which re-exports clearCaches.
 */

function nowMs() {
  return Date.now();
}

/** One mutable value with an owner: `get()`, `set(v)`, `clear()`. */
function createSlot() {
  let value = null;
  return {
    get: () => value,
    set: (next) => { value = next; return next; },
    clear: () => { value = null; },
  };
}

// ─── In-memory caches ────────────────────────────────────────────────────────
/** { at, data } — the assembled dispatch snapshot. */
const snapshotSlot = createSlot();

/** Promise — the build every concurrent caller shares. */
const snapshotInFlightSlot = createSlot();

/** { at, orders } — the Datatruck order window. */
const ordersSlot = createSlot();

/** Promise — the order fetch every concurrent caller shares. */
const ordersInFlightSlot = createSlot();

// Maps are mutated through their own methods, so exporting the reference is
// enough — no slot needed.
const etaCache = new Map();    // key -> { at, eta }

const geocodeCache = new Map();// normalizedAddress -> { at, coords }

const routeCache = new Map();  // unit -> { at, route }

/** Test/maintenance helper — clear every in-memory cache. */
function clearCaches() {
  snapshotSlot.clear();
  snapshotInFlightSlot.clear();
  ordersSlot.clear();
  ordersInFlightSlot.clear();
  etaCache.clear();
  geocodeCache.clear();
  routeCache.clear();
}

module.exports = {
  nowMs,
  createSlot,
  snapshotSlot,
  snapshotInFlightSlot,
  ordersSlot,
  ordersInFlightSlot,
  etaCache,
  geocodeCache,
  routeCache,
  clearCaches,
};
