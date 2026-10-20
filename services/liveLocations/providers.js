/**
 * GPS PROVIDERS for the dispatch map.
 *
 * Fans out to Samsara and the Drive HoS ELDs (Factor, then Leader) and
 * normalizes their differently-shaped vehicle records into one location shape.
 * A provider failing must degrade to "no location for that unit", never take
 * the whole snapshot down.
 *
 * Split out of services/liveLocationsService.js, which re-exports these for
 * its unit tests.
 */
const samsara = require('../samsaraLocationService');
const driveHos = require('../driveHosEldService');
const { getEldConfig } = require('../../database/eldSettings');
const { STALE_MINUTES } = require('./constants');
const { toNumberOrNull, round, toIso } = require('./shaping');

// ─── GPS: batch-fetch each provider's fleet once ──────────────────────────────
async function fetchProviderFleets(cfg) {
  const errors = [];
  const fleets = { samsara: null, factor: null, leader: null };
  const tasks = [];

  if (cfg.samsaraEnabled && Array.isArray(cfg.samsaraApiKeys) && cfg.samsaraApiKeys.length) {
    tasks.push((async () => {
      try {
        const all = [];
        for (const apiKey of cfg.samsaraApiKeys) {
          const vehicles = await samsara.fetchAllVehicleStats({ apiKey, apiBase: cfg.samsaraApiBase });
          all.push(...vehicles);
        }
        fleets.samsara = all;
      } catch (err) {
        errors.push({ provider: 'samsara', code: err.code || 'ERROR', message: err.message });
      }
    })());
  }

  if (cfg.factorEnabled && cfg.driveHosProviderKey && cfg.factorCompanyKey) {
    tasks.push((async () => {
      try {
        fleets.factor = await driveHos.fetchAllLatestVehicleStatuses({
          providerKey: cfg.driveHosProviderKey,
          companyKey: cfg.factorCompanyKey,
          apiBase: cfg.driveHosApiBase,
        });
      } catch (err) {
        errors.push({ provider: 'factor', code: err.code || 'ERROR', message: err.message });
      }
    })());
  }

  if (cfg.leaderEnabled && cfg.driveHosProviderKey && cfg.leaderCompanyKey) {
    tasks.push((async () => {
      try {
        fleets.leader = await driveHos.fetchAllLatestVehicleStatuses({
          providerKey: cfg.driveHosProviderKey,
          companyKey: cfg.leaderCompanyKey,
          apiBase: cfg.driveHosApiBase,
        });
      } catch (err) {
        errors.push({ provider: 'leader', code: err.code || 'ERROR', message: err.message });
      }
    })());
  }

  await Promise.all(tasks);
  return { fleets, errors };
}

function buildLocationFromSamsaraVehicle(vehicle) {
  const gps = vehicle && vehicle.gps ? vehicle.gps : {};
  if (typeof gps.latitude !== 'number' || typeof gps.longitude !== 'number') return null;
  const pingIso = gps.time || null;
  const ageMin = samsara.computePingAgeMinutes(pingIso);
  return {
    lat: gps.latitude,
    lng: gps.longitude,
    heading: typeof gps.headingDegrees === 'number' ? gps.headingDegrees : null,
    speedMph: round(gps.speedMilesPerHour, 0),
    lastUpdated: pingIso,
    isStale: ageMin != null && ageMin > STALE_MINUTES,
  };
}

function buildLocationFromDriveHosVehicle(vehicle) {
  const lat = toNumberOrNull(vehicle && (vehicle.lat ?? vehicle.latitude));
  const lng = toNumberOrNull(vehicle && (vehicle.lon ?? vehicle.lng ?? vehicle.longitude));
  if (lat == null || lng == null) return null;
  const pingIso = (vehicle && vehicle.timestamp) || null;
  const ageMin = samsara.computePingAgeMinutes(pingIso);
  return {
    lat,
    lng,
    heading: toNumberOrNull(vehicle && (vehicle.heading ?? vehicle.bearing ?? vehicle.rotation)),
    speedMph: round(toNumberOrNull(vehicle && vehicle.speed), 0),
    lastUpdated: pingIso,
    isStale: ageMin != null && ageMin > STALE_MINUTES,
  };
}

/** Resolve GPS for one unit against the pre-fetched fleets, in priority order. */
function resolveLocationForUnit(fleets, unitNumber, driverNameHint) {
  let ambiguous = false;
  let matchWarning = null;
  if (fleets.samsara) {
    const selection = samsara.selectVehicleByUnit(fleets.samsara, unitNumber, { driverNameHint });
    if (selection.vehicle) {
      const loc = buildLocationFromSamsaraVehicle(selection.vehicle);
      if (loc) return { provider: 'samsara', location: loc, ambiguous: false, matchWarning: null };
    } else if (selection.ambiguous) {
      // Duplicate unit number with no confident driver-name winner: do NOT use a
      // (possibly wrong) Samsara truck. Flag it and let the fallbacks try.
      ambiguous = true;
      matchWarning = `Duplicate unit ${unitNumber}: ${selection.candidates.length} Samsara vehicles share it `
        + `and none clearly matches "${driverNameHint || 'this driver'}".`;
    }
  }
  if (fleets.factor) {
    const v = driveHos.findVehicleByUnit(fleets.factor, unitNumber);
    if (v) {
      const loc = buildLocationFromDriveHosVehicle(v);
      if (loc) return { provider: 'factor', location: loc, ambiguous, matchWarning };
    }
  }
  if (fleets.leader) {
    const v = driveHos.findVehicleByUnit(fleets.leader, unitNumber);
    if (v) {
      const loc = buildLocationFromDriveHosVehicle(v);
      if (loc) return { provider: 'leader', location: loc, ambiguous, matchWarning };
    }
  }
  return { provider: null, location: null, ambiguous, matchWarning };
}

module.exports = {
  fetchProviderFleets,
  buildLocationFromSamsaraVehicle,
  buildLocationFromDriveHosVehicle,
  resolveLocationForUnit,
};
