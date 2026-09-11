/**
 * What is actually happening with this load, from evidence. PURE — no I/O.
 *
 * Dispatch status is a PLAN, not an observation. A load reads `dispatched` the
 * moment somebody assigns it, which is often days before the truck moves, and
 * it frequently still reads `in_transit` after delivery because nobody went back
 * to change it. Asking the load board what a driver is doing therefore answers
 * a different question from the one being asked.
 *
 * So the phase is derived from WHERE THE TRUCK IS, with the board's status as a
 * corroborating signal rather than the answer. Two rules follow from that and
 * are enforced below rather than left to a caller:
 *
 *   ARRIVAL IS OBSERVED, DEPARTURE IS REMEMBERED. "At pickup" is a distance you
 *   can measure right now. "Delivered" is not — it is the truck having been at
 *   the delivery and then left, which needs the earlier observation. A phase
 *   that claims a departure with no memory of the arrival is guessing.
 *
 *   CONFLICT IS AN ANSWER. When the board and the coordinates disagree — status
 *   `in_transit` with the truck parked at the shipper, status `assigned` with
 *   the truck at the receiver — the phase does NOT move. Picking a side is how
 *   a wrong status propagates into everything downstream.
 */
const { haversineMiles } = require('../geo/distance');

const PHASES = Object.freeze({
  ASSIGNED: 'assigned',
  HEADING_TO_PICKUP: 'heading_to_pickup',
  AT_PICKUP: 'at_pickup',
  IN_TRANSIT: 'in_transit',
  AT_DELIVERY: 'at_delivery',
  DELIVERED: 'delivered',
  EMPTY: 'empty',
});

/** Display order, which is also the order a load normally moves through. */
const PHASE_ORDER = Object.freeze([
  PHASES.ASSIGNED, PHASES.HEADING_TO_PICKUP, PHASES.AT_PICKUP,
  PHASES.IN_TRANSIT, PHASES.AT_DELIVERY, PHASES.DELIVERED, PHASES.EMPTY,
]);

const PHASE_LABELS = Object.freeze({
  [PHASES.ASSIGNED]: 'Assigned, not started',
  [PHASES.HEADING_TO_PICKUP]: 'Heading to pickup',
  [PHASES.AT_PICKUP]: 'At pickup',
  [PHASES.IN_TRANSIT]: 'Loaded and moving',
  [PHASES.AT_DELIVERY]: 'At delivery',
  [PHASES.DELIVERED]: 'Delivered',
  [PHASES.EMPTY]: 'Empty',
});

const DEFAULTS = Object.freeze({
  /** Within this of a stop's coordinates counts as being there. */
  atStopMiles: 3,
  /** Below this the truck is parked, not driving. */
  parkedSpeedMph: 5,
  /** Older than this and the position says nothing about right now. */
  staleGpsMinutes: 45,
  /** Far enough past a stop to call it left rather than manoeuvring. */
  leftStopMiles: 12,
});

function minutesSince(iso, nowMs) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (nowMs - t) / 60000 : null;
}

function distanceTo(position, lat, lng) {
  if (!position || lat == null || lng == null) return null;
  const miles = haversineMiles(position.lat, position.lng, Number(lat), Number(lng));
  return Number.isFinite(miles) ? miles : null;
}

/** Dispatch's own word, reduced to the three things it can usefully say. */
function boardSays(status) {
  const s = String(status || '').toLowerCase();
  if (/deliver|complete|unload/.test(s)) return PHASES.DELIVERED;
  if (/transit|loaded|rolling|en\s*route/.test(s)) return PHASES.IN_TRANSIT;
  if (/assign|dispatch|plan|pending|book/.test(s)) return PHASES.ASSIGNED;
  return null;
}

/**
 * Work out the phase.
 *
 * @param {object} input
 * @param {string} input.nowIso
 * @param {object|null} input.load        pickup/delivery coordinates and status
 * @param {object|null} input.position    `{lat, lng, speedMph, at}` — the truck now
 * @param {object} [input.remembered]     `{phase, wasAtPickup, wasAtDelivery}`
 * @param {object} [input.options]
 * @returns {{phase:string, label:string, confidence:'high'|'medium'|'low',
 *   signals:string[], conflicts:string[], facts:object, summary:string}}
 */
function derivePhase({ nowIso, load = null, position = null, remembered = {}, options = {} } = {}) {
  const opts = { ...DEFAULTS, ...options };
  const nowMs = Date.parse(nowIso) || Date.now();
  const signals = [];
  const conflicts = [];

  if (!load) {
    return {
      phase: PHASES.EMPTY, label: PHASE_LABELS[PHASES.EMPTY], confidence: 'high',
      signals: ['no_active_load'], conflicts: [], facts: { hasLoad: false },
      summary: 'no active load',
    };
  }

  const gpsAge = position?.at ? minutesSince(position.at, nowMs) : null;
  const gpsFresh = gpsAge != null && gpsAge <= opts.staleGpsMinutes;
  const moving = gpsFresh && Number(position?.speedMph ?? 0) > opts.parkedSpeedMph;
  const toPickup = gpsFresh ? distanceTo(position, load.pickupLat, load.pickupLng) : null;
  const toDelivery = gpsFresh ? distanceTo(position, load.deliveryLat, load.deliveryLng) : null;

  const atPickup = toPickup != null && toPickup <= opts.atStopMiles;
  const atDelivery = toDelivery != null && toDelivery <= opts.atStopMiles;
  const leftPickup = toPickup != null && toPickup > opts.leftStopMiles;
  const leftDelivery = toDelivery != null && toDelivery > opts.leftStopMiles;

  // Remembered arrivals. A departure can only be claimed by a watcher that saw
  // the arrival; a caller with no memory gets the observable phase instead.
  const sawPickup = remembered.wasAtPickup === true;
  const sawDelivery = remembered.wasAtDelivery === true;
  const board = boardSays(load.status);

  const facts = {
    hasLoad: true,
    loadIdentifier: load.loadIdentifier || null,
    boardStatus: load.status || null,
    gpsFresh,
    gpsAgeMinutes: gpsAge == null ? null : Math.round(gpsAge),
    moving,
    milesToPickup: toPickup == null ? null : Math.round(toPickup),
    milesToDelivery: toDelivery == null ? null : Math.round(toDelivery),
    atPickup,
    atDelivery,
    sawPickup,
    sawDelivery,
    hasPickupCoords: load.pickupLat != null && load.pickupLng != null,
    hasDeliveryCoords: load.deliveryLat != null && load.deliveryLng != null,
  };

  // No usable position: the board is all there is, and it is a plan.
  if (!gpsFresh) {
    signals.push(gpsAge == null ? 'no_gps' : 'gps_stale');
    // WHAT WAS OBSERVED BEATS WHAT WAS PLANNED, even when the observation is
    // old. Preferring the board here would walk a truck that was last seen
    // loaded and moving back to "assigned" the moment its GPS went quiet — the
    // exact inversion this whole module exists to avoid.
    const fallback = remembered.phase || board || PHASES.ASSIGNED;
    return {
      phase: fallback, label: PHASE_LABELS[fallback], confidence: 'low', signals, conflicts,
      facts, summary: `no fresh position — showing the board's "${load.status || 'unknown'}"`,
    };
  }
  signals.push('gps_fresh');

  let phase;
  if (atDelivery) {
    signals.push('at_delivery');
    phase = PHASES.AT_DELIVERY;
  } else if (sawDelivery && leftDelivery) {
    // The only way to observe a delivery: it was there, and now it is gone.
    signals.push('left_delivery_after_arriving');
    phase = PHASES.DELIVERED;
  } else if (atPickup) {
    signals.push('at_pickup');
    phase = PHASES.AT_PICKUP;
  } else if (sawPickup && leftPickup) {
    signals.push('left_pickup_after_arriving');
    phase = PHASES.IN_TRANSIT;
  } else if (moving) {
    signals.push('truck_moving');
    // Without a remembered pickup, moving toward the receiver is only "loaded"
    // if the board agrees. Otherwise the honest answer is that it is going to
    // get the load.
    phase = board === PHASES.IN_TRANSIT ? PHASES.IN_TRANSIT : PHASES.HEADING_TO_PICKUP;
  } else {
    signals.push('truck_parked');
    phase = remembered.phase || PHASES.ASSIGNED;
  }

  // Does the board agree?
  //
  // ONLY A BOARD RUNNING AHEAD OF THE TRUCK IS A CONFLICT. A board that lags is
  // the normal state of every load board ever built — a status is set when the
  // load is planned and rarely touched again, so "still says assigned while the
  // truck is at the receiver" describes almost every delivered load and would
  // make this check pure noise. A board claiming MORE than the coordinates
  // support is the opposite: somebody, or something, recorded work that has not
  // happened, and everything downstream will believe it.
  //
  // A conflict is reported, never resolved. Picking a side is how a wrong
  // status propagates.
  if (board && board !== phase && PHASE_ORDER.indexOf(board) > PHASE_ORDER.indexOf(phase)) {
    if (board === PHASES.IN_TRANSIT) {
      conflicts.push('board_says_loaded_but_the_truck_has_not_left_the_shipper');
    } else if (board === PHASES.DELIVERED) {
      conflicts.push('board_says_delivered_but_the_truck_is_still_at_the_receiver');
    }
  }

  let confidence = 'high';
  if (conflicts.length) confidence = 'medium';
  else if (phase === PHASES.HEADING_TO_PICKUP) {
    // Always an inference, never an observation. All that was seen is a moving
    // truck; that it is moving TOWARD the shipper is an assumption, and nothing
    // here tracks whether the distance is actually closing. Reporting this as
    // confident would be the one phase in the set that is a guess wearing a
    // fact's clothes.
    confidence = 'medium';
  } else if (!facts.hasPickupCoords || !facts.hasDeliveryCoords) confidence = 'medium';

  const summary = [
    PHASE_LABELS[phase].toLowerCase(),
    toPickup != null && phase !== PHASES.DELIVERED ? `${Math.round(toPickup)} mi from the shipper` : null,
    toDelivery != null ? `${Math.round(toDelivery)} mi from the receiver` : null,
    conflicts.length ? 'board disagrees' : null,
  ].filter(Boolean).join(', ');

  return { phase, label: PHASE_LABELS[phase], confidence, signals, conflicts, facts, summary };
}

module.exports = { PHASES, PHASE_ORDER, PHASE_LABELS, DEFAULTS, boardSays, derivePhase };
