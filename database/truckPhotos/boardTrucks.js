'use strict';

/**
 * The Dispatcher Board's present lines, as much as a hand-over PDF needs to
 * check its truck number against the board (lib/truckPhotos/truckNumber.js):
 * the truck and who drives it. Read once per report — reports are a handful a
 * day — and the board is about a hundred lines.
 *
 * A table that does not exist yet (42P01) reads as "no board": the PDF then
 * checks against the title and the profile alone.
 */

const { query } = require('../pool');

const UNDEFINED_TABLE = '42P01';

/** @returns {Promise<Array<{truck_norm, truck_raw, driver_name_clean, team_members}>>} */
async function readPresentBoardTrucks() {
  try {
    const { rows } = await query(
      `SELECT truck_norm, truck_raw, driver_name_clean, team_members
         FROM dispatch_board_rows
        WHERE present = TRUE`,
    );
    return rows;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

module.exports = { readPresentBoardTrucks };
