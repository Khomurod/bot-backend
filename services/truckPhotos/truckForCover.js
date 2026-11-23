'use strict';

/**
 * The truck number a hand-over PDF's cover names (lib/truckPhotos/truckNumber.js
 * is the rule): the chat title's, checked against the profile and the
 * Dispatcher Board — or, once a person has corrected it, THEIR number, said to
 * be theirs ("set by Kim Rowe"), with the profile no longer second-guessing it.
 *
 * A Board that cannot be read is checked against nothing — never a failed
 * report.
 */

const { decideTruckNumber, boardTrucksNaming } = require('../../lib/truckPhotos/truckNumber');
const { extractUnitFromGroupName } = require('../../lib/drivers/driverGroupTitle');
const { sameUnitNumber } = require('../../lib/drivers/unitNumber');

/**
 * @param {{profile: object|null, groupName: string|null, edits?: object}} args
 * @param {{readBoardTrucks: Function}} deps
 */
async function truckForCover({ profile, groupName, edits = {} }, deps) {
  if (edits?.unit) {
    return {
      unit: edits.unit,
      source: 'person',
      matchesProfile: sameUnitNumber(profile?.unit_number, edits.unit),
      check: [],
      note: edits.unitBy ? `set by ${edits.unitBy}` : 'set by hand',
    };
  }
  let boardTrucks = [];
  try {
    boardTrucks = boardTrucksNaming(await deps.readBoardTrucks(), profile);
  } catch (err) {
    console.warn('[TRUCK PHOTOS] could not read the Dispatcher Board for the truck number:', err?.message || String(err));
  }
  return decideTruckNumber({
    profileUnit: profile?.unit_number ?? null,
    titleUnit: extractUnitFromGroupName(groupName || ''),
    boardTrucks,
  });
}

module.exports = { truckForCover };
