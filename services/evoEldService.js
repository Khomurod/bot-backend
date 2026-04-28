const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_EVO_ELD_API_BASE = 'https://read.evoeld.com/api/v2';

const {
  extractUnitNumberFromGroupName,
  normalizeUnitNumber,
  computePingAgeMinutes,
} = require('./samsaraLocationService');

function pickCoordinates(unit) {
  const lat = unit?.coordinates?.lat ?? unit?.coordinates?.latitude ?? unit?.lat ?? unit?.latitude ?? null;
  const lng = unit?.coordinates?.lng ?? unit?.coordinates?.lon ?? unit?.coordinates?.longitude ?? unit?.lng ?? unit?.lon ?? unit?.longitude ?? null;

  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return { latitude: lat, longitude: lng };
}

function pickTruckNumber(unit) {
  return unit?.truck_number
    ?? unit?.truckNumber
    ?? unit?.unit_number
    ?? unit?.unitNumber
    ?? unit?.name
    ?? null;
}

function findUnitByTruckNumber(units, unitNumber) {
  const target = normalizeUnitNumber(unitNumber);
  if (!target || !Array.isArray(units)) return null;

  const matches = units.filter((unit) => {
    const truckNumber = pickTruckNumber(unit);
    return normalizeUnitNumber(truckNumber) === target;
  });
  if (!matches.length) return null;

  return matches.sort((a, b) => {
    const aTs = Date.parse(a?.timestamp || 0) || 0;
    const bTs = Date.parse(b?.timestamp || 0) || 0;
    return bTs - aTs;
  })[0];
}

async function fetchUnitsByUsdot({
  usdotNumber,
  apiKey,
  providerToken,
  apiBase = DEFAULT_EVO_ELD_API_BASE,
}) {
  const cleanBase = String(apiBase || DEFAULT_EVO_ELD_API_BASE).replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${cleanBase}/units-by-usdot/${encodeURIComponent(String(usdotNumber || '').trim())}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-api-key': apiKey,
          'provider-token': providerToken,
        },
        signal: controller.signal,
      }
    );

    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch (_) {
      payload = null;
    }

    if (!response.ok) {
      const msg = payload?.message || rawText.slice(0, 400) || `HTTP ${response.status}`;
      const err = new Error(`EVO ELD API ${response.status}: ${msg}`);
      err.code = 'EVO_API_ERROR';
      throw err;
    }

    const units = Array.isArray(payload?.units)
      ? payload.units
      : (Array.isArray(payload) ? payload : null);
    if (!units) {
      const err = new Error('EVO ELD response did not include a units array.');
      err.code = 'EVO_INVALID_RESPONSE';
      throw err;
    }

    return units;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`EVO ELD request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      timeoutErr.code = 'EVO_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function getLiveLocationForGroupTitleFromEvo({
  groupTitle,
  usdotNumber,
  apiKey,
  providerToken,
  apiBase,
}) {
  if (!apiKey) {
    const err = new Error('EVO ELD API key is missing.');
    err.code = 'EVO_API_KEY_MISSING';
    throw err;
  }
  if (!providerToken) {
    const err = new Error('EVO ELD provider token is missing.');
    err.code = 'EVO_PROVIDER_TOKEN_MISSING';
    throw err;
  }
  if (!usdotNumber) {
    const err = new Error('EVO ELD USDOT number is missing.');
    err.code = 'EVO_USDOT_MISSING';
    throw err;
  }

  const unitNumber = extractUnitNumberFromGroupName(groupTitle);
  if (!unitNumber) {
    const err = new Error(`Could not parse a unit number from group title: "${groupTitle}"`);
    err.code = 'UNIT_NOT_FOUND_IN_GROUP_TITLE';
    throw err;
  }

  const units = await fetchUnitsByUsdot({
    usdotNumber,
    apiKey,
    providerToken,
    apiBase,
  });

  const unit = findUnitByTruckNumber(units, unitNumber);
  if (!unit) {
    const err = new Error(`No EVO ELD unit matched truck number ${unitNumber}.`);
    err.code = 'EVO_VEHICLE_NOT_FOUND';
    throw err;
  }

  const coords = pickCoordinates(unit);
  if (!coords) {
    const err = new Error('EVO ELD unit matched but has no coordinates.');
    err.code = 'EVO_GPS_NOT_AVAILABLE';
    throw err;
  }

  return {
    unitNumber,
    vehicleId: unit.id || null,
    vehicleName: `Truck ${pickTruckNumber(unit) || unitNumber}`,
    latitude: coords.latitude,
    longitude: coords.longitude,
    pingTimeIso: unit.timestamp || null,
    pingAgeMinutes: computePingAgeMinutes(unit.timestamp || null),
    speedMilesPerHour: null,
    headingDegrees: typeof unit.rotation === 'number' ? unit.rotation : null,
    address: null,
    rawUnit: unit,
  };
}

module.exports = {
  fetchUnitsByUsdot,
  findUnitByTruckNumber,
  getLiveLocationForGroupTitleFromEvo,
};
