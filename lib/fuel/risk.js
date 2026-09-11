/**
 * Whether a truck is in fuel trouble. PURE — no I/O, no clock of its own.
 *
 * The existing fuel feature watches ONE thing: has the truck reached the
 * station dispatch named? It says nothing about whether the truck can get
 * there, whether it went past, or whether the instruction is still current.
 * Those are the questions a person actually asks, and each needs a different
 * pair of facts.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: A MISSING READING IS NOT A LOW ONE.
 *
 * Most of this fleet does not report fuel at all — Samsara returns a percentage
 * only for vehicles whose gateway reads the engine bus, and Drive HoS only for
 * some. A rule that treated "no reading" as zero would page somebody about
 * every truck in the fleet on its first run, and the feature would be switched
 * off within a day. So every threshold here requires a NUMBER, and absence
 * produces silence rather than a guess.
 *
 * `rangeMiles` is deliberately an estimate from a configurable miles-per-gallon
 * and tank size, not a promise. It is used to answer "could this truck plausibly
 * reach that station", which is a question about order of magnitude, and it is
 * always reported with the numbers it came from so a person can disagree.
 */
const { haversineMiles } = require('../geo/distance');

const RISKS = Object.freeze({
  LOW_FUEL: 'low_fuel',
  CANNOT_REACH_STOP: 'cannot_reach_stop',
  PASSED_STOP: 'passed_stop',
  INSTRUCTION_STALE: 'instruction_stale',
  ABNORMAL_BURN: 'abnormal_burn',
});

const DEFAULTS = Object.freeze({
  /**
   * THE OPERATIONAL LOW-FUEL THRESHOLD IS 30%, and it is the one the business
   * asked for: a Samsara-connected truck below 30% is to be surfaced. It was
   * written here as 15, which quietly replaced a stated requirement with a
   * stricter one and meant a truck at 22% — an hour from a problem, and still
   * early enough to route somewhere — produced nothing at all.
   *
   * The lower numbers are kept as SEVERITY, not as the trigger:
   *   <= 30  worth telling operations about        (warning)
   *   <= 15  getting short                          (warning, said more firmly)
   *   <=  8  urgent                                 (serious)
   *
   * All three are overridable through this function's `options` argument. There
   * is NO stored fuel threshold anywhere in the database or the admin — checked
   * — so nothing in production overrides these, and 30 is what runs.
   */
  lowFuelPercent: 30,
  /** Below this it is getting short rather than merely worth knowing. */
  shortFuelPercent: 15,
  /** Below this it is urgent. */
  criticalFuelPercent: 8,
  /** Usable tank, gallons. A conservative figure; the estimate is a sanity check. */
  tankGallons: 150,
  /** Loaded highway average. */
  milesPerGallon: 6.5,
  /** Keep this much in reserve when asking "can it get there". */
  reserveMiles: 40,
  /** Within this of the station counts as arrived. */
  atStationMiles: 5,
  /** Past the station by more than this, and moving away, counts as missed. */
  passedStationMiles: 35,
  /** A fuel instruction older than this is probably from a previous trip. */
  staleInstructionHours: 30,
  /** A drop steeper than this per hundred miles is worth a look. */
  abnormalBurnPercentPer100Miles: 22,
  /** Ignore a reading older than this. */
  staleGpsMinutes: 60,
});

const SEVERITY_ORDER = { serious: 0, warning: 1, info: 2 };

function minutesSince(iso, nowMs) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (nowMs - t) / 60000 : null;
}

/** Miles a truck can plausibly still cover. Null when fuel is unknown. */
function estimateRangeMiles(fuelPercent, { tankGallons, milesPerGallon }) {
  if (fuelPercent == null || !Number.isFinite(fuelPercent)) return null;
  const gallons = (Math.max(0, Math.min(100, fuelPercent)) / 100) * tankGallons;
  return Math.round(gallons * milesPerGallon);
}

/**
 * Every fuel risk this truck currently has.
 *
 * @param {object} input
 * @param {string} input.nowIso
 * @param {object|null} input.position  `{lat, lng, speedMph, at, fuelPercent, odometerMiles}`
 * @param {object|null} input.alert     the open fuel-stop watch, if any
 * @param {object} [input.previous]     the last reading, for a burn rate
 * @param {object} [input.options]
 * @returns {{risks:object[], facts:object}} risks sorted most serious first
 */
function assessFuelRisk({ nowIso, position = null, alert = null, previous = null, options = {} } = {}) {
  const opts = { ...DEFAULTS, ...options };
  const nowMs = Date.parse(nowIso) || Date.now();
  const risks = [];

  const gpsAge = position?.at ? minutesSince(position.at, nowMs) : null;
  const gpsFresh = gpsAge != null && gpsAge <= opts.staleGpsMinutes;
  const fuel = Number.isFinite(position?.fuelPercent) ? Number(position.fuelPercent) : null;
  const odometer = Number.isFinite(position?.odometerMiles) ? Number(position.odometerMiles) : null;
  const range = estimateRangeMiles(fuel, opts);

  const toStation = (gpsFresh && alert && alert.stationLat != null)
    ? haversineMiles(position.lat, position.lng, Number(alert.stationLat), Number(alert.stationLng))
    : null;

  const facts = {
    fuelPercent: fuel,
    fuelReported: fuel != null,
    odometerMiles: odometer,
    rangeMiles: range,
    gpsFresh,
    gpsAgeMinutes: gpsAge == null ? null : Math.round(gpsAge),
    milesToStation: toStation == null ? null : Math.round(toStation),
    stationName: alert?.stationName || null,
    movingAway: null,
    tankGallons: opts.tankGallons,
    milesPerGallon: opts.milesPerGallon,
  };

  // ── the tank itself ────────────────────────────────────────────────────────
  // Only ever from a real number. Absence is silence.
  if (fuel != null) {
    // One risk, three bands. Emitting `low_fuel` once with a severity rather
    // than three separate kinds keeps the quiet-window bookkeeping honest: a
    // truck sliding from 28% to 14% is the same problem getting worse, not a
    // new one, and it must not reset its own repeat timer by changing name.
    const band = fuel <= opts.criticalFuelPercent ? 'critical'
      : (fuel <= opts.shortFuelPercent ? 'short'
        : (fuel <= opts.lowFuelPercent ? 'low' : null));

    if (band) {
      risks.push({
        kind: RISKS.LOW_FUEL,
        severity: band === 'critical' ? 'serious' : 'warning',
        band,
        summary: band === 'critical'
          ? `fuel at ${Math.round(fuel)}% — urgent`
          : `fuel at ${Math.round(fuel)}%`,
        detail: range != null ? `roughly ${range} miles of range left` : null,
      });
    }
  }

  // ── the assigned stop ──────────────────────────────────────────────────────
  if (alert && toStation != null) {
    const arrived = toStation <= opts.atStationMiles;

    // Can it get there? Needs BOTH a fuel reading and a distance; with either
    // missing the honest answer is nothing at all.
    if (!arrived && range != null && toStation > range - opts.reserveMiles) {
      risks.push({
        kind: RISKS.CANNOT_REACH_STOP, severity: 'serious',
        summary: `may not reach ${alert.stationName || 'the assigned stop'}`,
        detail: `${Math.round(toStation)} miles away, about ${range} miles of range`,
      });
    }

    // Did it go past? A truck can be far from a station it has not reached yet,
    // so distance alone says nothing — it has to have been CLOSER before.
    if (previous?.milesToStation != null && !arrived) {
      const movingAway = toStation > previous.milesToStation + 3;
      facts.movingAway = movingAway;
      const wasClose = previous.milesToStation <= opts.atStationMiles * 3;
      if (movingAway && (wasClose || toStation > opts.passedStationMiles)) {
        risks.push({
          kind: RISKS.PASSED_STOP, severity: 'warning',
          summary: `moving away from ${alert.stationName || 'the assigned stop'}`,
          detail: `${Math.round(previous.milesToStation)} miles away last check, `
            + `${Math.round(toStation)} now`,
        });
      }
    }

    // Is the instruction still current? An old watch on a truck that is nowhere
    // near it is almost always last trip's message, still being tracked.
    const ageHours = alert.createdAt ? minutesSince(alert.createdAt, nowMs) / 60 : null;
    if (ageHours != null && ageHours > opts.staleInstructionHours && toStation > opts.passedStationMiles) {
      risks.push({
        kind: RISKS.INSTRUCTION_STALE, severity: 'info',
        summary: 'the fuel instruction looks out of date',
        detail: `sent ${Math.round(ageHours)} hours ago, truck is ${Math.round(toStation)} miles away`,
      });
    }
  }

  // ── how fast it is burning ─────────────────────────────────────────────────
  // Needs two readings of BOTH fuel and odometer. A percentage drop with no
  // distance behind it is a truck that idled, not one that is burning badly.
  if (fuel != null && odometer != null
    && previous?.fuelPercent != null && previous?.odometerMiles != null) {
    const milesRun = odometer - previous.odometerMiles;
    const burned = previous.fuelPercent - fuel;
    facts.milesSinceLastReading = Math.round(milesRun);
    if (milesRun >= 50 && burned > 0) {
      const per100 = (burned / milesRun) * 100;
      facts.burnPercentPer100Miles = Math.round(per100 * 10) / 10;
      if (per100 > opts.abnormalBurnPercentPer100Miles) {
        risks.push({
          kind: RISKS.ABNORMAL_BURN, severity: 'info',
          summary: 'using fuel faster than usual',
          detail: `${Math.round(per100)}% per 100 miles over the last ${Math.round(milesRun)}`,
        });
      }
    }
  }

  risks.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { risks, facts };
}

module.exports = { RISKS, DEFAULTS, estimateRangeMiles, assessFuelRisk };
