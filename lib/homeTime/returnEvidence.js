/**
 * Did this driver actually go back to work? PURE.
 *
 * Drivers rarely announce it. They get a load and start driving, and the only
 * writer of `return_to_road_at` used to be a "Status: Ready" line in a chat —
 * which is how production ended up with 74 open cycles out of 79.
 *
 * So this function reads the evidence the company already collects and says how
 * sure Wenze is. It decides nothing on its own: it returns a confidence and the
 * exact signals behind it, and the caller decides what a confidence is worth.
 *
 * THE ONE RULE WORTH STATING TWICE: A LOAD IS NOT A DEPARTURE. Dispatch assigns
 * loads to drivers who are still at home — that is normal planning, not work
 * starting. So `high` requires BOTH a load AND proof the truck moved, as a hard
 * gate that no amount of score can talk its way around. A truck sitting in its
 * own driveway with a load on it scores negative, not positive.
 *
 * No I/O: every input is a plain value the caller has already fetched, which is
 * what makes each of these rules a test rather than an opinion.
 */
const { haversineMiles } = require('../geo/distance');

/** Defaults, all overridable per call so settings can move without a deploy. */
const DEFAULTS = Object.freeze({
  // Within this of where the truck was parked when the driver went home, it has
  // not left. Generous on purpose: a driver moves the truck to a shop, a lot or
  // a relative's street without going back to work.
  homeRadiusMiles: 15,
  // At or below this the truck is parked, not driving. Same threshold Route
  // Control uses to call a truck parked.
  parkedSpeedMph: 5,
  // A ping older than this proves nothing about right now.
  staleGpsMinutes: 45,
  // Two separate sightings of movement, so one GPS glitch is not a departure.
  sustainedObservations: 2,
  // Getting this much closer to the pickup is corroboration, not coincidence.
  approachingPickupMiles: 5,
  highScore: 85,
  mediumScore: 45,
});

const WORKING_LOAD_STATUSES = ['assigned', 'dispatched', 'in_transit', 'in transit', 'en route', 'enroute'];
const DRIVING_LOAD_STATUSES = ['in_transit', 'in transit', 'en route', 'enroute'];

const CONFIDENCE = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });

function minutesBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 60000;
}

function normaliseStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** Is this a load the driver is expected to be working right now? */
function loadIsWorking(load) {
  if (!load) return false;
  const status = normaliseStatus(load.status);
  if (!status) return Boolean(load.loadIdentifier || load.orderId);
  return WORKING_LOAD_STATUSES.map(normaliseStatus).includes(status);
}

function loadIsDriving(load) {
  return DRIVING_LOAD_STATUSES.map(normaliseStatus).includes(normaliseStatus(load?.status));
}

function milesBetweenPoints(a, b) {
  if (!a || !b) return null;
  if (![a.lat, a.lng, b.lat, b.lng].every((n) => Number.isFinite(Number(n)))) return null;
  return haversineMiles(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
}

/**
 * Everything the observations say about movement, as plain facts.
 * `observations` are oldest-first sightings of the truck: {lat, lng, speedMph, at}.
 */
function summariseMovement(observations, anchor, opts, remembered = {}) {
  const list = (Array.isArray(observations) ? observations : []).filter(Boolean);
  const latest = list.length ? list[list.length - 1] : null;
  const movingHere = list.filter((o) => Number(o.speedMph) > opts.parkedSpeedMph).length;
  const distances = anchor
    ? list.map((o) => milesBetweenPoints(anchor, o)).filter((d) => d != null)
    : [];
  // The caller may remember more than these two sightings show. A truck that
  // drove sixty miles out and then lost GPS is still sixty miles out; without
  // the remembered maximum the evidence would quietly shrink back to nothing.
  const rememberedMiles = Number(remembered.maxMilesFromAnchor);
  const rememberedMoving = Number(remembered.movingSightings);
  const here = distances.length ? Math.max(...distances) : null;
  const milesFromAnchor = [here, Number.isFinite(rememberedMiles) ? rememberedMiles : null]
    .filter((n) => n != null).reduce((a, b) => Math.max(a, b), null) ?? null;
  const movingSightings = Math.max(movingHere, Number.isFinite(rememberedMoving) ? rememberedMoving : 0);
  return {
    latest,
    // Distance from where the truck was parked when the driver went home.
    milesFromAnchor,
    milesFromAnchorNow: anchor && latest ? milesBetweenPoints(anchor, latest) : null,
    movingNow: latest ? Number(latest.speedMph) > opts.parkedSpeedMph : false,
    movingSightings,
    sustained: movingSightings >= opts.sustainedObservations,
  };
}

/**
 * @returns {{confidence:'high'|'medium'|'low', score:number, signals:string[],
 *   blockers:string[], summary:string, facts:object}}
 */
function scoreReturnToRoad({
  nowIso = new Date().toISOString(),
  load = null,
  anchor = null,
  observations = [],
  driverSaidRoad = false,
  remembered = {},
  options = {},
} = {}) {
  const opts = { ...DEFAULTS, ...options };
  const signals = [];
  const blockers = [];
  let score = 0;

  // ── the load ──
  const hasLoad = loadIsWorking(load);
  const driving = hasLoad && loadIsDriving(load);
  if (driving) { score += 55; signals.push('load_in_transit'); } else if (hasLoad) { score += 40; signals.push('active_load'); }

  // ── the truck ──
  const move = summariseMovement(observations, anchor, opts, remembered);
  const ageMinutes = move.latest ? minutesBetween(move.latest.at, nowIso) : null;
  const gpsFresh = move.latest != null && (ageMinutes == null || ageMinutes <= opts.staleGpsMinutes);
  if (!move.latest) blockers.push('no_gps');
  else if (!gpsFresh) { score -= 40; blockers.push('gps_stale'); }

  const leftHomeArea = anchor != null && move.milesFromAnchor != null
    && move.milesFromAnchor > opts.homeRadiusMiles;
  if (leftHomeArea) { score += 35; signals.push('left_home_area'); }
  if (gpsFresh && move.movingNow) { score += 20; signals.push('truck_moving'); }
  if (move.sustained) { score += 15; signals.push('sustained_movement'); }

  // Parked where the driver went home is the strongest possible NO: the load
  // may be assigned, but the truck has not started.
  const parkedAtHome = gpsFresh && !move.movingNow && anchor != null
    && move.milesFromAnchorNow != null && move.milesFromAnchorNow <= opts.homeRadiusMiles;
  if (parkedAtHome) { score -= 70; blockers.push('parked_at_home'); }

  // ── the load's own geography ──
  const pickup = load && Number.isFinite(Number(load.pickupLat)) && Number.isFinite(Number(load.pickupLng))
    ? { lat: Number(load.pickupLat), lng: Number(load.pickupLng) }
    : null;
  const pickupMilesNow = pickup && move.latest ? milesBetweenPoints(pickup, move.latest) : null;
  const pickupMilesFirst = pickup && observations.length
    ? milesBetweenPoints(pickup, observations[0]) : null;
  const approachingPickup = pickupMilesNow != null && pickupMilesFirst != null
    && (pickupMilesFirst - pickupMilesNow) >= opts.approachingPickupMiles;
  if (approachingPickup) { score += 15; signals.push('approaching_pickup'); }

  // A pickup appointment that has already passed while the truck sits at home
  // is not evidence of work — it is a question worth putting to a person.
  const pickupPassed = load?.pickupTime ? Date.parse(load.pickupTime) < Date.parse(nowIso) : false;
  if (pickupPassed && parkedAtHome) blockers.push('pickup_passed_still_home');

  if (driverSaidRoad) { score += 30; signals.push('driver_said_road'); }

  // ── the verdict ──
  // The hard gate. Both halves must be present; a score alone can never buy a
  // state change, which is what keeps "a load appeared" from meaning "he left".
  const movementProven = gpsFresh && (leftHomeArea || (move.movingNow && move.sustained));
  const canBeHigh = hasLoad && movementProven && !parkedAtHome;
  let confidence = CONFIDENCE.LOW;
  if (canBeHigh && score >= opts.highScore) confidence = CONFIDENCE.HIGH;
  else if (score >= opts.mediumScore || blockers.includes('pickup_passed_still_home')) {
    confidence = CONFIDENCE.MEDIUM;
  }

  return {
    confidence,
    score,
    signals,
    blockers,
    summary: describeEvidence({ signals, blockers, move, hasLoad, driving }),
    facts: {
      hasLoad,
      driving,
      loadIdentifier: load?.loadIdentifier || load?.orderId || null,
      loadStatus: load?.status || null,
      gpsFresh,
      gpsAgeMinutes: ageMinutes == null ? null : Math.round(ageMinutes),
      movingNow: move.movingNow,
      movingSightings: move.movingSightings,
      milesFromHome: move.milesFromAnchor == null ? null : Math.round(move.milesFromAnchor),
      milesFromHomeNow: move.milesFromAnchorNow == null ? null : Math.round(move.milesFromAnchorNow),
      milesToPickup: pickupMilesNow == null ? null : Math.round(pickupMilesNow),
      leftHomeArea,
      parkedAtHome,
      movementProven,
    },
  };
}

/** One short phrase for a manager, built only from signals that actually fired. */
function describeEvidence({ signals, blockers, move, hasLoad, driving }) {
  const parts = [];
  if (driving) parts.push('load in transit');
  else if (hasLoad) parts.push('active load');
  if (signals.includes('left_home_area')) {
    parts.push(`truck ${Math.round(move.milesFromAnchor)} mi from home`);
  }
  if (signals.includes('truck_moving')) parts.push('truck moving');
  if (signals.includes('sustained_movement')) parts.push('movement confirmed twice');
  if (signals.includes('approaching_pickup')) parts.push('closing on the pickup');
  if (signals.includes('driver_said_road')) parts.push('driver said they are rolling');
  if (blockers.includes('parked_at_home')) parts.push('but the truck is parked at home');
  if (blockers.includes('gps_stale')) parts.push('GPS is stale');
  if (blockers.includes('no_gps')) parts.push('no GPS available');
  if (blockers.includes('pickup_passed_still_home')) parts.push('pickup time passed with the truck still home');
  return parts.join(' + ') || 'no evidence';
}

module.exports = {
  DEFAULTS,
  CONFIDENCE,
  WORKING_LOAD_STATUSES,
  loadIsWorking,
  loadIsDriving,
  milesBetweenPoints,
  summariseMovement,
  scoreReturnToRoad,
  describeEvidence,
};
