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
  let ambiguous = false;
  let matchWarning = null;
  if (fleets.samsara) {
    const selection = samsara.selectVehicleByUnit(fleets.samsara, unitNumber, { driverNameHint });
    if (selection.vehicle) {
      const loc = buildLocationFromSamsaraVehicle(selection.vehicle);
      if (loc) return { provider: 'samsara', location: loc, ambiguous: false, matchWarning: null };
    } else if (selection.ambiguous) {
      // Duplicate unit number with no confident driver-name winner: do NOT use a
      // (possibly wrong) Samsara truck. Flag it and let the fallbacks try.
      ambiguous = true;
      matchWarning = `Duplicate unit ${unitNumber}: ${selection.candidates.length} Samsara vehicles share it `
        + `and none clearly matches "${driverNameHint || 'this driver'}".`;
    }
  }
  if (fleets.factor) {
    const v = driveHos.findVehicleByUnit(fleets.factor, unitNumber);
    if (v) {
      const loc = buildLocationFromDriveHosVehicle(v);
      if (loc) return { provider: 'factor', location: loc, ambiguous, matchWarning };
    }
  }
  if (fleets.leader) {
    const v = driveHos.findVehicleByUnit(fleets.leader, unitNumber);
    if (v) {
      const loc = buildLocationFromDriveHosVehicle(v);
      if (loc) return { provider: 'leader', location: loc, ambiguous, matchWarning };
    }
  }
  return { provider: null, location: null, ambiguous, matchWarning };
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

/**
 * Fast straight-line ETA for the snapshot. Precise routing is in getRouteForUnit.
 * When the caller already has destination coordinates (Datatruck structured
 * stop), they are used directly and geocoding is skipped.
 */
async function computeStraightLineEta(unit, location, nextStopAddress, now, destCoords = null) {
  if (!location || (!nextStopAddress && !destCoords)) return { status: 'unavailable' };
  const destKey = destCoords
    ? `${destCoords.lat.toFixed(3)},${destCoords.lng.toFixed(3)}`
    : normalizeAddressKey(nextStopAddress);
  const cacheKey = `${unit}|${destKey}|${location.lat.toFixed(2)}|${location.lng.toFixed(2)}`;
  const cached = etaCache.get(cacheKey);
  if (cached && now - cached.at < ETA_TTL_MS) return cached.eta;

  const dest = destCoords || await geocodeStop(nextStopAddress, now);
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

/**
 * The unit number for a group row. Prefer the stored `unit_number` column, but
 * fall back to parsing it out of the group title (e.g. "WENZE UNIT # 305 …") —
 * the same source the working bot /location path uses. Without this fallback a
 * group whose unit_number column was never backfilled would silently drop out
 * of the snapshot even though Samsara has its GPS.
 */
function unitNumberForRow(row) {
  const fromColumn = samsara.normalizeUnitNumber(row.unit_number);
  if (fromColumn) return fromColumn;
  const title = row.raw_group_title || row.group_name || '';
  return samsara.normalizeUnitNumber(samsara.extractUnitNumberFromGroupName(title));
}

async function listActiveUnits() {
  const rows = await listCanonicalDriverGroups({ operational: true, includeNonDrivers: false });
  return rows.filter((r) => r
    && r.group_type === 'driver'
    && !r.inactive
    && r.operational_visible !== false
    && unitNumberForRow(r) != null);
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
  const ordersByUnit = indexOrdersByUnit(orderResult.orders || [], now);
  let loadsMatchedByUnit = 0; // loads matched via unit number where the name missed

  const built = units.map((row) => {
    const unitNumber = unitNumberForRow(row);
    const groupTitle = row.raw_group_title || row.group_name || '';
    const driverName = driverNameForGroupRow(row);
    const driverNameHint = extractDriverNameFromGroupTitle(groupTitle) || driverName;

    const {
      provider, location, ambiguous, matchWarning,
    } = resolveLocationForUnit(fleets, unitNumber, driverNameHint);

    // Load matching: driver name first (most specific), then unit number as a
    // fallback so a group whose row has no/'different' driver name still gets its
    // load via trip.truck__unit_number.
    const normDriver = datatruck.normalizeNameForMatch(driverName);
    let order = normDriver ? ordersByDriver.get(normDriver) : null;
    let matchedBy = order ? 'driver' : null;
    if (!order) {
      const normUnit = datatruck.normalizeUnitForMatch(unitNumber);
      order = normUnit ? ordersByUnit.get(normUnit) : null;
      if (order) { matchedBy = 'unit'; loadsMatchedByUnit += 1; }
    }
    const rawLoad = order ? datatruckLoads.extractLoadFromOrder(order) : null;

    let load = null;
    if (rawLoad) {
      const nextStop = computeNextStop(rawLoad, now);
      load = {
        loadId: rawLoad.loadIdentifier,
        status: rawLoad.status,
        matchedBy,
        nextStopType: nextStop ? nextStop.nextStopType : null,
        nextStopName: nextStop ? nextStop.nextStopName : null,
        nextStopAddress: nextStop ? nextStop.nextStopAddress : null,
        // Prefer Datatruck's structured stop coordinates; the ETA pass falls back
        // to geocoding the address only when these are absent.
        nextStopLat: nextStop ? nextStop.nextStopLat : null,
        nextStopLng: nextStop ? nextStop.nextStopLng : null,
        appointmentStart: nextStop ? nextStop.appointmentStart : null,
        appointmentEnd: nextStop ? nextStop.appointmentEnd : null,
      };
    }

    return {
      row, unitNumber, provider, location, driverName, load, ambiguous, matchWarning,
    };
  });

  // ETA pass (bounded concurrency); straight-line only for units with a stop.
  await mapWithConcurrency(built, ETA_CONCURRENCY, async (entry) => {
    const load = entry.load;
    const hasStop = load && (load.nextStopAddress
      || (load.nextStopLat != null && load.nextStopLng != null));
    if (!entry.location || !hasStop) {
      entry.eta = { status: 'unavailable' };
      return;
    }
    const destCoords = (load.nextStopLat != null && load.nextStopLng != null)
      ? { lat: load.nextStopLat, lng: load.nextStopLng }
      : null;
    const e = await computeStraightLineEta(
      entry.unitNumber, entry.location, load.nextStopAddress, now, destCoords
    );
    entry.eta = e;
    if (e.status === 'ok') {
      // Keep the coords used for the ETA on the load (geocoded ones fill in when
      // Datatruck did not already supply structured coordinates).
      if (load.nextStopLat == null) load.nextStopLat = e.destLat ?? null;
      if (load.nextStopLng == null) load.nextStopLng = e.destLng ?? null;
    }
  });

  let activeLoads = 0;
  let staleGps = 0;
  let noActiveLoad = 0;
  let withGps = 0;

  const unitsOut = built.map((entry) => {
    const warnings = [];
    // GPS and load are independent: a unit with GPS but no load still shows on
    // the map, and "no GPS" is reported as exactly that — NOT as
    // "provider unavailable" just because an unrelated fallback (Factor/Leader)
    // errored. Provider errors are surfaced separately in `errors`/`summary`.
    if (!entry.location) {
      warnings.push('no_gps');
    } else if (entry.location.isStale) {
      warnings.push('stale_gps');
    }
    if (!entry.load) warnings.push('no_active_load');
    // Duplicate unit number the provider couldn't disambiguate by driver name.
    if (entry.ambiguous) warnings.push('duplicate_unit_ambiguous');

    if (entry.load) activeLoads += 1; else noActiveLoad += 1;
    if (entry.location) withGps += 1;
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
      matchWarning: entry.matchWarning || null,
    };
  });

  // ─── Developer-safe debug summary (no secrets, no coordinates) ──────────────
  // Makes it obvious at a glance how each stage performed: how many vehicles
  // each provider returned, how many units matched GPS, and how loads matched.
  const providerVehiclesReturned = {
    samsara: fleets.samsara ? fleets.samsara.length : null,
    factor: fleets.factor ? fleets.factor.length : null,
    leader: fleets.leader ? fleets.leader.length : null,
  };
  const matchedByProvider = { samsara: 0, factor: 0, leader: 0 };
  for (const entry of built) {
    if (entry.provider && matchedByProvider[entry.provider] != null) matchedByProvider[entry.provider] += 1;
  }
  const loadsFetched = (orderResult.orders || []).length;
  const debug = {
    // vehicles each provider returned (null = provider disabled/not called)
    providerVehiclesReturned,
    // units enumerated from the driver directory
    unitsTotal: unitsOut.length,
    // units matched to GPS, split by which provider supplied it
    unitsWithGps: withGps,
    unitsNoGps: unitsOut.length - withGps,
    unitsStaleGps: staleGps,
    matchedByProvider,
    // Datatruck load matching
    loadsFetched,
    loadsMatched: activeLoads,
    loadsMatchedByUnit,
    loadsMatchedByDriver: Math.max(0, activeLoads - loadsMatchedByUnit),
    loadsUnmatched: Math.max(0, loadsFetched - activeLoads),
    // provider error codes only (messages may contain HTTP snippets, kept out here)
    providerErrors: providerErrors.map((e) => ({ provider: e.provider, code: e.code })),
  };
  // One-line, secret-free breadcrumb in the server logs on every rebuild.
  console.log('[LIVE-LOCATIONS] snapshot built:', JSON.stringify(debug));

  return {
    generatedAt: new Date(now).toISOString(),
    ttlSeconds: Math.round(SNAPSHOT_TTL_MS / 1000),
    // Cache-status fields are finalized in getSnapshot() (which knows whether the
    // caller got a freshly-built or a cached/stale snapshot). Defaults here
    // describe a fresh build so buildSnapshot() alone is still self-consistent.
    servedFromCache: false,
    isStale: false,
    cacheAgeSeconds: 0,
    lastSuccessfulRefreshAt: new Date(now).toISOString(),
    summary: {
      totalUnits: unitsOut.length,
      activeLoads,
      staleGps,
      noActiveLoad,
      withGps,
      providerErrors: providerErrors.length,
    },
    debug,
    units: unitsOut,
    errors,
  };
}

/**
 * Get the cached snapshot, rebuilding at most once per SNAPSHOT_TTL_MS.
 * Concurrent callers share one in-flight build. On build failure the last good
 * snapshot is returned, flagged `stale: true`.
 */
function decorateCacheStatus(data, { cachedAtMs, servedFromCache, isStale, warning }) {
  const ageSeconds = Math.max(0, Math.round((nowMs() - cachedAtMs) / 1000));
  const decorated = {
    ...data,
    servedFromCache,
    isStale,
    stale: isStale, // kept for backward compatibility with existing consumers
    cacheAgeSeconds: ageSeconds,
    lastSuccessfulRefreshAt: data.generatedAt || null,
  };
  if (warning) decorated.warning = warning;
  return decorated;
}

async function getSnapshot({ force = false } = {}) {
  const now = nowMs();
  // Fresh cached snapshot within TTL — served from cache, single API budget.
  if (!force && snapshotCache && now - snapshotCache.at < SNAPSHOT_TTL_MS) {
    return decorateCacheStatus(snapshotCache.data, {
      cachedAtMs: snapshotCache.at,
      servedFromCache: true,
      isStale: false,
    });
  }
  // A build is already running (single-flight) — every concurrent caller shares
  // it, so two admins opening the page together trigger only one provider fetch.
  if (snapshotInFlight) return snapshotInFlight;

  snapshotInFlight = (async () => {
    try {
      const data = await buildSnapshot();
      snapshotCache = { at: nowMs(), data };
      return decorateCacheStatus(data, {
        cachedAtMs: snapshotCache.at,
        servedFromCache: false,
        isStale: false,
      });
    } catch (err) {
      // Build failed — return the last successful snapshot, flagged stale, with a
      // clear warning. Nothing is wiped; the page keeps showing the last good data.
      if (snapshotCache) {
        const withError = {
          ...snapshotCache.data,
          errors: [
            ...(snapshotCache.data.errors || []),
            { provider: 'snapshot', code: 'BUILD_FAILED', message: err.message },
          ],
        };
        return decorateCacheStatus(withError, {
          cachedAtMs: snapshotCache.at,
          servedFromCache: true,
          isStale: true,
          warning: 'Live provider refresh failed. Showing last successful snapshot.',
        });
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
  indexOrdersByUnit,
  orderSortKey,
  resolveLocationForUnit,
  buildLocationFromSamsaraVehicle,
  buildLocationFromDriveHosVehicle,
  unitNumberForRow,
  SNAPSHOT_TTL_MS,
  STALE_MINUTES,
};
