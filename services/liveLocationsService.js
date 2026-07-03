/**
 * Live Locations service — builds one normalized, map-ready snapshot of every
 * active unit for the admin "Live Locations" page.
 *
 * Design goals (see docs/architecture/live-locations.md):
 *  - ONE snapshot build per ~45s, shared by all admins (in-memory cache +
 *    single-flight), so N admins opening the page do not multiply API calls.
 *  - Batch every external call: fetch each GPS provider's whole fleet ONCE and
 *    match units locally (never one fleet fetch per unit); fetch the active
 *    Datatruck order window ONCE and match drivers locally (never one lookup
 *    per driver). This keeps us well under provider rate limits.
 *  - Fail soft: if a provider errors, record it in `errors`, keep the other
 *    providers, and fall back to the last good cached snapshot when a whole
 *    build fails.
 *
 * Provider fallback priority for GPS: Samsara → Factor ELD → Leader ELD
 * (the same order enforced by services/liveLocationResolver.js).
 *
 * Route geometry / precise routed ETA is intentionally NOT computed here for
 * every unit (expensive, rate-limit heavy). The snapshot uses a fast
 * straight-line ETA; precise routing for a single selected unit is served by
 * getRouteForUnit() behind GET /api/live-locations/route.
 */
const samsara = require('./samsaraLocationService');
const driveHos = require('./driveHosEldService');
const datatruck = require('./datatruckApiService');
const datatruckLoads = require('./datatruckLoadService');
const eta = require('./etaRoutingService');
const { getEldConfig } = require('../database/eldSettings');
const { listCanonicalDriverGroups } = require('./driverGroupDirectoryService');
const { extractDriverNameFromGroupTitle } = require('./driverGroupTitle');

// ─── Tunables ───────────────────────────────────────────────────────────────
const SNAPSHOT_TTL_MS = 45 * 1000;          // GPS freshness window (30–60s)
const ORDERS_TTL_MS = 3 * 60 * 1000;        // Datatruck active-order window cache
const ETA_TTL_MS = 8 * 60 * 1000;           // straight-line ETA cache
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000; // stop-address coords cache (long)
const ROUTE_TTL_MS = 8 * 60 * 1000;         // selected-unit route cache
const STALE_MINUTES = 15;                    // GPS older than this is "stale"
const LOOKBACK_DAYS = 2;
const LOOKAHEAD_DAYS = 5;
const AVG_SPEED_MPH = 50;                    // straight-line ETA assumption
const ETA_CONCURRENCY = 6;                   // bounded parallel geocodes

// ─── In-memory caches ────────────────────────────────────────────────────────
let snapshotCache = null;      // { at, data }
let snapshotInFlight = null;   // Promise
let ordersCache = null;        // { at, orders }
let ordersInFlight = null;     // Promise
const etaCache = new Map();    // key -> { at, eta }
const geocodeCache = new Map();// normalizedAddress -> { at, coords }
const routeCache = new Map();  // unit -> { at, route }

function nowMs() {
  return Date.now();
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const f = 10 ** digits;
  return Math.round(Number(value) * f) / f;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}

function normalizeAddressKey(address) {
  return String(address || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─── GPS: batch-fetch each provider's fleet once ──────────────────────────────
async function fetchProviderFleets(cfg) {
  const errors = [];
  const fleets = { samsara: null, factor: null, leader: null };
  const tasks = [];

  if (cfg.samsaraEnabled && Array.isArray(cfg.samsaraApiKeys) && cfg.samsaraApiKeys.length) {
    tasks.push((async () => {
      try {
        const all = [];
        for (const apiKey of cfg.samsaraApiKeys) {
          const vehicles = await samsara.fetchAllVehicleStats({ apiKey, apiBase: cfg.samsaraApiBase });
          all.push(...vehicles);
        }
        fleets.samsara = all;
      } catch (err) {
        errors.push({ provider: 'samsara', code: err.code || 'ERROR', message: err.message });
      }
    })());
  }

  if (cfg.factorEnabled && cfg.driveHosProviderKey && cfg.factorCompanyKey) {
    tasks.push((async () => {
      try {
        fleets.factor = await driveHos.fetchAllLatestVehicleStatuses({
          providerKey: cfg.driveHosProviderKey,
          companyKey: cfg.factorCompanyKey,
          apiBase: cfg.driveHosApiBase,
        });
      } catch (err) {
        errors.push({ provider: 'factor', code: err.code || 'ERROR', message: err.message });
      }
    })());
  }

  if (cfg.leaderEnabled && cfg.driveHosProviderKey && cfg.leaderCompanyKey) {
    tasks.push((async () => {
      try {
        fleets.leader = await driveHos.fetchAllLatestVehicleStatuses({
          providerKey: cfg.driveHosProviderKey,
          companyKey: cfg.leaderCompanyKey,
          apiBase: cfg.driveHosApiBase,
        });
      } catch (err) {
        errors.push({ provider: 'leader', code: err.code || 'ERROR', message: err.message });
      }
    })());
  }

  await Promise.all(tasks);
  return { fleets, errors };
}

function buildLocationFromSamsaraVehicle(vehicle) {
  const gps = vehicle && vehicle.gps ? vehicle.gps : {};
  if (typeof gps.latitude !== 'number' || typeof gps.longitude !== 'number') return null;
  const pingIso = gps.time || null;
  const ageMin = samsara.computePingAgeMinutes(pingIso);
  return {
    lat: gps.latitude,
    lng: gps.longitude,
    heading: typeof gps.headingDegrees === 'number' ? gps.headingDegrees : null,
    speedMph: round(gps.speedMilesPerHour, 0),
    lastUpdated: pingIso,
    isStale: ageMin != null && ageMin > STALE_MINUTES,
  };
}

function buildLocationFromDriveHosVehicle(vehicle) {
  const lat = toNumberOrNull(vehicle && (vehicle.lat ?? vehicle.latitude));
  const lng = toNumberOrNull(vehicle && (vehicle.lon ?? vehicle.lng ?? vehicle.longitude));
  if (lat == null || lng == null) return null;
  const pingIso = (vehicle && vehicle.timestamp) || null;
  const ageMin = samsara.computePingAgeMinutes(pingIso);
  return {
    lat,
    lng,
    heading: toNumberOrNull(vehicle && (vehicle.heading ?? vehicle.bearing ?? vehicle.rotation)),
    speedMph: round(toNumberOrNull(vehicle && vehicle.speed), 0),
    lastUpdated: pingIso,
    isStale: ageMin != null && ageMin > STALE_MINUTES,
  };
}

/** Resolve GPS for one unit against the pre-fetched fleets, in priority order. */
function resolveLocationForUnit(fleets, unitNumber, driverNameHint) {
  if (fleets.samsara) {
    const v = samsara.findVehicleByUnit(fleets.samsara, unitNumber, { driverNameHint });
    if (v) {
      const loc = buildLocationFromSamsaraVehicle(v);
      if (loc) return { provider: 'samsara', location: loc };
    }
  }
  if (fleets.factor) {
    const v = driveHos.findVehicleByUnit(fleets.factor, unitNumber);
    if (v) {
      const loc = buildLocationFromDriveHosVehicle(v);
      if (loc) return { provider: 'factor', location: loc };
    }
  }
  if (fleets.leader) {
    const v = driveHos.findVehicleByUnit(fleets.leader, unitNumber);
    if (v) {
      const loc = buildLocationFromDriveHosVehicle(v);
      if (loc) return { provider: 'leader', location: loc };
    }
  }
  return { provider: null, location: null };
}

// ─── Loads: one Datatruck order-window fetch, matched locally ─────────────────
async function getActiveOrders(now) {
  if (!datatruck.isConfigured()) return { orders: [], error: null };
  if (ordersCache && now - ordersCache.at < ORDERS_TTL_MS) {
    return { orders: ordersCache.orders, error: null };
  }
  if (ordersInFlight) return ordersInFlight;

  ordersInFlight = (async () => {
    try {
      const startIso = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString();
      const endIso = new Date(now + LOOKAHEAD_DAYS * 86_400_000).toISOString();
      const orders = await datatruck.fetchOrdersByDocumentWindow(startIso, endIso);
      ordersCache = { at: now, orders };
      return { orders, error: null };
    } catch (err) {
      // Reuse the last good order set (if any) and surface the error.
      return {
        orders: ordersCache ? ordersCache.orders : [],
        error: { provider: 'datatruck', code: err.code || 'ERROR', message: err.message },
      };
    } finally {
      ordersInFlight = null;
    }
  })();
  return ordersInFlight;
}

/** Soonest still-relevant appointment (mirrors datatruckApiService ranking). */
function orderSortKey(order, now) {
  const appt = (kind) => {
    const iso = kind === 'pickup'
      ? (order?.pickup_time || order?.pickup_appointment_time)
      : (order?.delivery_time || order?.delivery_appointment_time);
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const pu = appt('pickup');
  const del = appt('delivery');
  if (pu != null && pu >= now) return pu;
  if (del != null && del >= now) return del;
  return Math.max(pu || 0, del || 0) + 1e15;
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
    appointmentStart: toIso(isPickup ? load.pickupWindowStart : load.deliveryWindowStart),
    appointmentEnd: toIso(isPickup ? load.pickupWindowEnd : load.deliveryWindowEnd),
  };
}

// ─── Geocoding (long-term cache) + straight-line ETA ──────────────────────────
async function geocodeStop(address, now) {
  const key = normalizeAddressKey(address);
  if (!key) return null;
  const cached = geocodeCache.get(key);
  if (cached && now - cached.at < GEOCODE_TTL_MS) return cached.coords;
  try {
    const place = await eta.geocodePlace(address);
    const coords = place && Number.isFinite(place.latitude) && Number.isFinite(place.longitude)
      ? { lat: place.latitude, lng: place.longitude, displayName: place.displayName || null }
      : null;
    geocodeCache.set(key, { at: now, coords });
    return coords;
  } catch (_) {
    return cached ? cached.coords : null;
  }
}

/** Fast straight-line ETA for the snapshot. Precise routing is in getRouteForUnit. */
async function computeStraightLineEta(unit, location, nextStopAddress, now) {
  if (!location || !nextStopAddress) return { status: 'unavailable' };
  const cacheKey = `${unit}|${normalizeAddressKey(nextStopAddress)}|${location.lat.toFixed(2)}|${location.lng.toFixed(2)}`;
  const cached = etaCache.get(cacheKey);
  if (cached && now - cached.at < ETA_TTL_MS) return cached.eta;

  const dest = await geocodeStop(nextStopAddress, now);
  let result;
  if (!dest) {
    result = { status: 'unavailable' };
  } else {
    const miles = eta.haversineMiles(location.lat, location.lng, dest.lat, dest.lng);
    const durationMinutes = Math.round((miles / AVG_SPEED_MPH) * 60);
    result = {
      status: 'ok',
      distanceMiles: round(miles, 1),
      durationMinutes,
      arrivalTime: new Date(now + durationMinutes * 60_000).toISOString(),
      source: 'straight-line',
      approximate: true,
      destLat: dest.lat,
      destLng: dest.lng,
      routeGeometry: null,
    };
  }
  etaCache.set(cacheKey, { at: now, eta: result });
  return result;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = new Array(workerCount).fill(null).map(async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Unit enumeration ─────────────────────────────────────────────────────────
async function listActiveUnits() {
  const rows = await listCanonicalDriverGroups({ operational: true, includeNonDrivers: false });
  return rows.filter((r) => r
    && r.group_type === 'driver'
    && !r.inactive
    && r.operational_visible !== false
    && samsara.normalizeUnitNumber(r.unit_number) != null);
}

function driverNameForGroupRow(row) {
  const explicit = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  if (explicit) return explicit;
  return extractDriverNameFromGroupTitle(row.raw_group_title || row.group_name || '');
}

function telegramGroupLinkFor(row) {
  const username = String(row.telegram_username || '').replace(/^@/, '').trim();
  return username ? `https://t.me/${username}` : null;
}

// ─── Snapshot assembly ────────────────────────────────────────────────────────
async function buildSnapshot() {
  const now = nowMs();
  const cfg = await getEldConfig();

  const [{ fleets, errors: providerErrors }, orderResult, units] = await Promise.all([
    fetchProviderFleets(cfg),
    getActiveOrders(now),
    listActiveUnits(),
  ]);

  const errors = [...providerErrors];
  if (orderResult.error) errors.push(orderResult.error);

  const ordersByDriver = indexOrdersByDriver(orderResult.orders || [], now);

  const built = units.map((row) => {
    const unitNumber = samsara.normalizeUnitNumber(row.unit_number);
    const groupTitle = row.raw_group_title || row.group_name || '';
    const driverName = driverNameForGroupRow(row);
    const driverNameHint = extractDriverNameFromGroupTitle(groupTitle) || driverName;

    const { provider, location } = resolveLocationForUnit(fleets, unitNumber, driverNameHint);

    const normDriver = datatruck.normalizeNameForMatch(driverName);
    const order = normDriver ? ordersByDriver.get(normDriver) : null;
    const rawLoad = order ? datatruckLoads.extractLoadFromOrder(order) : null;

    let load = null;
    if (rawLoad) {
      const nextStop = computeNextStop(rawLoad, now);
      load = {
        loadId: rawLoad.loadIdentifier,
        status: rawLoad.status,
        nextStopType: nextStop ? nextStop.nextStopType : null,
        nextStopName: nextStop ? nextStop.nextStopName : null,
        nextStopAddress: nextStop ? nextStop.nextStopAddress : null,
        nextStopLat: null,
        nextStopLng: null,
        appointmentStart: nextStop ? nextStop.appointmentStart : null,
        appointmentEnd: nextStop ? nextStop.appointmentEnd : null,
      };
    }

    return {
      row, unitNumber, provider, location, driverName, load,
    };
  });

  // ETA pass (bounded concurrency); straight-line only for units with a stop.
  await mapWithConcurrency(built, ETA_CONCURRENCY, async (entry) => {
    if (!entry.location || !entry.load || !entry.load.nextStopAddress) {
      entry.eta = { status: 'unavailable' };
      return;
    }
    const e = await computeStraightLineEta(entry.unitNumber, entry.location, entry.load.nextStopAddress, now);
    entry.eta = e;
    if (e.status === 'ok') {
      entry.load.nextStopLat = e.destLat ?? null;
      entry.load.nextStopLng = e.destLng ?? null;
    }
  });

  let activeLoads = 0;
  let staleGps = 0;
  let noActiveLoad = 0;

  const unitsOut = built.map((entry) => {
    const warnings = [];
    if (!entry.location) {
      warnings.push(providerErrors.length ? 'provider_unavailable' : 'no_gps');
    } else if (entry.location.isStale) {
      warnings.push('stale_gps');
    }
    if (!entry.load) warnings.push('no_active_load');

    if (entry.load) activeLoads += 1; else noActiveLoad += 1;
    if (entry.location && entry.location.isStale) staleGps += 1;

    const row = entry.row;
    const eta = entry.eta || { status: 'unavailable' };
    return {
      unit: entry.unitNumber,
      driverName: entry.driverName || null,
      groupName: row.group_name || row.display_name || null,
      telegramGroupId: row.telegram_group_id != null ? String(row.telegram_group_id) : null,
      telegramGroupLink: telegramGroupLinkFor(row),
      provider: entry.provider,
      location: entry.location,
      load: entry.load,
      eta: {
        status: eta.status,
        distanceMiles: eta.distanceMiles ?? null,
        durationMinutes: eta.durationMinutes ?? null,
        arrivalTime: eta.arrivalTime ?? null,
        source: eta.source ?? null,
        routeGeometry: null,
      },
      warnings,
    };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    ttlSeconds: Math.round(SNAPSHOT_TTL_MS / 1000),
    summary: {
      totalUnits: unitsOut.length,
      activeLoads,
      staleGps,
      noActiveLoad,
      providerErrors: providerErrors.length,
    },
    units: unitsOut,
    errors,
  };
}

/**
 * Get the cached snapshot, rebuilding at most once per SNAPSHOT_TTL_MS.
 * Concurrent callers share one in-flight build. On build failure the last good
 * snapshot is returned, flagged `stale: true`.
 */
async function getSnapshot({ force = false } = {}) {
  const now = nowMs();
  if (!force && snapshotCache && now - snapshotCache.at < SNAPSHOT_TTL_MS) {
    return snapshotCache.data;
  }
  if (snapshotInFlight) return snapshotInFlight;

  snapshotInFlight = (async () => {
    try {
      const data = await buildSnapshot();
      snapshotCache = { at: nowMs(), data };
      return data;
    } catch (err) {
      if (snapshotCache) {
        return {
          ...snapshotCache.data,
          stale: true,
          errors: [
            ...(snapshotCache.data.errors || []),
            { provider: 'snapshot', code: 'BUILD_FAILED', message: err.message },
          ],
        };
      }
      throw err;
    } finally {
      snapshotInFlight = null;
    }
  })();
  return snapshotInFlight;
}

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
  getSnapshot,
  getRouteForUnit,
  buildSnapshot,
  clearCaches,
  // exported for unit tests
  computeNextStop,
  indexOrdersByDriver,
  orderSortKey,
  resolveLocationForUnit,
  buildLocationFromSamsaraVehicle,
  buildLocationFromDriveHosVehicle,
  SNAPSHOT_TTL_MS,
  STALE_MINUTES,
};
