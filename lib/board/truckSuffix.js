'use strict';

/**
 * The new Board's truck column: a unit number, then who the truck is run by.
 * PURE.
 *
 * Since November 2026 the board is a service of its own
 * (`board.wenzellc.com/api/public/v1/board`), and it no longer writes the fleet
 * inside the driver's name. It writes it after the unit number, in the truck
 * column: `021 CMP`, `003 CPM`, `001 V`, `310 JAVLON`, `127 L`, `045`. The
 * owner's reading of those suffixes (5 November 2026, replacing the first
 * reading of the 4th, which had a driver's name and R as company and L as
 * lease):
 *
 *   COMP        company driver, the company's truck            company
 *   CMP (CPM)   company driver, an investor's truck — the
 *               investor paid part of it, we paid the rest     company
 *   V           company driver, a vendor's truck (not an
 *               investor: he came with his truck)              company
 *   R           lease operator — lease to rent                 lease
 *   L           bought the truck from us with a down payment —
 *               lease to own. Treated as an owner-operator,
 *               which is also how gross is calculated          owner-operator
 *   a name      `310 JAVLON`, `077 (Polvan)` — an
 *               owner-operator in his own truck                owner-operator
 *   nothing     `045`                                          owner-operator
 *
 * Wenze has three fleets, so R and L are told apart by `detail` (shown next to
 * the fleet), not by the fleet itself.
 *
 * The UNIT is the number with its leading zeros, plus one letter written
 * straight after it: `021 CMP` is unit `021`, `001A RALPH` is unit `001A` —
 * the spellings Wenze's groups and people carry. The suffix is a fleet, not
 * part of the truck's name — keeping it would make every unit look unknown to
 * the exact comparison in `./truck.js`. A suffix needs a space before it: the
 * board always writes one, and `127L` reads as unit `127L`.
 *
 * Anything that does not start with a number is left whole and its fleet is
 * `unknown`: `unknown` never wins a match, so an unreadable truck is a question,
 * never a merge. So is a suffix with a digit in it.
 */
const { FLEET_TYPES } = require('../drivers/fleetType');

const COMPANY_TRUCK = Object.freeze({ fleetType: FLEET_TYPES.COMPANY, detail: 'company_truck' });
const INVESTOR_TRUCK = Object.freeze({ fleetType: FLEET_TYPES.COMPANY, detail: 'investor_truck' });
const OWN_TRUCK = Object.freeze({ fleetType: FLEET_TYPES.OWNER_OPERATOR, detail: 'own_truck' });
const UNREADABLE = Object.freeze({ fleetType: FLEET_TYPES.UNKNOWN, detail: null });

/** The owner's suffix words. Anything else made of letters is a driver's name. */
const SUFFIXES = Object.freeze({
  COMP: COMPANY_TRUCK,
  COMPANY: COMPANY_TRUCK,
  CMP: INVESTOR_TRUCK,
  CPM: INVESTOR_TRUCK, // the same suffix, typed the other way round
  V: Object.freeze({ fleetType: FLEET_TYPES.COMPANY, detail: 'vendor_truck' }),
  R: Object.freeze({ fleetType: FLEET_TYPES.LEASE, detail: 'lease_to_rent' }),
  L: Object.freeze({ fleetType: FLEET_TYPES.OWNER_OPERATOR, detail: 'lease_to_own' }),
});

/** What each `detail` is called on a screen. */
const DETAIL_LABELS = Object.freeze({
  company_truck: 'company truck',
  investor_truck: "investor's truck",
  vendor_truck: "vendor's truck",
  lease_to_rent: 'lease to rent',
  lease_to_own: 'lease to own',
  own_truck: 'own truck',
});

const UNIT_WITH_LETTER = /^#?\s*(\d+[A-Z])(?:\s+(.*))?$/i;
const UNIT_THEN_SUFFIX = /^#?\s*(\d+)\s*(.*)$/;

/**
 * @param {*} value  the board's truck text, e.g. `021 CMP`
 * @returns {{unit: string|null, suffix: string|null}}
 */
function splitBoardTruck(value) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!text) return { unit: null, suffix: null };
  const match = UNIT_WITH_LETTER.exec(text) || UNIT_THEN_SUFFIX.exec(text);
  if (!match) return { unit: text, suffix: null };
  const suffix = String(match[2] || '').trim().toUpperCase();
  return { unit: match[1].toUpperCase(), suffix: suffix || null };
}

/**
 * The owner's mapping above, with the shade of each fleet.
 * `(Polvan)` is read as `POLVAN`: brackets around a name are not a fleet word.
 */
function describeTruckSuffix(suffix) {
  const word = String(suffix == null ? '' : suffix).replace(/[()[\]]/g, ' ').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!word) return OWN_TRUCK;
  if (SUFFIXES[word]) return SUFFIXES[word];
  if (/^[A-Z][A-Z .'-]*$/.test(word)) return OWN_TRUCK;
  return UNREADABLE;
}

function fleetTypeFromTruckSuffix(suffix) {
  return describeTruckSuffix(suffix).fleetType;
}

/** Both at once: what a new-board truck says about unit and fleet. */
function readBoardTruck(value) {
  const { unit, suffix } = splitBoardTruck(value);
  const numeric = unit !== null && /^\d+[A-Z]?$/.test(unit);
  const meaning = numeric ? describeTruckSuffix(suffix) : UNREADABLE;
  return { unit, suffix, fleetType: meaning.fleetType, detail: meaning.detail };
}

module.exports = {
  splitBoardTruck,
  describeTruckSuffix,
  fleetTypeFromTruckSuffix,
  readBoardTruck,
  DETAIL_LABELS,
};
