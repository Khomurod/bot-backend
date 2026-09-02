/**
 * Straight-line ETA for the dispatch map.
 *
 * Deliberately NOT a routing-API call: distance ÷ assumed speed with a road
 * factor is accurate enough for a map badge and costs nothing per truck. Stop
 * addresses are geocoded through a cache because the same yards recur.
 *
 * Split out of services/liveLocationsService.js.
 */
const eta = require('../etaRoutingService');
const { AVG_SPEED_MPH, ETA_TTL_MS, GEOCODE_TTL_MS } = require('./constants');
const { nowMs, etaCache, geocodeCache } = require('./caches');
const { normalizeAddressKey, toNumberOrNull, round } = require('./shaping');

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

module.exports = {
  geocodeStop,
  computeStraightLineEta,
};
