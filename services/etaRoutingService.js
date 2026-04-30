const { DateTime } = require('luxon');
const config = require('../config/config');

const GEO_USER_AGENT = 'DispatchBot/1.0';
const APPROX_HIGHWAY_MPH = 52;
const ALT_OSRM_ROUTE_BASE = 'https://routing.openstreetmap.de/routed-car/route/v1/driving';

function sanitizeDestinationQuery(place) {
  const base = String(place || '')
    .replace(/\b(?:appt|appointment)\b[^,\n|;]*/gi, '')
    .replace(/\b(?:pu|pickup|del|delivery)\s*(?:time|dt)?\s*[:\-][^,\n|;]*/gi, '')
    .replace(/\b(?:status|rolling|stopped|miles?\s+left)\b[^,\n|;]*/gi, '')
    .replace(/\broute\s*:\s*https?:\/\/\S+/gi, '')
    .replace(/\|\s*[^|]*$/g, '')
    .replace(/,\s*US(?:A)?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  return `${base}, USA`;
}

function deDupeNonEmpty(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function extractDestinationCandidates(place) {
  const raw = String(place || '').trim();
  if (!raw) return [];

  const segments = raw
    .split(/\n+/)
    .map((line) => line.replace(/\broute\s*:\s*https?:\/\/\S+/gi, '').trim())
    .filter(Boolean);

  const compact = segments.join(' ');
  const primary = sanitizeDestinationQuery(compact);
  const labeledDestination = compact.match(
    /\b(?:destination|delivery|deliver to|ship to|drop(?:off)?)\s*[:\-]\s*([^|;]+)/i
  )?.[1];
  const cityStateZip = compact.match(
    /\b([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)\b/
  )?.[1];
  const laneHint = compact.match(/\b([A-Z]{2})\s*[-/>]+\s*([A-Z]{2})\b/i);
  const laneDestination = laneHint?.[2] ? sanitizeDestinationQuery(laneHint[2]) : '';

  return deDupeNonEmpty([
    sanitizeDestinationQuery(labeledDestination || ''),
    primary,
    sanitizeDestinationQuery(cityStateZip || ''),
    laneDestination,
  ]);
}

function scoreGeocodeResult(item) {
  const display = String(item?.display_name || '').toLowerCase();
  const address = item?.address || {};
  let score = Number(item?.importance || 0);
  if (address.house_number) score += 2;
  if (address.road) score += 1.5;
  if (address.postcode) score += 1;
  if (address.city || address.town || address.village) score += 0.8;
  if (display.includes('united states')) score += 0.5;
  return score;
}

async function geocodeWithNominatim(query) {
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=5`,
    {
      headers: {
        'User-Agent': GEO_USER_AGENT,
      },
    }
  );
  const payload = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  const ranked = payload
    .map((item) => {
      const lat = Number.parseFloat(item?.lat);
      const lon = Number.parseFloat(item?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return {
        latitude: lat,
        longitude: lon,
        displayName: String(item?.display_name || '').trim(),
        score: scoreGeocodeResult(item),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return ranked[0] || null;
}

async function geocodeWithGoogle(query) {
  if (!config.googleMapsApiKey) return null;

  const url = `${config.googleGeocodingApiBase}?address=${encodeURIComponent(query)}&key=${encodeURIComponent(config.googleMapsApiKey)}&region=us`;
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (!response.ok || !results.length || payload?.status === 'REQUEST_DENIED') return null;

  const first = results[0];
  const loc = first?.geometry?.location || {};
  const lat = Number(loc.lat);
  const lon = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    latitude: lat,
    longitude: lon,
    displayName: String(first?.formatted_address || '').trim(),
    score: 100,
  };
}

async function geocodeWithPhoton(query) {
  const response = await fetch(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5`,
    {
      headers: {
        'User-Agent': GEO_USER_AGENT,
      },
    }
  );
  const payload = await response.json().catch(() => ({}));
  const features = Array.isArray(payload?.features) ? payload.features : [];
  if (!response.ok || !features.length) return null;

  const first = features.find((f) => Array.isArray(f?.geometry?.coordinates));
  const coords = first?.geometry?.coordinates || [];
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const props = first?.properties || {};
  const display = [
    props?.name,
    props?.street,
    props?.city || props?.county || props?.state,
    props?.postcode,
    props?.country,
  ]
    .filter(Boolean)
    .join(', ')
    .trim();

  return {
    latitude: lat,
    longitude: lon,
    displayName: display || query,
    score: 50,
  };
}

async function geocodePlace(place) {
  const candidates = extractDestinationCandidates(place);
  for (const query of candidates) {
    try {
      let geocoded = await geocodeWithNominatim(query);
      if (!geocoded) {
        geocoded = await geocodeWithPhoton(query);
      }
      if (!geocoded) {
        geocoded = await geocodeWithGoogle(query);
      }
      if (!geocoded) continue;
      return {
        ...geocoded,
        queryUsed: query,
      };
    } catch {
      // Try next candidate when one geocode attempt fails.
    }
  }
  return null;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const radiusMiles = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return radiusMiles * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function buildEtaOutput({ destination, remainingMiles, etaMinutes, approximate }) {
  const etaChicago = DateTime.now().setZone('America/Chicago').plus({ minutes: etaMinutes });
  return {
    destination,
    remainingMiles: Math.max(0, Math.round(remainingMiles)),
    etaMinutes: Math.max(0, Math.round(etaMinutes)),
    etaChicagoIso: etaChicago.toISO(),
    etaChicagoLabel: etaChicago.toFormat('MM/dd/yyyy HH:mm'),
    approximate: Boolean(approximate),
  };
}

async function routeWithOsrm({
  currentLatitude,
  currentLongitude,
  destinationLatitude,
  destinationLongitude,
}) {
  const response = await fetch(
    `http://router.project-osrm.org/route/v1/driving/${currentLongitude},${currentLatitude};${destinationLongitude},${destinationLatitude}?overview=false`
  );
  const payload = await response.json().catch(() => ({}));
  const route = payload?.routes?.[0];
  const distanceMeters = route?.distance;
  const durationSeconds = route?.duration;
  if (!response.ok || typeof distanceMeters !== 'number' || typeof durationSeconds !== 'number') {
    return null;
  }
  return {
    remainingMiles: Math.max(0, distanceMeters / 1609.34),
    etaMinutes: Math.max(0, durationSeconds / 60),
  };
}

async function routeWithAltOsrm({
  currentLatitude,
  currentLongitude,
  destinationLatitude,
  destinationLongitude,
}) {
  const response = await fetch(
    `${ALT_OSRM_ROUTE_BASE}/${currentLongitude},${currentLatitude};${destinationLongitude},${destinationLatitude}?overview=false`
  );
  const payload = await response.json().catch(() => ({}));
  const route = payload?.routes?.[0];
  const distanceMeters = route?.distance;
  const durationSeconds = route?.duration;
  if (!response.ok || typeof distanceMeters !== 'number' || typeof durationSeconds !== 'number') {
    return null;
  }
  return {
    remainingMiles: Math.max(0, distanceMeters / 1609.34),
    etaMinutes: Math.max(0, durationSeconds / 60),
  };
}

async function routeWithGoogle({
  currentLatitude,
  currentLongitude,
  destinationLatitude,
  destinationLongitude,
}) {
  if (!config.googleMapsApiKey) return null;
  const response = await fetch(config.googleRoutesApiBase, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.googleMapsApiKey,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
    },
    body: JSON.stringify({
      origin: {
        location: {
          latLng: {
            latitude: currentLatitude,
            longitude: currentLongitude,
          },
        },
      },
      destination: {
        location: {
          latLng: {
            latitude: destinationLatitude,
            longitude: destinationLongitude,
          },
        },
      },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      units: 'IMPERIAL',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  const route = payload?.routes?.[0];
  const distanceMeters = Number(route?.distanceMeters);
  const durationText = String(route?.duration || '').trim();
  const durationSeconds = Number(durationText.replace(/s$/i, ''));
  if (!response.ok || !Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
    return null;
  }
  return {
    remainingMiles: Math.max(0, distanceMeters / 1609.34),
    etaMinutes: Math.max(0, durationSeconds / 60),
  };
}

async function calculateEtaToDestination({ currentLatitude, currentLongitude, destinationQuery }) {
  if (!Number.isFinite(currentLatitude) || !Number.isFinite(currentLongitude)) {
    return null;
  }

  const destination = await geocodePlace(destinationQuery);
  if (!destination) return null;

  const osrmRoute = await routeWithOsrm({
    currentLatitude,
    currentLongitude,
    destinationLatitude: destination.latitude,
    destinationLongitude: destination.longitude,
  }).catch(() => null);

  if (osrmRoute) {
    return buildEtaOutput({
      destination,
      remainingMiles: osrmRoute.remainingMiles,
      etaMinutes: osrmRoute.etaMinutes,
      approximate: false,
    });
  }

  const altOsrmRoute = await routeWithAltOsrm({
    currentLatitude,
    currentLongitude,
    destinationLatitude: destination.latitude,
    destinationLongitude: destination.longitude,
  }).catch(() => null);
  if (altOsrmRoute) {
    return buildEtaOutput({
      destination,
      remainingMiles: altOsrmRoute.remainingMiles,
      etaMinutes: altOsrmRoute.etaMinutes,
      approximate: false,
    });
  }

  const googleRoute = await routeWithGoogle({
    currentLatitude,
    currentLongitude,
    destinationLatitude: destination.latitude,
    destinationLongitude: destination.longitude,
  }).catch(() => null);
  if (googleRoute) {
    return buildEtaOutput({
      destination,
      remainingMiles: googleRoute.remainingMiles,
      etaMinutes: googleRoute.etaMinutes,
      approximate: false,
    });
  }

  const crowMiles = haversineMiles(
    currentLatitude,
    currentLongitude,
    destination.latitude,
    destination.longitude
  );
  if (!Number.isFinite(crowMiles) || crowMiles <= 0) return null;
  const adjustedRoadMiles = Math.max(1, crowMiles * 1.22);
  const etaMinutes = (adjustedRoadMiles / APPROX_HIGHWAY_MPH) * 60;
  return buildEtaOutput({
    destination,
    remainingMiles: adjustedRoadMiles,
    etaMinutes,
    approximate: true,
  });
}

module.exports = {
  calculateEtaToDestination,
  extractDestinationCandidates,
  geocodePlace,
  haversineMiles,
  sanitizeDestinationQuery,
};

