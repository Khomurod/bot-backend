/**
 * Datatruck ORDERS behind the dispatch map.
 *
 * Loads the active order window once per TTL and indexes it by driver and by
 * unit so each truck on the map can be matched to its next stop.
 *
 * Split out of services/liveLocationsService.js, which re-exports these for
 * its unit tests.
 */
const datatruck = require('../datatruckApiService');
const datatruckLoads = require('../datatruckLoadService');
const { LOOKBACK_DAYS, LOOKAHEAD_DAYS, ORDERS_TTL_MS } = require('./constants');
const { nowMs, ordersSlot, ordersInFlightSlot } = require('./caches');
const { orderSortKey, toNumberOrNull, toIso } = require('./shaping');

// ─── Loads: one Datatruck order-window fetch, matched locally ─────────────────
async function getActiveOrders(now) {
  if (!datatruck.isConfigured()) return { orders: [], error: null };
  const cached = ordersSlot.get();
  if (cached && now - cached.at < ORDERS_TTL_MS) {
    return { orders: cached.orders, error: null };
  }
  const running = ordersInFlightSlot.get();
  if (running) return running;

  const fetching = (async () => {
    try {
      const startIso = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString();
      const endIso = new Date(now + LOOKAHEAD_DAYS * 86_400_000).toISOString();
      const orders = await datatruck.fetchOrdersByDocumentWindow(startIso, endIso);
      ordersSlot.set({ at: now, orders });
      return { orders, error: null };
    } catch (err) {
      // Reuse the last good order set (if any) and surface the error.
      const lastGood = ordersSlot.get();
      return {
        orders: lastGood ? lastGood.orders : [],
        error: { provider: 'datatruck', code: err.code || 'ERROR', message: err.message },
      };
    } finally {
      ordersInFlightSlot.clear();
    }
  })();
  ordersInFlightSlot.set(fetching);
  return fetching;
}

function indexOrdersByDriver(orders, now) {
  const byDriver = new Map(); // normalizedName -> best order
  for (const order of orders) {
    const candidates = datatruck.orderDriverCandidates(order)
      .map((c) => datatruck.normalizeNameForMatch(c))
      .filter(Boolean);
    for (const name of candidates) {
      const existing = byDriver.get(name);
      if (!existing || orderSortKey(order, now) < orderSortKey(existing, now)) {
        byDriver.set(name, order);
      }
    }
  }
  return byDriver;
}

/**
 * Index active orders by normalized unit/truck number so a unit whose driver
 * name does not match (or is missing on the group row) can still be matched to
 * its load via `trip.truck__unit_number`. Keyed to the best (soonest-relevant)
 * order per unit, same ranking as the driver index.
 */
function indexOrdersByUnit(orders, now) {
  const byUnit = new Map(); // normalizedUnit -> best order
  for (const order of orders) {
    const units = new Set(
      datatruck.orderUnitCandidates(order)
        .map((c) => datatruck.normalizeUnitForMatch(c))
        .filter(Boolean)
    );
    for (const unit of units) {
      const existing = byUnit.get(unit);
      if (!existing || orderSortKey(order, now) < orderSortKey(existing, now)) {
        byUnit.set(unit, order);
      }
    }
  }
  return byUnit;
}

function computeNextStop(load, now) {
  if (!load) return null;
  const pickupEndMs = load.pickupWindowEnd ? Date.parse(load.pickupWindowEnd) : NaN;
  const pickupPassed = Number.isFinite(pickupEndMs) && now > pickupEndMs;
  const hasPickup = Boolean(load.pickupAddress);
  const hasDelivery = Boolean(load.deliveryAddress);

  let type = null;
  if (hasPickup && !pickupPassed) type = 'pickup';
  else if (hasDelivery) type = 'delivery';
  else if (hasPickup) type = 'pickup';
  else return null;

  const isPickup = type === 'pickup';
  return {
    nextStopType: type,
    nextStopName: (isPickup ? load.shipperName : load.receiverName) || null,
    nextStopAddress: (isPickup ? load.pickupAddress : load.deliveryAddress) || null,
    // Coordinates come straight from Datatruck's structured stop when present, so
    // ETA can skip geocoding entirely (faster + no dependency on the geocoder).
    nextStopLat: (isPickup ? load.pickupLat : load.deliveryLat) ?? null,
    nextStopLng: (isPickup ? load.pickupLng : load.deliveryLng) ?? null,
    appointmentStart: toIso(isPickup ? load.pickupWindowStart : load.deliveryWindowStart),
    appointmentEnd: toIso(isPickup ? load.pickupWindowEnd : load.deliveryWindowEnd),
  };
}

module.exports = {
  getActiveOrders,
  indexOrdersByDriver,
  indexOrdersByUnit,
  computeNextStop,
};
