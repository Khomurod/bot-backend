'use strict';

/**
 * Which truck number a hand-over PDF names, and when to say "please check".
 * Pure.
 *
 * WHY (the owner, 23 November 2026). Two PDFs named the wrong truck — 088 for
 * 027, 326 for 327. The number came from the driver's profile, and a profile is
 * seeded from the chat's title the first time Wenze sees the chat
 * (database/driverProfiles.js `ensureDefaultProfileForGroup`) and never follows
 * a rename: both chats were created with one number and renamed minutes later.
 * The title is what people keep up to date, and Samsara's safety routing reads
 * it too.
 *
 * THE RULE:
 *   1. The chat title's number, when it has one.
 *   2. Except when the profile says the same number with a letter after it —
 *      "001A" for a title read as "001" (the title reader keeps digits only,
 *      lib/drivers/driverGroupTitle.js), the profile is the fuller spelling of
 *      the same truck.
 *   3. No number in the title: the profile's. Neither: the Dispatcher Board's,
 *      when it names this driver on exactly one truck.
 *
 * Whatever is chosen, a source that disagrees is NAMED on the cover — "profile
 * says 326", "Board says 3731 V" — with "please check". This never changes the
 * profile; a person does that (Needs Attention, `identity.unit_title_mismatch`).
 */

const { namesAgreeStrictly } = require('../identity/boardResolution');
const { unitKey: key, isFullerSpelling, sameUnitNumber: sameNumber } = require('../drivers/unitNumber');

/**
 * @param {object} args
 * @param {string|null} [args.profileUnit]  driver_profiles.unit_number
 * @param {string|null} [args.titleUnit]    the number in the chat's title
 * @param {Array<{unit: string, raw?: string}>} [args.boardTrucks]
 *   the present Dispatcher Board lines that name this driver (strict name match)
 * @returns {{unit: string|null, source: 'title'|'profile'|'board'|null,
 *   matchesProfile: boolean, check: string[]}}
 *   `check` names every source that says something else (empty when all agree)
 */
function decideTruckNumber({ profileUnit = null, titleUnit = null, boardTrucks = [] } = {}) {
  const profile = key(profileUnit) || null;
  const title = key(titleUnit) || null;
  const board = (Array.isArray(boardTrucks) ? boardTrucks : []).filter((b) => key(b?.unit));

  let unit = null;
  let source = null;
  if (title && profile && isFullerSpelling(profile, title)) { unit = profile; source = 'profile'; }
  else if (title) { unit = title; source = 'title'; }
  else if (profile) { unit = profile; source = 'profile'; }
  else if (board.length === 1) { unit = key(board[0].unit); source = 'board'; }

  const check = [];
  if (unit && profile && !sameNumber(profile, unit)) check.push(`profile says ${profile}`);
  if (unit && board.length && !board.some((b) => sameNumber(b.unit, unit))) {
    check.push(`Board says ${board.map((b) => String(b.raw || b.unit).trim()).join(' / ')}`);
  }
  return {
    unit, source, matchesProfile: Boolean(unit) && sameNumber(profile, unit), check,
  };
}

/** The driver's names on a profile: the driver, and a team's second driver. */
function profileNames(profile) {
  return [
    [profile?.first_name, profile?.last_name],
    [profile?.secondary_first_name, profile?.secondary_last_name],
  ].map((parts) => parts.filter(Boolean).join(' ').trim()).filter(Boolean);
}

/**
 * The present Board lines that name this driver — by the board match's STRICT
 * name rule (a shared surname is not enough), never by truck number.
 *
 * @param {Array<{truck_norm, truck_raw, driver_name_clean, team_members}>} rows
 * @param {object|null} profile
 * @returns {Array<{unit: string, raw: string}>}
 */
function boardTrucksNaming(rows, profile) {
  const names = profileNames(profile);
  if (!names.length) return [];
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const team = Array.isArray(row?.team_members) ? row.team_members.filter(Boolean) : [];
    const onBoard = team.length ? team : [row?.driver_name_clean].filter(Boolean);
    if (!key(row?.truck_norm)) continue;
    if (onBoard.some((b) => names.some((n) => namesAgreeStrictly(b, n)))) {
      out.push({ unit: key(row.truck_norm), raw: String(row.truck_raw || row.truck_norm).trim() });
    }
  }
  return out;
}

module.exports = { decideTruckNumber, boardTrucksNaming };
