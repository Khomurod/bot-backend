const {
  extractDriverNameFromGroupTitle,
  extractDriverNameFromVehicleLabel,
  driverNamesMatch,
  scoreVehicleNameMatch,
} = require('../lib/drivers/driverGroupTitle');

const DEFAULT_SAMSARA_API_BASE = 'https://api.samsara.com';
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_LIMIT = 512;
const MAX_PAGES = 20;

let reverseGeocode = null;
try {
  ({ reverseGeocode } = require('./geocoder'));
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

/**
 * Practical unit ↔ vehicle matching. A Samsara vehicle label is free-form
 * ("2908 NIKE AUGUSTE", "UNIT # 305", "2021 Freightliner 305 - John"), so we do
 * NOT rely on the unit being the first number. We accept a match when:
 *   - any standalone numeric token in the name normalizes to the target, or
 *   - the digits-only form of the name contains the padded/unpadded unit as a
 *     token (covers "#305", "305A" style labels).
 */
function vehicleNameMatchesUnit(name, normalizedTarget) {
  if (!normalizedTarget) return false;
  const raw = String(name || '');
  if (!raw) return false;
  const tokens = raw.match(/\d+/g) || [];
  return tokens.some((token) => normalizeUnitNumber(token) === normalizedTarget);
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

// A group-driver name must beat the runner-up by at least a strong partial match
// (shared last+first token, substring, or exact) to disambiguate a shared unit.
const CONFIDENT_NAME_SCORE = 50;

function unitMatches(vehicle, target) {
  return (
    vehicleNameMatchesUnit(vehicle?.name, target)
    // Some fleets carry the unit in dedicated fields rather than the label.
    || normalizeUnitNumber(vehicle?.externalIds?.['samsara.serial']) === target
    || normalizeUnitNumber(vehicle?.licensePlate) === target
  );
}

/**
 * Select the Samsara vehicle for a unit number, disambiguating DUPLICATE unit
 * numbers by driver name — the driver group's name is the source of truth, never
 * "freshest GPS" alone.
 *
 * Returns a rich result so callers can refuse to send a wrong location:
 *   { vehicle, ambiguous, reason, candidates, matchedScore }
 *
 * Cases when several vehicles carry the same unit number:
 *   - they are all the SAME driver (e.g. a stale + a fresh entry) → pick freshest
 *     (not ambiguous); this is the ordinary duplicate-ping case.
 *   - they are DIFFERENT drivers → require the group's driver name to pick a clear
 *     winner; if there is no group driver name, or no candidate clearly matches it,
 *     the result is AMBIGUOUS and `vehicle` is null (do not guess).
 */
function selectVehicleByUnit(vehicles, unitNumber, opts = {}) {
  const target = normalizeUnitNumber(unitNumber);
  const driverNameHint = String(opts.driverNameHint || '').trim();
  const empty = {
    vehicle: null, ambiguous: false, reason: 'no_match', candidates: [], matchedScore: null,
  };
  if (!target || !Array.isArray(vehicles) || vehicles.length === 0) return empty;

  const matches = vehicles.filter((vehicle) => unitMatches(vehicle, target));
  if (!matches.length) return empty;
  if (matches.length === 1) {
    return {
      vehicle: matches[0], ambiguous: false, reason: 'unique_unit', candidates: matches, matchedScore: null,
    };
  }

  // Several vehicles share this unit number. Are they the same driver?
  const names = matches.map((v) => extractDriverNameFromVehicleLabel(v?.name, target));
  const firstNamed = names.find(Boolean) || '';
  const allSameDriver = names.every((n) => !n || !firstNamed || driverNamesMatch(firstNamed, n));
  if (allSameDriver) {
    // Same driver appearing more than once (stale + fresh) → freshest is correct.
    return {
      vehicle: sortVehiclesByGpsFreshness(matches)[0],
      ambiguous: false,
      reason: 'same_driver_duplicate',
      candidates: matches,
      matchedScore: null,
    };
  }

  // Genuinely different drivers on the same unit number — disambiguate by the
  // group's assigned driver name; never silently by GPS freshness.
  if (!driverNameHint) {
    return {
      vehicle: null, ambiguous: true, reason: 'duplicate_unit_no_group_driver', candidates: matches, matchedScore: null,
    };
  }
  const scored = matches
    .map((vehicle) => ({
      vehicle,
      score: scoreVehicleNameMatch(driverNameHint, vehicle?.name || ''),
      gpsTime: Date.parse(vehicle?.gps?.time || 0) || 0,
    }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.gpsTime - a.gpsTime));

  const [top, second] = scored;
  if (top.score >= CONFIDENT_NAME_SCORE && (!second || top.score > second.score)) {
    return {
      vehicle: top.vehicle, ambiguous: false, reason: 'group_driver_match', candidates: matches, matchedScore: top.score,
    };
  }
  return {
    vehicle: null,
    ambiguous: true,
    reason: top.score > 0 ? 'duplicate_unit_weak_match' : 'duplicate_unit_no_name_match',
    candidates: matches,
    matchedScore: top.score,
  };
}

/** Back-compat thin wrapper: the selected vehicle or null (null when ambiguous). */
function findVehicleByUnit(vehicles, unitNumber, opts = {}) {
  return selectVehicleByUnit(vehicles, unitNumber, opts).vehicle;
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

async function getLiveLocationForGroupTitle({ groupTitle, apiKey, apiBase, unitNumber: unitNumberOverride = null }) {
  if (!apiKey) {
    const err = new Error('SAMSARA_API_KEY is not configured.');
    err.code = 'SAMSARA_API_KEY_MISSING';
    throw err;
  }

  // A stored unit number (route assignment / driver profile) takes priority;
  // parsing the group title remains the compatibility fallback.
  const unitNumber = (unitNumberOverride != null && String(unitNumberOverride).trim())
    ? String(unitNumberOverride).trim()
    : extractUnitNumberFromGroupName(groupTitle);
  if (!unitNumber) {
    const err = new Error(`Could not parse a unit number from group title: "${groupTitle}"`);
    err.code = 'UNIT_NOT_FOUND_IN_GROUP_TITLE';
    throw err;
  }

  const driverNameHint = extractDriverNameFromGroupTitle(groupTitle);
  const vehicles = await fetchAllVehicleStats({ apiKey, apiBase });
  const selection = selectVehicleByUnit(vehicles, unitNumber, { driverNameHint });
  const vehicle = selection.vehicle;
  if (!vehicle) {
    if (selection.ambiguous) {
      const candidateNames = selection.candidates.map((v) => v?.name).filter(Boolean);
      const err = new Error(
        `Ambiguous match for unit ${unitNumber}: ${selection.candidates.length} Samsara vehicles share this `
        + `unit number${driverNameHint
          ? ` and none clearly matches the group driver "${driverNameHint}"`
          : ' and the group title has no driver name to disambiguate'}`
        + `${candidateNames.length ? ` (candidates: ${candidateNames.join(' | ')})` : ''}.`
      );
      err.code = 'AMBIGUOUS_UNIT_MATCH';
      err.unitNumber = unitNumber;
      err.assignedDriverName = driverNameHint || null;
      err.candidates = candidateNames;
      throw err;
    }
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
  vehicleNameMatchesUnit,
  normalizeUnitNumber,
  computePingAgeMinutes,
  findVehicleByUnit,
  selectVehicleByUnit,
  fetchAllVehicleStats,
  getLiveLocationForGroupTitle,
};
