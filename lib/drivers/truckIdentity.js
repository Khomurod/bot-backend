'use strict';

/**
 * Which TRUCK a driver is in: its fleet, its number, and — for an owner's
 * truck — its owner. PURE.
 *
 * WHY THE OWNER (owner, 5 November 2026). On the Dispatcher Board the name after
 * a number is the truck's OWNER, not its driver: "1 ERNST" is driven by Jerome
 * Joyner and "562 ERNST" by Ernst Brutus; "1 ERNST", "1 ROGER" and "1 RUDOLPH"
 * are three trucks, and four owners each have an "001". A truck written as
 * (fleet, number) alone made all three "1"s one truck, so only one driver could
 * hold it and the other two had no truck at all in Wenze.
 *
 * WHY THE TRUCK'S FLEET IS NOT THE DRIVER'S TYPE (owner, same day): "by the
 * truck an owner-operator, by the driver a company driver" — a driver hired by
 * an owner drives an owner's truck as a company driver. So a profile may carry
 * the TRUCK's fleet and owner (`truck_fleet`, `truck_owner`, read from the
 * board) beside the DRIVER's type (`driver_type`). Where it carries none, the
 * driver's type stands in for the truck's, as it always has
 * (`resolveDriverType`), and the owner is unknown.
 *
 * An unknown owner never separates two trucks: it cannot prove they differ —
 * the same rule `unknown` fleet already follows.
 */
const { describeTruckSuffix } = require('../board/truckSuffix');
const { resolveDriverType, isFleetType, FLEET_TYPES } = require('./fleetType');

/** An owner's name, written one way: upper case, no brackets, single spaces. Null when there is none. */
function normaliseOwner(value) {
  const text = String(value == null ? '' : value).replace(/[()[\]]/g, ' ').trim().replace(/\s+/g, ' ').toUpperCase();
  return text || null;
}

/** The owner a board suffix names — only a driver's-name suffix does ("ROGER", "(POLVAN)"); fleet words never. */
function ownerFromSuffix(suffix) {
  const owner = normaliseOwner(suffix);
  if (!owner) return null;
  return describeTruckSuffix(owner).detail === 'own_truck' ? owner : null;
}

/** What a board row says about its truck: `{fleetType, owner}`. */
function truckFromBoardRow(row = {}) {
  return {
    fleetType: row.fleetType || row.fleet_type || FLEET_TYPES.UNKNOWN,
    owner: ownerFromSuffix(row.fleetLabelRaw ?? row.fleet_label_raw ?? null),
  };
}

/**
 * The truck a profile says its driver is in: the truck's own fleet and owner
 * when they are recorded, otherwise the driver's type (or the chat title) for
 * the fleet and no owner.
 *
 * @param {{driver_type?:string, truck_fleet?:string, truck_owner?:string}} profile
 * @param {string|null} title   the chat title
 * @returns {{fleetType:string, owner:string|null}}
 */
function truckOfProfile(profile = {}, title = null) {
  const fleetType = isFleetType(profile?.truck_fleet) && profile.truck_fleet !== FLEET_TYPES.UNKNOWN
    ? profile.truck_fleet
    : resolveDriverType({ column: profile?.driver_type ?? null, title }).fleetType;
  return { fleetType, owner: normaliseOwner(profile?.truck_owner) };
}

/** Two owners name different trucks only when BOTH are known and differ. */
function ownersCompatible(a, b) {
  const left = normaliseOwner(a);
  const right = normaliseOwner(b);
  return !left || !right || left === right;
}

module.exports = {
  normaliseOwner, ownerFromSuffix, truckFromBoardRow, truckOfProfile, ownersCompatible,
};
