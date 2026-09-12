'use strict';

/**
 * A stable name for a Dispatcher Board row.
 *
 * The Board is a spreadsheet. Its `row` field is a POSITION, not an identity:
 * insert a line above and every row below it gets a new number while nothing
 * about those drivers changed. Keying the snapshot on the position would make
 * one inserted line look like the whole fleet being replaced.
 *
 * So a row is named by what it is about — the truck and the person — through the
 * same normalizers the rest of the application already uses, so a Board row and
 * a Telegram group title reduce the same way:
 *
 *     <exact truck key>|<normalized person name>
 *
 * The EXACT truck key is deliberate (see `./truck.js`): `001` and `1` are
 * different trucks, and a key that confused them would move a snapshot row from
 * one driver to another silently.
 *
 * A team row is named by both people, sorted, so "A / B" and "B / A" are one
 * row rather than two. Sorting is what makes the name stable when a dispatcher
 * retypes the pair in the other order.
 */
const { normalizePersonName } = require('../drivers/driverGroupTitle');
const { normalizeBoardTruck } = require('./truck');

/** The person half: one name, or a sorted pair for a team. */
function personKeyPart(cleanName, members) {
  const list = Array.isArray(members) && members.length
    ? members
    : [cleanName];
  const normalized = list
    .map((name) => normalizePersonName(name || ''))
    .filter(Boolean)
    .sort();
  return normalized.join('+');
}

/**
 * @param {object} row  a parsed Board row (`./parse.js`)
 * @returns {string|null} null when the row names neither a truck nor a person,
 *   which is a row that cannot be tracked and is reported as a problem instead
 */
function boardRowKey(row) {
  const truck = normalizeBoardTruck(row?.truckRaw ?? row?.truck ?? '');
  const person = personKeyPart(row?.cleanName ?? row?.driverName ?? '', row?.teamMembers);
  if (!truck && !person) return null;
  return `${truck || '?'}|${person || '?'}`;
}

module.exports = { boardRowKey, personKeyPart };
