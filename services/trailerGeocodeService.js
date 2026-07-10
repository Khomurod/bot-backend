/**
 * Trailer location geocoding — cached + fail-soft.
 *
 * Turns a free-text trailer location ("Lancaster, PA", "PA", "Home Depot MDO/DFC
 * #5829") into map coordinates with a provenance label, WITHOUT ever throwing or
 * blocking event registration. It layers three strategies:
 *
 *   1. Full geocode via the shared etaRoutingService.geocodePlace cascade
 *      (Nominatim → Photon → Google). Google handles facility names / Places.
 *   2. State-only input → a hardcoded state centroid, marked `approximate_state`.
 *   3. Anything unmappable → `text_only` (lat/lng null) — still shown in the
 *      side list, never on the map.
 *
 * Results are cached by NORMALIZED location text (including negative results) so
 * the same unchanged location is never geocoded twice — important because the
 * monitor runs on every driver-group message and the map refreshes on a timer.
 *
 * location_source values: exact | geocoded | approximate_state | text_only |
 * derived_from_driver | manual.
 */

// US state + territory centroids (approximate geographic centers). Used only as
// a last-resort "somewhere in this state" marker when nothing better is known.
const STATE_CENTROIDS = {
  AL: [32.806671, -86.79113], AK: [61.370716, -152.404419], AZ: [33.729759, -111.431221],
  AR: [34.969704, -92.373123], CA: [36.116203, -119.681564], CO: [39.059811, -105.311104],
  CT: [41.597782, -72.755371], DE: [39.318523, -75.507141], FL: [27.766279, -81.686783],
  GA: [33.040619, -83.643074], HI: [21.094318, -157.498337], ID: [44.240459, -114.478828],
  IL: [40.349457, -88.986137], IN: [39.849426, -86.258278], IA: [42.011539, -93.210526],
  KS: [38.5266, -96.726486], KY: [37.66814, -84.670067], LA: [31.169546, -91.867805],
  ME: [44.693947, -69.381927], MD: [39.063946, -76.802101], MA: [42.230171, -71.530106],
  MI: [43.326618, -84.536095], MN: [45.694454, -93.900192], MS: [32.741646, -89.678696],
  MO: [38.456085, -92.288368], MT: [46.921925, -110.454353], NE: [41.12537, -98.268082],
  NV: [38.313515, -117.055374], NH: [43.452492, -71.563896], NJ: [40.298904, -74.521011],
  NM: [34.840515, -106.248482], NY: [42.165726, -74.948051], NC: [35.630066, -79.806419],
  ND: [47.528912, -99.784012], OH: [40.388783, -82.764915], OK: [35.565342, -96.928917],
  OR: [44.572021, -122.070938], PA: [40.590752, -77.209755], RI: [41.680893, -71.51178],
  SC: [33.856892, -80.945007], SD: [44.299782, -99.438828], TN: [35.747845, -86.692345],
  TX: [31.054487, -97.563461], UT: [40.150032, -111.862434], VT: [44.045876, -72.710686],
  VA: [37.769337, -78.169968], WA: [47.400902, -121.490494], WV: [38.491226, -80.954453],
  WI: [44.268543, -89.616508], WY: [42.755966, -107.30249], DC: [38.897438, -77.026817],
};

const STATE_NAME_TO_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC',
};

const MAX_CACHE_ENTRIES = 1000;
const cache = new Map(); // normalizedText -> { lat, lng, source, confidence }

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * If the WHOLE string is just a US state (abbr or name), return its abbreviation,
 * else null. "PA" / "Pennsylvania" → "PA"; "Lancaster PA" → null (has a city).
 */
function stateOnly(text) {
  const t = normalizeText(text);
  if (!t) return null;
  const upper = t.toUpperCase();
  if (STATE_CENTROIDS[upper]) return upper;
  if (STATE_NAME_TO_ABBR[t]) return STATE_NAME_TO_ABBR[t];
  return null;
}

/** Extract a trailing/embedded US state (for approximate fallback), or null. */
function extractState(text) {
  const t = normalizeText(text);
  if (!t) return null;
  // Trailing 2-letter code, e.g. "lancaster pa".
  const m = t.match(/\b([a-z]{2})\b\s*$/);
  if (m && STATE_CENTROIDS[m[1].toUpperCase()]) return m[1].toUpperCase();
  // Any full state name present.
  for (const [name, abbr] of Object.entries(STATE_NAME_TO_ABBR)) {
    if (t.includes(name)) return abbr;
  }
  return null;
}

function remember(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Evict oldest insertion to bound memory (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/**
 * Geocode a trailer location string. Never throws.
 *
 * @returns {{lat:number|null, lng:number|null, source:string, confidence:number,
 *            error?:string}}
 */
async function geocodeTrailerLocation(locationText, { enabled = true } = {}) {
  const text = String(locationText || '').trim();
  if (!text) return { lat: null, lng: null, source: 'text_only', confidence: 0 };

  const key = normalizeText(text);
  if (cache.has(key)) return cache.get(key);

  if (!enabled) {
    // Do NOT cache when disabled — a later enable should still try.
    return { lat: null, lng: null, source: 'text_only', confidence: 0 };
  }

  // 1. State-only → centroid (approximate). Cheap, no network.
  const solo = stateOnly(text);
  if (solo) {
    const [lat, lng] = STATE_CENTROIDS[solo];
    return remember(key, { lat, lng, source: 'approximate_state', confidence: 25 });
  }

  // 2. Full geocode cascade (city/state, facility name, address, …).
  try {
    const { geocodePlace } = require('./etaRoutingService');
    const geo = await geocodePlace(text);
    if (geo && Number.isFinite(Number(geo.lat)) && Number.isFinite(Number(geo.lng))) {
      return remember(key, {
        lat: Number(geo.lat), lng: Number(geo.lng), source: 'geocoded', confidence: 75,
      });
    }
  } catch (err) {
    // 3a. Network/parse failure → fall through to state fallback, remembering
    //     the error but never throwing.
    const st = extractState(text);
    if (st) {
      const [lat, lng] = STATE_CENTROIDS[st];
      return remember(key, { lat, lng, source: 'approximate_state', confidence: 20, error: err.message });
    }
    return remember(key, { lat: null, lng: null, source: 'text_only', confidence: 0, error: err.message });
  }

  // 3b. Geocoder returned nothing usable → approximate to state if we can.
  const st = extractState(text);
  if (st) {
    const [lat, lng] = STATE_CENTROIDS[st];
    return remember(key, { lat, lng, source: 'approximate_state', confidence: 20 });
  }
  return remember(key, { lat: null, lng: null, source: 'text_only', confidence: 0 });
}

/** Clear the geocode cache (tests / admin maintenance). */
function clearGeocodeCache() {
  cache.clear();
}

module.exports = {
  geocodeTrailerLocation,
  clearGeocodeCache,
  // exported for tests
  stateOnly,
  extractState,
  STATE_CENTROIDS,
  _cache: cache,
};
