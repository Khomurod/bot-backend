'use strict';

/**
 * Closing a home stay when the driver goes back on the road. Moved out of
 * services/homeTimeService.js, which re-exports it; `applyStateTransition`
 * there is the only caller that moves the state, and it closes the stay
 * itself rather than trusting every caller to remember (the seam that once
 * left 74 open cycles in production).
 */

const { DateTime } = require('luxon');
const ht = require('../../database/homeTime');
const { wholeDaysBetween } = require('../homeTimeConstants');
const { foldIfBrief } = require('./briefVisits');

/**
 * Stamp the actual return-to-road time and the whole home days onto one open
 * stay, and link the decided home-time request that authorized it (for the
 * approved-exception classification).
 */
async function closeOneStay(group, open, returnToRoadIso, provenance = {}) {
  const homeDays = wholeDaysBetween(open.home_arrived_at, returnToRoadIso);
  let linkedRequestId = open.linked_request_id || null;
  if (!linkedRequestId) {
    const homeArrivedDate = DateTime.fromJSDate(new Date(open.home_arrived_at)).toISODate();
    // The request is looked up on the chat the stay BEGAN on — that is where it
    // was asked and decided, even when the return is observed on a new chat.
    const decided = await ht.findDecidedRequestNearDate(open.group_id || group.id, homeArrivedDate).catch(() => null);
    if (decided) linkedRequestId = decided.id;
  }
  return ht.closeHomeStay(open.id, {
    returnToRoadAt: returnToRoadIso, homeDays, linkedRequestId,
    closedBy: provenance.closedBy || null,
    closedEvidence: provenance.closedEvidence || null,
  });
}

/** Every open stay of this driver, on any of their chats, closed at one observed moment. Best effort. */
async function closeLingeringHomeStays(group, { returnToRoadIso, ...provenance } = {}) {
  try {
    const open = await ht.listOpenHomeStays(group.id);
    let closed = 0;
    for (const stay of open) {
      if (!stay.home_arrived_at) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await closeOneStay(group, stay, returnToRoadIso, provenance)) closed += 1;
    }
    return closed;
  } catch (err) {
    console.error('[HOME-TIME] closeLingeringHomeStays error:', err.message);
    return 0;
  }
}

/**
 * Close the open home stay when a driver goes back on the road (home→road),
 * and retire any open clarification flow for the group. Best effort; never
 * throws.
 *
 * `foldBrief`: a stay under 12 hours is folded into the road trip it
 * interrupted instead (services/homeTime/briefVisits.js), and the returned
 * row carries `folded_at` so the caller can carry the road clock on.
 *
 * @returns {object|null} the closed (or folded) road-history row, or null
 */
async function closeHomeStayOnReturn(group, { returnToRoadIso, foldBrief = false, ...provenance } = {}) {
  try {
    if (!group || !returnToRoadIso) return null;
    // Newest open stay of this DRIVER — the person's, not only the chat's, so a
    // return observed on a new truck's chat closes the stay begun on the old one.
    const [open] = await ht.listOpenHomeStays(group.id);
    let closed = null;
    if (open && open.home_arrived_at) {
      if (foldBrief) closed = await foldIfBrief(open, returnToRoadIso, provenance);
      if (!closed) closed = await closeOneStay(group, open, returnToRoadIso, provenance);
    }
    // The home window is over → retire any clarification still waiting on dates and
    // stop its reminders (spec §11: stop when the driver returns to the road) —
    // on this chat, and on the chat the stay BEGAN on when that was another one:
    // the question was asked there, and it is as finished as one asked here.
    const chats = new Set([group.id]);
    if (open?.group_id != null) chats.add(open.group_id);
    for (const chatId of chats) {
      // eslint-disable-next-line no-await-in-loop
      await ht.expireOpenClarificationsForGroup(chatId, {
        reason: 'Driver returned to the road; clarification no longer needed.',
      }).catch(() => {});
    }
    // The CLOSED row, so the caller can report the measured days at home. Falls
    // back to the pre-close row when the close itself found nothing to update.
    return closed || open || null;
  } catch (err) {
    console.error('[HOME-TIME] closeHomeStayOnReturn error:', err.message);
    return null;
  }
}

module.exports = { closeOneStay, closeLingeringHomeStays, closeHomeStayOnReturn };
