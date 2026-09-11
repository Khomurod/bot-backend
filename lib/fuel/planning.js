'use strict';

/**
 * Can this truck reach the stop it was given, and what to say when it cannot.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not a station finder. Wenze knows the
 * stops dispatch names in `fuel_stop_alerts` and has no database of fuel prices,
 * truck-accessible stations or opening hours — so a recommendation to "stop at
 * the Pilot in Effingham" would be an invented fact wearing the clothes of a
 * plan. When the assigned stop is out of reach, this says so, says by how much,
 * and leaves choosing the alternative to the person who can actually see one.
 *
 * That restraint is the feature. A confident wrong suggestion about where to
 * fuel a truck four hundred miles from anywhere is worse than a clear statement
 * of the problem.
 *
 * RANGE IS AN ORDER OF MAGNITUDE, NOT A PROMISE. It comes from a tank
 * percentage and an assumed consumption, neither of which knows about the load,
 * the terrain or the weather. Everything here is phrased and rounded to match
 * that — "about 180 miles", never "182 miles" — because a number given to three
 * significant figures will be trusted to three significant figures.
 */

const DEFAULTS = Object.freeze({
  /** Below this margin the stop is not really reachable. */
  comfortableMarginMiles: 50,
  /** A margin under this is worth saying even though it technically fits. */
  tightMarginMiles: 100,
});

/**
 * @param {object} input
 * @param {number|null} input.rangeMiles      how far it can go, already estimated
 * @param {number|null} input.milesToStation  how far the assigned stop is
 * @param {string|null} [input.stationName]
 * @param {number|null} [input.milesToNextStop] the DELIVERY after fuelling, when known
 * @returns {{known:boolean, reachable:boolean|null, marginMiles:number|null,
 *   advice:string, facts:object}}
 */
function planFuelStop({
  rangeMiles = null, milesToStation = null, stationName = null,
  milesToNextStop = null, options = {},
} = {}) {
  const opts = { ...DEFAULTS, ...options };

  if (!Number.isFinite(rangeMiles) || !Number.isFinite(milesToStation)) {
    // The same rule as everywhere else in this application: missing is UNKNOWN,
    // never zero. A truck whose tank we cannot read is not a truck with an
    // empty tank.
    return {
      known: false,
      reachable: null,
      marginMiles: null,
      advice: !Number.isFinite(rangeMiles)
        ? 'no fuel reading for this truck, so whether it can reach the stop is unknown'
        : 'no distance to the assigned stop, so whether it can reach it is unknown',
      facts: { rangeMiles, milesToStation },
    };
  }

  const margin = rangeMiles - milesToStation;
  const where = stationName ? `the stop at ${stationName}` : 'the assigned stop';
  const facts = {
    rangeMiles: Math.round(rangeMiles),
    milesToStation: Math.round(milesToStation),
    marginMiles: Math.round(margin),
  };

  if (margin <= 0) {
    return {
      known: true,
      reachable: false,
      marginMiles: Math.round(margin),
      // NO ALTERNATIVE IS NAMED, on purpose. We do not have one to name.
      advice: `about ${facts.rangeMiles} miles in the tank and ${facts.milesToStation} to `
        + `${where} — it will not get there. Somebody needs to pick a closer stop.`,
      facts,
    };
  }

  if (margin < opts.comfortableMarginMiles) {
    return {
      known: true,
      reachable: true,
      marginMiles: Math.round(margin),
      advice: `about ${facts.marginMiles} miles of margin to ${where}, which is `
        + 'thin enough that a detour or a queue would end the trip early',
      facts,
    };
  }

  // Only worth mentioning the leg AFTER fuelling when we actually know it.
  if (Number.isFinite(milesToNextStop) && margin < opts.tightMarginMiles) {
    return {
      known: true,
      reachable: true,
      marginMiles: Math.round(margin),
      advice: `it reaches ${where} with about ${facts.marginMiles} miles spare, and has `
        + `${Math.round(milesToNextStop)} more to run afterwards`,
      facts: { ...facts, milesToNextStop: Math.round(milesToNextStop) },
    };
  }

  return {
    known: true,
    reachable: true,
    marginMiles: Math.round(margin),
    advice: `it reaches ${where} comfortably — about ${facts.marginMiles} miles spare`,
    facts,
  };
}

/**
 * The facts a fuel notice hands to `lib/notifications/priority.js`.
 *
 * Kept here rather than built at the call site so the numbers a notice is
 * prioritised by are the same numbers its text was written from. Two places
 * computing "how urgent is this" from the same inputs is two places to get it
 * different.
 */
function priorityFactsFor(plan, { fuelPercent = null } = {}) {
  // THE TANK TRAVELS EVEN WHEN THE PLAN IS UNKNOWN. A truck at 6% with no
  // assigned stop has no reachability plan at all, and returning `{}` for it
  // left the notice with nothing to be urgent about: it landed at `whenever`
  // and could be held for an hour behind three other notices about the same
  // driver. The percentage is established, so it goes whether or not a stop
  // was ever named.
  const tank = Number.isFinite(fuelPercent) ? { fuelPercent } : {};
  if (!plan?.known) return tank;
  return {
    ...tank,
    rangeMiles: plan.facts.rangeMiles,
    milesToStation: plan.facts.milesToStation,
  };
}

module.exports = { DEFAULTS, planFuelStop, priorityFactsFor };
