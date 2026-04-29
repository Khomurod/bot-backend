const { DateTime } = require('luxon');

function sanitizeDestinationQuery(place) {
  const base = String(place || '')
    .replace(/,\s*US(?:A)?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  return `${base}, USA`;
}

async function geocodePlace(place) {
  const query = sanitizeDestinationQuery(place);
  if (!query) return null;

  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
    {
      headers: {
        'User-Agent': 'DispatchBot/1.0',
      },
    }
  );
  const payload = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  const first = payload[0];
  const lat = Number.parseFloat(first?.lat);
  const lon = Number.parseFloat(first?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return {
    latitude: lat,
    longitude: lon,
    displayName: String(first?.display_name || '').trim(),
  };
}

async function calculateEtaToDestination({ currentLatitude, currentLongitude, destinationQuery }) {
  if (!Number.isFinite(currentLatitude) || !Number.isFinite(currentLongitude)) {
    return null;
  }

  const destination = await geocodePlace(destinationQuery);
  if (!destination) return null;

  const response = await fetch(
    `http://router.project-osrm.org/route/v1/driving/${currentLongitude},${currentLatitude};${destination.longitude},${destination.latitude}?overview=false`
  );
  const payload = await response.json().catch(() => ({}));
  const route = payload?.routes?.[0];
  const distanceMeters = route?.distance;
  const durationSeconds = route?.duration;
  if (!response.ok || typeof distanceMeters !== 'number' || typeof durationSeconds !== 'number') {
    return null;
  }

  const remainingMiles = Math.max(0, Math.round(distanceMeters / 1609.34));
  const etaMinutes = Math.max(0, Math.round(durationSeconds / 60));
  const etaChicago = DateTime.now().setZone('America/Chicago').plus({ minutes: etaMinutes });

  return {
    destination,
    remainingMiles,
    etaMinutes,
    etaChicagoIso: etaChicago.toISO(),
    etaChicagoLabel: etaChicago.toFormat('MM/dd/yyyy HH:mm'),
  };
}

module.exports = {
  calculateEtaToDestination,
  geocodePlace,
  sanitizeDestinationQuery,
};

