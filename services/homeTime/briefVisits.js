'use strict';

/**
 * The 12-hour rule, applied where the home/road record is written (owner,
 * 27 November 2026; the rule itself is lib/homeTime/briefVisits.js):
 *
 *   going back on the road from a stay under 12 hours  → FOLD the stay: the
 *     road trip it interrupted goes on, and the driver's road clock with it
 *   coming home under 12 hours after leaving a stay    → REOPEN that stay:
 *     one stay, counted from the first arrival
 *
 * Both are best effort and both are guarded writes: whatever goes wrong, or
 * whoever moved the row first, the caller records the transition the ordinary
 * way, which is exactly what it did before this rule existed. Nothing here
 * sends anything; the caller tells the managers.
 */

const ht = require('../../database/homeTime');
const {
  isBrief, shouldFold, shouldReopen, foldReason, reopenNote, durationLabel, toMs,
} = require('../../lib/homeTime/briefVisits');

function isoOf(value) {
  const t = toMs(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * @param {object} stay  the open `driver_road_history` row the return closes
 * @returns {Promise<object|null>} the folded row, or null when it is not brief
 *   (or could not be folded) and must be closed the ordinary way
 */
async function foldIfBrief(stay, returnToRoadIso, { closedBy = null, closedEvidence = null } = {}) {
  if (!shouldFold(stay, returnToRoadIso)) return null;
  try {
    const folded = await ht.foldHomeStay(stay.id, {
      returnToRoadAt: returnToRoadIso,
      reason: foldReason(stay, returnToRoadIso),
      closedBy,
      closedEvidence,
    });
    if (folded) {
      console.log(`[HOME-TIME] Stay #${stay.id} lasted ${durationLabel(stay.home_arrived_at, returnToRoadIso)} `
        + '- under 12 hours, folded into the road trip it interrupted.');
    }
    return folded;
  } catch (err) {
    console.warn(`[HOME-TIME] could not fold brief stay #${stay.id}:`, err.message);
    return null;
  }
}

/**
 * @param {object} group    groups row
 * @param {object} current  `driver_home_status` row, on the road
 * @param {string} arrivedAtIso
 * @returns {Promise<object|null>} the reopened stay, or null to record a new one
 */
async function reopenIfBriefRoad(group, current, arrivedAtIso) {
  try {
    if (!current || current.state !== 'road' || !isBrief(current.state_since, arrivedAtIso)) return null;
    // Anything still open is the ordinary path's to close first; reopening
    // beside it would leave this driver two open stays.
    const open = await ht.listOpenHomeStays(group.id);
    if (open.length) return null;
    const last = await ht.getLastClosedHomeStay(group.id);
    if (!shouldReopen(last, { roadSince: current.state_since, arrivedAt: arrivedAtIso })) return null;
    const reopened = await ht.reopenHomeStay(last.id, {
      expectedReturnAt: last.return_to_road_at,
      arrivedAgainAt: arrivedAtIso,
      note: reopenNote(last, arrivedAtIso),
    });
    if (reopened) {
      console.log(`[HOME-TIME] Back home ${durationLabel(last.return_to_road_at, arrivedAtIso)} after leaving `
        + `- under 12 hours, stay #${last.id} reopened.`);
    }
    return reopened;
  } catch (err) {
    console.warn(`[HOME-TIME] could not check a brief road segment for group ${group?.id}:`, err.message);
    return null;
  }
}

/** One line for the managers' notice about a folded stay. */
function foldNoticeLine(folded) {
  if (!folded?.folded_at) return null;
  const stop = durationLabel(folded.home_arrived_at, folded.return_to_road_at);
  const since = isoOf(folded.road_started_at);
  return `Short stop${stop ? ` (${stop})` : ''}, under 12 hours: not counted as home time.`
    + `${since ? ` The road trip from ${since.slice(0, 10)} continues.` : ''}`;
}

module.exports = {
  isoOf, foldIfBrief, reopenIfBriefRoad, foldNoticeLine,
};
