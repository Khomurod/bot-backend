/**
 * Google Maps Platform client — server-side only.
 *
 * Wraps the Routes API (computeRoutes) and, optionally, the Roads API
 * (snapToRoads). The API key never leaves the server. All calls are gated: with
 * the feature disabled or no key configured they throw a clear, typed error
 * (code GMAPS_NOT_CONFIGURED) rather than hitting Google, so the whole feature
 * is dormant until an admin enters a key in Settings → GMaps.
 *
 * A tiny min-interval rate limiter keeps us well under Google's QPS while the
 * monitor sweeps assignments. `fetchImpl` is injectable for tests.
 */
const gmaps = require('../database/gmapsSettings');

const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ROADS_ENDPOINT = 'https://roads.googleapis.com/v1/snapToRoads';

const MIN_CALL_INTERVAL_MS = 200; // ≤ 5 QPS from this process
let lastCallAt = 0;

function gmapsError(message, code = 'GMAPS_ERROR', status = 502) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

async function rateLimit() {
  const now = Date.now();
  const wait = lastCallAt + MIN_CALL_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** A route "point" for the Routes API: coordinates when known, else an address. */
function toWaypoint(point) {
  if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
    return { location: { latLng: { latitude: point.lat, longitude: point.lng } } };
  }
  return { address: String(point?.raw || point || '') };
}

/**
 * Compute a route via the Routes API. Requests ONLY the fields we need
 * (encoded polyline, distance, duration) to minimise cost.
 *
 * @param {object} p  { origin, destination, waypoints[] } — each a classified point
 * @param {object} [opts] { fetchImpl, cfg }
 * @returns {{ encodedPolyline:string, distanceMeters:number, durationSeconds:number }}
 */
async function computeRoute({ origin, destination, waypoints = [] }, { fetchImpl = fetch, cfg } = {}) {
  const config = cfg || await gmaps.getGmapsConfig();
  if (!config.enabled || !config.routesApiEnabled || !config.serverApiKey) {
    throw gmapsError(
      'Google Maps is not configured (enable it and add a server API key in Settings → GMaps).',
      'GMAPS_NOT_CONFIGURED', 409
    );
  }
  if (!origin || !destination) {
    throw gmapsError('A route needs both an origin and a destination.', 'GMAPS_BAD_INPUT', 400);
  }

  const body = {
    origin: toWaypoint(origin),
    destination: toWaypoint(destination),
    intermediates: (waypoints || []).map(toWaypoint),
    travelMode: 'DRIVE',
    polylineEncoding: 'ENCODED_POLYLINE',
  };

  await rateLimit();
  let res;
  try {
    res = await fetchImpl(ROUTES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.serverApiKey,
        'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw gmapsError(`Routes API request failed: ${err.message}`, 'GMAPS_NETWORK', 502);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch (_) { /* ignore */ }
    throw gmapsError(`Routes API returned ${res.status}. ${detail}`.trim(), 'GMAPS_HTTP', res.status);
  }

  const data = await res.json();
  const route = data?.routes?.[0];
  const encodedPolyline = route?.polyline?.encodedPolyline || '';
  if (!encodedPolyline) {
    throw gmapsError('Routes API returned no route for those points.', 'GMAPS_NO_ROUTE', 422);
  }
  const durationSeconds = route?.duration
    ? Number(String(route.duration).replace(/s$/, '')) || null
    : null;
  return {
    encodedPolyline,
    distanceMeters: Number(route?.distanceMeters) || null,
    durationSeconds,
  };
}

/**
 * Snap a short run of recent GPS points to roads (optional GPS cleanup). Returns
 * the snapped [lat,lng] points, or the input unchanged when Roads API is off.
 */
async function snapToRoads(points, { fetchImpl = fetch, cfg } = {}) {
  const config = cfg || await gmaps.getGmapsConfig();
  if (!config.enabled || !config.roadsApiEnabled || !config.serverApiKey) return points;
  if (!Array.isArray(points) || !points.length) return points;

  const path = points.map(([lat, lng]) => `${lat},${lng}`).join('|');
  const url = `${ROADS_ENDPOINT}?interpolate=false&key=${encodeURIComponent(config.serverApiKey)}&path=${encodeURIComponent(path)}`;
  await rateLimit();
  try {
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) return points;
    const data = await res.json();
    const snapped = (data?.snappedPoints || [])
      .map((p) => [p.location?.latitude, p.location?.longitude])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    return snapped.length ? snapped : points;
  } catch (_) {
    return points; // GPS cleanup is best-effort; never fail the check over it
  }
}

/** Lightweight credential test used by the Settings "Test connection" button. */
async function testConnection({ apiKey, fetchImpl = fetch } = {}) {
  const key = String(apiKey || '').trim() || (await gmaps.getGmapsConfig()).serverApiKey;
  if (!key) return { connected: false, message: 'No Google Maps API key set.' };
  const body = {
    origin: { location: { latLng: { latitude: 33.749, longitude: -84.388 } } },
    destination: { location: { latLng: { latitude: 34.0522, longitude: -118.2437 } } },
    travelMode: 'DRIVE',
    polylineEncoding: 'ENCODED_POLYLINE',
  };
  try {
    const res = await fetchImpl(ROUTES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.distanceMeters',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return { connected: true, message: 'Routes API reachable and the key works.' };
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch (_) { /* ignore */ }
    // A 403 (or a PERMISSION_DENIED / "not been used"/"disabled" detail) almost
    // always means the Routes API is simply not enabled for this key — say so
    // explicitly so the admin knows exactly what to turn on in Google Cloud.
    const looksDisabled = res.status === 403
      || /permission_denied|not been used|is disabled|not enabled|api_key_service_blocked/i.test(detail);
    if (looksDisabled) {
      return {
        connected: false,
        message: `Routes API is not enabled for this key. ${detail}`.trim(),
      };
    }
    return { connected: false, message: `Routes API returned ${res.status}. ${detail}`.trim() };
  } catch (err) {
    return { connected: false, message: err.message };
  }
}

module.exports = {
  computeRoute,
  snapToRoads,
  testConnection,
  ROUTES_ENDPOINT,
  ROADS_ENDPOINT,
};
