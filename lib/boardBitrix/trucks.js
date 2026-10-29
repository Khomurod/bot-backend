'use strict';

/**
 * A truck number out of a Bitrix "Trucks" title, and whether two numbers name
 * the same truck. PURE.
 *
 * Bitrix has no unit-number field: the number is somewhere in the title, and
 * the titles are typed by hand — "Trucks #001", "Truck# 003", "Truck # 022",
 * "Unit# 888", "008", "Trucks #007 (USMON)". Leading zeros are KEPT, as the
 * Board keeps them (lib/board/truck.js): Company 001 and Lease 001 are two
 * trucks, and the fleet that tells them apart comes from the DRIVER's deal,
 * because the truck's own ownership field is often wrong.
 *
 * A title with two numbers in it and no "#" to say which is the truck is
 * unreadable — null, never a guess.
 */

const { normalizeBoardTruck } = require('../board/truck');

function truckNumberFromTitle(title) {
  const text = String(title || '').toUpperCase().replace(/\([^)]*\)/g, ' ');
  const hashed = text.match(/#\s*(\d+[A-Z]?)\b/);
  if (hashed) return normalizeBoardTruck(hashed[1]);
  const named = text.match(/\b(?:UNIT|TRUCKS?)\s*(?:NO\.?\s*)?(\d+[A-Z]?)\b/);
  if (named) return normalizeBoardTruck(named[1]);
  const numbers = text.match(/\b\d+[A-Z]?\b/g) || [];
  return numbers.length === 1 ? normalizeBoardTruck(numbers[0]) : null;
}

/**
 * The same truck number? Exact, or the same digits when NEITHER carries a
 * letter: "001" and "1" are one truck written two ways; "001" and "001A" are
 * two trucks.
 */
function sameTruckNumber(a, b) {
  const left = normalizeBoardTruck(a);
  const right = normalizeBoardTruck(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return left.replace(/^0+(?=\d)/, '') === right.replace(/^0+(?=\d)/, '');
  }
  return false;
}

module.exports = { truckNumberFromTitle, sameTruckNumber };
