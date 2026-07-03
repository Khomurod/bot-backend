/**
 * Drive HoS ELD integration — powers the Factor ELD and Leader ELD live-location
 * fallbacks (both brands run on the shared Drive HoS platform, api.drivehos.app).
 *
 * Auth uses two headers on every request:
 *   - X-API-Provider-Key : shared key identifying our integration ("AlgoService")
 *   - X-API-Company-Key  : per-carrier key (one for Factor, one for Leader),
 *                          which scopes all returned data to that one carrier.
 *
 * We poll GET /v2/latest-vehicle-status, which returns the most recent GPS ping
 * per vehicle. The company key already scopes to the carrier, so there is no
 * USDOT lookup — we just match the group's unit number against each vehicle's
 * `number` field. Response `data[]` item shape:
 *   { vehicle_id, number, odometer, fuel_level, speed, lat, lon, status,
 *     timestamp }   // lat/lon are STRINGS; speed is mph; status is motion state.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_DRIVEHOS_API_BASE = 'https://api.drivehos.app';
const PAGE_LIMIT = 200; // /v2/latest-vehicle-status max limit
const MAX_PAGES = 20;

const {
  extractUnitNumberFromGroupName,
  normalizeUnitNumber,
  computePingAgeMinutes,
} = require('./samsaraLocationService');
const { extractDriverNameFromGroupTitle } = require('./driverGroupTitle');

let reverseGeocode = null;
try {
  ({ reverseGeocode } = require('./geocoder'));
} catch (_) {
  reverseGeocode = null;
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function pickCoordinates(vehicle) {
  const lat = toNumberOrNull(vehicle?.lat ?? vehicle?.latitude ?? vehicle?.coordinates?.lat);
  const lng = toNumberOrNull(vehicle?.lon ?? vehicle?.lng ?? vehicle?.longitude ?? vehicle?.coordinates?.lon);
  if (lat == null || lng == null) return null;
  return { latitude: lat, longitude: lng };
}

function pickTruckNumber(vehicle) {
  return vehicle?.number
    ?? vehicle?.truck_number
    ?? vehicle?.truckNumber
    ?? vehicle?.unit_number
    ?? vehicle?.unitNumber
    ?? vehicle?.name
    ?? null;
}

/**
 * Pull the vehicle array out of whatever envelope the API returns. Drive HoS
 * documents `{ data: [...] }`, but we stay tolerant of the shapes seen across
 * ELD APIs so a contract tweak does not blank the whole fallback:
 *   [...]  |  { data }  |  { vehicles }  |  { result(s) }  |  { items }  |
 *   nested { data: { vehicles: [...] } }.
 * Returns null only when no array can be found anywhere.
 */
function extractVehicleArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const arrayKeys = ['data', 'vehicles', 'result', 'results', 'items', 'records', 'rows'];
  for (const key of arrayKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const key of ['data', 'result', 'response', 'payload']) {
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) {
      const nested = extractVehicleArray(payload[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function findVehicleByUnit(vehicles, unitNumber) {
  const target = normalizeUnitNumber(unitNumber);
  if (!target || !Array.isArray(vehicles)) return null;

  const byFreshness = (list) => list.sort((a, b) => {
    const aTs = Date.parse(a?.timestamp || 0) || 0;
    const bTs = Date.parse(b?.timestamp || 0) || 0;
    return bTs - aTs;
  })[0];

  // Primary: the dedicated unit/number field normalizes to the target.
  const exact = vehicles.filter((vehicle) => (
    normalizeUnitNumber(pickTruckNumber(vehicle)) === target
  ));
  if (exact.length) return byFreshness(exact);

  // Fallback: a free-form label that contains the unit number as a token.
  const contains = vehicles.filter((vehicle) => {
    const tokens = String(pickTruckNumber(vehicle) || '').match(/\d+/g) || [];
    return tokens.some((token) => normalizeUnitNumber(token) === target);
  });
  return contains.length ? byFreshness(contains) : null;
}

async function resolveAddressFromCoordinates(coords) {
  if (typeof reverseGeocode !== 'function') return null;
  if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') return null;
  try {
    return await reverseGeocode(coords.latitude, coords.longitude);
  } catch (_) {
    return null;
  }
}

async function fetchLatestVehicleStatusPage({ providerKey, companyKey, apiBase, page }) {
  const cleanBase = String(apiBase || DEFAULT_DRIVEHOS_API_BASE).replace(/\/+$/, '');
  const url = `${cleanBase}/v2/latest-vehicle-status?limit=${PAGE_LIMIT}&page=${page}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-API-Provider-Key': providerKey,
        'X-API-Company-Key': companyKey,
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
      const msg = payload?.description || payload?.message || rawText.slice(0, 400) || `HTTP ${response.status}`;
      const err = new Error(`Drive HoS API ${response.status}: ${msg}`);
      err.code = 'DRIVEHOS_API_ERROR';
      err.status = response.status;
      throw err;
    }

    const data = extractVehicleArray(payload);
    if (!data) {
      // Log ONLY the top-level key names (never values) to help diagnose an
      // unexpected shape without leaking any credentials or vehicle data.
      const keySample = payload && typeof payload === 'object'
        ? Object.keys(payload).slice(0, 20).join(', ')
        : typeof payload;
      const err = new Error(
        `Drive HoS response did not contain a recognizable vehicle array (top-level keys: ${keySample || 'none'}).`
      );
      err.code = 'DRIVEHOS_INVALID_RESPONSE';
      throw err;
    }
    return { data, payload };
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Drive HoS request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      timeoutErr.code = 'DRIVEHOS_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllLatestVehicleStatuses({ providerKey, companyKey, apiBase }) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, payload } = await fetchLatestVehicleStatusPage({ providerKey, companyKey, apiBase, page });
    all.push(...data);

    const totalPages = Number(
      payload?.total_pages ?? payload?.totalPages ?? payload?.pagination?.total_pages ?? 0
    );
    if (data.length < PAGE_LIMIT) break;
    if (totalPages && page >= totalPages) break;
  }
  return all;
}

/**
 * Resolve a live location for a driver group title via one Drive HoS carrier.
 * `providerLabel` (e.g. "Factor ELD") is only used for error messages.
 */
async function getLiveLocationForGroupTitleFromDriveHos({
  groupTitle,
  providerKey,
  companyKey,
  apiBase,
  providerLabel = 'Drive HoS ELD',
}) {
  if (!providerKey) {
    const err = new Error('Drive HoS provider key is missing.');
    err.code = 'DRIVEHOS_PROVIDER_KEY_MISSING';
    throw err;
  }
  if (!companyKey) {
    const err = new Error(`${providerLabel} company key is missing.`);
    err.code = 'DRIVEHOS_COMPANY_KEY_MISSING';
    throw err;
  }

  const unitNumber = extractUnitNumberFromGroupName(groupTitle);
  if (!unitNumber) {
    const err = new Error(`Could not parse a unit number from group title: "${groupTitle}"`);
    err.code = 'UNIT_NOT_FOUND_IN_GROUP_TITLE';
    throw err;
  }

  const vehicles = await fetchAllLatestVehicleStatuses({ providerKey, companyKey, apiBase });
  const vehicle = findVehicleByUnit(vehicles, unitNumber);
  if (!vehicle) {
    const err = new Error(`No ${providerLabel} vehicle matched unit ${unitNumber}.`);
    err.code = 'DRIVEHOS_VEHICLE_NOT_FOUND';
    throw err;
  }

  const coords = pickCoordinates(vehicle);
  if (!coords) {
    const err = new Error(`${providerLabel} unit matched but has no coordinates.`);
    err.code = 'DRIVEHOS_GPS_NOT_AVAILABLE';
    throw err;
  }

  const assignedDriverName = extractDriverNameFromGroupTitle(groupTitle);
  const truckNumber = pickTruckNumber(vehicle) || unitNumber;
  return {
    unitNumber,
    vehicleId: vehicle.vehicle_id || vehicle.id || null,
    vehicleName: `Truck ${truckNumber}`,
    assignedDriverName,
    providerDriverName: '',
    driverNameMismatch: false,
    latitude: coords.latitude,
    longitude: coords.longitude,
    pingTimeIso: vehicle.timestamp || null,
    pingAgeMinutes: computePingAgeMinutes(vehicle.timestamp || null),
    speedMilesPerHour: toNumberOrNull(vehicle.speed),
    headingDegrees: toNumberOrNull(vehicle.heading ?? vehicle.bearing ?? vehicle.rotation),
    motionStatus: vehicle.status || null,
    address: await resolveAddressFromCoordinates(coords),
    rawUnit: vehicle,
  };
}

module.exports = {
  DEFAULT_DRIVEHOS_API_BASE,
  extractVehicleArray,
  fetchAllLatestVehicleStatuses,
  findVehicleByUnit,
  getLiveLocationForGroupTitleFromDriveHos,
};
