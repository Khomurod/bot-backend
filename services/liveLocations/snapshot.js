/**
 * Assembling the dispatch-map SNAPSHOT.
 *
 * Joins the canonical driver groups to provider GPS, active orders and an ETA,
 * behind a TTL cache with in-flight collapsing so concurrent admin tabs cost
 * one fan-out rather than one each.
 *
 * Split out of services/liveLocationsService.js, which re-exports getSnapshot
 * and buildSnapshot.
 */
const datatruck = require('../datatruckApiService');
const datatruckLoads = require('../datatruckLoadService');
const { getEldConfig } = require('../../database/eldSettings');
const { listCanonicalDriverGroups } = require('../driverGroupDirectoryService');
const { extractDriverNameFromGroupTitle } = require('../driverGroupTitle');
const { SNAPSHOT_TTL_MS, STALE_MINUTES, ETA_CONCURRENCY } = require('./constants');
const { nowMs, snapshotCache, snapshotInFlight } = require('./caches');
const {
  toNumberOrNull, round, toIso, unitNumberForRow, driverNameForGroupRow,
  telegramGroupLinkFor, mapWithConcurrency,
} = require('./shaping');
const { fetchProviderFleets, resolveLocationForUnit } = require('./providers');
const { getActiveOrders, indexOrdersByDriver, indexOrdersByUnit, computeNextStop } = require('./orders');
const { computeStraightLineEta } = require('./eta');

async function listActiveUnits() {
  const rows = await listCanonicalDriverGroups({ operational: true, includeNonDrivers: false });
  return rows.filter((r) => r
    && r.group_type === 'driver'
    && !r.inactive
    && r.operational_visible !== false
    && unitNumberForRow(r) != null);
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

module.exports = {
  listActiveUnits,
  buildSnapshot,
  decorateCacheStatus,
  getSnapshot,
};
