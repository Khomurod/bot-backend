'use strict';

/**
 * Checks whose feature was removed. They find nothing, ever.
 *
 * A finding is resolved by a sweep that COMPLETES the module owning its key
 * and does not file it again. Deleting a check with its feature would leave
 * every finding it had filed open for ever, under a key nothing owns — on the
 * Needs Attention page, on the Groups page's Needs Review tab, and in the
 * questions Wenze asks in Telegram. Listing the keys here lets the next sweep
 * close them.
 *
 * Nothing new is ever filed under these keys, so once production has swept a
 * few times this list could go. It costs nothing to keep.
 */

const RETIRED_CHECK_KEYS = Object.freeze([
  // Route Control, removed October 2026.
  'route_control.assignment_on_inactive_group',
  // The Dispatcher Board's identity checks, removed October 2026. The Board
  // itself stays, read only for Home Time's home-in/home-out.
  'board.unknown_fleet_label',
  'board.duplicate_row_key',
  'board.fleet_label_typo',
  'board.unknown_status',
  'board.team_flag_mismatch',
  'board.truck_on_multiple_rows',
  'board.row_vanished',
  'board.person_link',
  'board.person_link_suggested',
  'board.person_link_conflict',
  'board.person_link_ambiguous',
  'board.person_unmatched',
  'board.team_person_needs_split',
  'board.truck_disagrees_with_profile',
  // The contradiction pass's board comparisons, removed with them. That pass
  // resolves only the keys it still owns, so these two close here.
  'context.board_home_while_road',
  'context.wenze_home_while_board_working',
  // The fuel monitor, removed October 2026.
  'fuel.watch_on_inactive_group',
  // The driver-raise review and its dispatch teams, removed October 2026.
  'raise.driver_unplaced',
  'raise.roster_not_rebuilt',
  'dispatch.team_driver_on_inactive_group',
  // A one-time copy (migration 0016) of the old duplicate-unit scan. Owned by
  // nothing, last seen September 2026, and superseded by the fleet-aware
  // identity.duplicate_unit — they would otherwise stay open for ever.
  'legacy.duplicate_unit',
  'legacy.name_mismatch',
  'legacy.ambiguous_match',
  // "Still tracked but the group is inactive": 63 open rows, deliberately with
  // no action, so nobody could ever close one (October 2026). An inactive
  // group's last home/road row is history, not a problem.
  'home_time.ghost_home_status',
]);

function runRetiredChecks() {
  return [];
}

module.exports = { CHECK_KEYS: RETIRED_CHECK_KEYS, runRetiredChecks };
