/**
 * Filling in driving MILES when the rate confirmation omits them.
 *
 * Best-effort: a routing failure leaves the field blank rather than failing the
 * parse, because miles are a nice-to-have next to the stops and the rate.
 *
 * Split out of server/services/dispatchParserService.js.
 */
const { normalizeDispatchValue } = require('./fieldNormalizers');

async function calculateDrivingMiles(origin, destination) {
  async function geocode(place) {
    const query = encodeURIComponent(place.replace(/,\s*US(?:A)?$/i, '').trim() + ', USA');
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`,
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

    return {
      lon: payload[0]?.lon,
      lat: payload[0]?.lat,
    };
  }

  try {
    const originPoint = await geocode(origin);
    const destinationPoint = await geocode(destination);
    if (!originPoint?.lon || !originPoint?.lat || !destinationPoint?.lon || !destinationPoint?.lat) {
      return '';
    }

    const routeResponse = await fetch(
      `http://router.project-osrm.org/route/v1/driving/${originPoint.lon},${originPoint.lat};${destinationPoint.lon},${destinationPoint.lat}?overview=false`
    );
    const routePayload = await routeResponse.json().catch(() => ({}));
    const distanceMeters = routePayload?.routes?.[0]?.distance;
    if (!routeResponse.ok || typeof distanceMeters !== 'number') {
      return '';
    }

    return String(Math.round(distanceMeters / 1609.34));
  } catch {
    return '';
  }
}

async function enrichWithMiles(fields) {
  if (!fields.loadedMiles && fields.pickupCity && fields.deliveryCity) {
    const miles = await calculateDrivingMiles(fields.pickupCity, fields.deliveryCity);
    if (miles) {
      fields.loadedMiles = miles;
      fields.totalMiles = miles;
    }
  }
  return fields;
}

module.exports = {
  enrichWithMiles,
};
