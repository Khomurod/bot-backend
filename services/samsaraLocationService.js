const {
  extractDriverNameFromGroupTitle,
  extractDriverNameFromVehicleLabel,
  driverNamesMatch,
  scoreVehicleNameMatch,
} = require('./driverGroupTitle');

const DEFAULT_SAMSARA_API_BASE = 'https://api.samsara.com';
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_LIMIT = 512;
const MAX_PAGES = 20;

let reverseGeocode = null;
try {
  ({ reverseGeocode } = require('../samsara-integration/src/geocoder'));
} catch (_) {
  reverseGeocode = null;
}

function extractUnitNumberFromGroupName(name) {
  const raw = String(name || '');
  if (!raw) return null;

  const withUnitAndHash = raw.match(/UNIT\s*#\s*(\d+)/i);
  if (withUnitAndHash) return withUnitAndHash[1];

  const withHash = raw.match(/#\s*(\d+)/);
  if (withHash) return withHash[1];

  const withUnitOnly = raw.match(/UNIT\s+(\d+)/i);
  if (withUnitOnly) return withUnitOnly[1];

  return null;
}

function extractUnitNumberFromVehicleName(name) {
  const raw = String(name || '');
  const firstNumber = raw.match(/\d+/);
  return firstNumber ? firstNumber[0] : null;
}

function normalizeUnitNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.replace(/^0+(?=\d)/, '');
}

function computePingAgeMinutes(pingTimeIso, now = new Date()) {
  if (!pingTimeIso) return null;
  const pingMs = Date.parse(pingTimeIso);
  if (Number.isNaN(pingMs)) return null;

  const diffMs = now.getTime() - pingMs;
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / 60_000);
}

function buildStatsUrl(apiBase, cursor) {
  const cleanBase = String(apiBase || DEFAULT_SAMSARA_API_BASE).replace(/\/+$/, '');
  const params = new URLSearchParams({
    types: 'gps',
    limit: String(PAGE_LIMIT),
  });
  if (cursor) params.set('after', cursor);
  return `${cleanBase}/fleet/vehicles/stats?${params.toString()}`;
}

async function fetchVehicleStatsPage({ apiKey, apiBase, cursor }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(buildStatsUrl(apiBase, cursor), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch (_) {
      payload = null;
    }

    if (!response.ok) {
      const msg = payload?.message || rawText.slice(0, 400) || `HTTP ${response.status}`;
      const err = new Error(`Samsara API ${response.status}: ${msg}`);
      err.code = 'SAMSARA_API_ERROR';
      throw err;
    }

    if (!payload || !Array.isArray(payload.data)) {
      const err = new Error('Samsara vehicle stats response did not include a data array.');
      err.code = 'SAMSARA_INVALID_RESPONSE';
      throw err;
    }

    return payload;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Samsara API request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      timeoutErr.code = 'SAMSARA_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllVehicleStats({ apiKey, apiBase = DEFAULT_SAMSARA_API_BASE }) {
  const allVehicles = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await fetchVehicleStatsPage({ apiKey, apiBase, cursor });
    allVehicles.push(...payload.data);

    const hasNext = Boolean(payload.pagination?.hasNextPage);
    const nextCursor = payload.pagination?.endCursor || null;
    if (!hasNext || !nextCursor) break;

    cursor = nextCursor;
  }

  return allVehicles;
}

function sortVehiclesByGpsFreshness(vehicles) {
  return [...vehicles].sort((a, b) => {
    const aTime = Date.parse(a?.gps?.time || 0) || 0;
    const bTime = Date.parse(b?.gps?.time || 0) || 0;
    return bTime - aTime;
  });
}

function findVehicleByUnit(vehicles, unitNumber, opts = {}) {
  const target = normalizeUnitNumber(unitNumber);
  if (!target || !Array.isArray(vehicles) || vehicles.length === 0) return null;

  const driverNameHint = String(opts.driverNameHint || '').trim();

  const matches = vehicles.filter((vehicle) => {
    const vehicleUnit = extractUnitNumberFromVehicleName(vehicle?.name);
    return normalizeUnitNumber(vehicleUnit) === target;
  });

  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];

  if (!driverNameHint) {
    return sortVehiclesByGpsFreshness(matches)[0];
  }

  const scored = matches.map((vehicle) => ({
    vehicle,
    nameScore: scoreVehicleNameMatch(driverNameHint, vehicle?.name || ''),
    gpsTime: Date.parse(vehicle?.gps?.time || 0) || 0,
  }));

  scored.sort((a, b) => {
    if (b.nameScore !== a.nameScore) return b.nameScore - a.nameScore;
    return b.gpsTime - a.gpsTime;
  });

  return scored[0].vehicle;
}

function enrichLocationWithDriverAssignment(locationFields, groupTitle) {
  const assignedDriverName = extractDriverNameFromGroupTitle(groupTitle);
  const providerDriverName = extractDriverNameFromVehicleLabel(
    locationFields.vehicleName,
    locationFields.unitNumber
  );
  const driverNameMismatch = Boolean(
    assignedDriverName
    && providerDriverName
    && !driverNamesMatch(assignedDriverName, providerDriverName)
  );
  return {
    ...locationFields,
    assignedDriverName,
    providerDriverName,
    driverNameMismatch,
  };
}

async function resolveAddress(gps) {
  const provided = gps?.reverseGeo?.formattedLocation;
  if (provided) return provided;

  if (typeof reverseGeocode !== 'function') return null;
  if (gps?.latitude == null || gps?.longitude == null) return null;

  try {
    return await reverseGeocode(gps.latitude, gps.longitude);
  } catch (_) {
    return null;
  }
}

async function getLiveLocationForGroupTitle({ groupTitle, apiKey, apiBase }) {
  if (!apiKey) {
    const err = new Error('SAMSARA_API_KEY is not configured.');
    err.code = 'SAMSARA_API_KEY_MISSING';
    throw err;
  }

  const unitNumber = extractUnitNumberFromGroupName(groupTitle);
  if (!unitNumber) {
    const err = new Error(`Could not parse a unit number from group title: "${groupTitle}"`);
    err.code = 'UNIT_NOT_FOUND_IN_GROUP_TITLE';
    throw err;
  }

  const driverNameHint = extractDriverNameFromGroupTitle(groupTitle);
  const vehicles = await fetchAllVehicleStats({ apiKey, apiBase });
  const vehicle = findVehicleByUnit(vehicles, unitNumber, { driverNameHint });
  if (!vehicle) {
    const err = new Error(`No Samsara vehicle matched unit ${unitNumber}.`);
    err.code = 'VEHICLE_NOT_FOUND';
    throw err;
  }

  const gps = vehicle.gps || {};
  if (typeof gps.latitude !== 'number' || typeof gps.longitude !== 'number') {
    const err = new Error(`Vehicle ${vehicle.name || vehicle.id} has no GPS coordinates in stats payload.`);
    err.code = 'GPS_NOT_AVAILABLE';
    throw err;
  }

  const base = {
    unitNumber,
    vehicleId: vehicle.id || null,
    vehicleName: vehicle.name || 'Unknown vehicle',
    latitude: gps.latitude,
    longitude: gps.longitude,
    pingTimeIso: gps.time || null,
    pingAgeMinutes: computePingAgeMinutes(gps.time || null),
    speedMilesPerHour: typeof gps.speedMilesPerHour === 'number' ? gps.speedMilesPerHour : null,
    headingDegrees: typeof gps.headingDegrees === 'number' ? gps.headingDegrees : null,
    address: await resolveAddress(gps),
    rawVehicle: vehicle,
  };
  return enrichLocationWithDriverAssignment(base, groupTitle);
}

module.exports = {
  extractUnitNumberFromGroupName,
  extractUnitNumberFromVehicleName,
  normalizeUnitNumber,
  computePingAgeMinutes,
  findVehicleByUnit,
  fetchAllVehicleStats,
  getLiveLocationForGroupTitle,
};
