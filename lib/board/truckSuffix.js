'use strict';

/**
 * The new Board's truck column: a unit number, then who the truck is run by.
 * PURE.
 *
 * Since November 2026 the board is a service of its own
 * (`board.wenzellc.com/api/public/v1/board`), and it no longer writes the fleet
 * inside the driver's name. It writes it after the unit number, in the truck
 * column: `021 CMP`, `003 CPM`, `001 V`, `310 JAVLON`, `127 L`, `045`. The
 * owner's reading of those suffixes (4 November 2026):
 *
 *   COMP, CPM, CMP, V, a driver's name   company
 *   R (a rental truck)                   company
 *   L                                    lease
 *   nothing after the number             owner-operator — as on the old board,
 *                                        where no label meant owner-operator
 *
 * The UNIT is the number alone, with its leading zeros: `021 CMP` is unit
 * `021`, the same spelling Wenze's groups and people carry. The suffix is a
 * fleet, not part of the truck's name — keeping it would make every unit look
 * unknown to the exact comparison in `./truck.js`.
 *
 * Anything that does not start with a number is left whole and its fleet is
 * `unknown`: `unknown` never wins a match, so an unreadable truck is a question,
 * never a merge.
 */
const { FLEET_TYPES } = require('../drivers/fleetType');

const LEASE_SUFFIXES = Object.freeze(['L', 'LEASE']);

/**
 * @param {*} value  the board's truck text, e.g. `021 CMP`
 * @returns {{unit: string|null, suffix: string|null}}
 */
function splitBoardTruck(value) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!text) return { unit: null, suffix: null };
  const match = /^#?\s*(\d+)\s*(.*)$/.exec(text);
  if (!match) return { unit: text, suffix: null };
  const suffix = match[2].trim().toUpperCase();
  return { unit: match[1], suffix: suffix || null };
}

/** The owner's mapping above. A suffix with a digit in it is not a fleet word. */
function fleetTypeFromTruckSuffix(suffix) {
  if (suffix == null || String(suffix).trim() === '') return FLEET_TYPES.OWNER_OPERATOR;
  const word = String(suffix).trim().toUpperCase();
  if (LEASE_SUFFIXES.includes(word)) return FLEET_TYPES.LEASE;
  if (/^[A-Z][A-Z .'-]*$/.test(word)) return FLEET_TYPES.COMPANY;
  return FLEET_TYPES.UNKNOWN;
}

/** Both at once: what a new-board truck says about unit and fleet. */
function readBoardTruck(value) {
  const { unit, suffix } = splitBoardTruck(value);
  const numeric = unit !== null && /^\d+$/.test(unit);
  return {
    unit,
    suffix,
    fleetType: numeric ? fleetTypeFromTruckSuffix(suffix) : FLEET_TYPES.UNKNOWN,
  };
}

module.exports = { splitBoardTruck, fleetTypeFromTruckSuffix, readBoardTruck };
