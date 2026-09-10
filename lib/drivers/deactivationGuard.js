/**
 * "Is this driver actually working?" — the question a model reading a chat
 * title cannot answer, asked of the records instead. PURE.
 *
 * Twice a day a model reads every driver group's TITLE and decides whether that
 * person still works here, and the answer is written straight to `groups.active`
 * for 168 of 209 groups. Deactivating a working driver is not a cosmetic error:
 * an inactive group drops out of Live Locations, out of BOL/POD document
 * routing, out of the dispatch roster and out of home-time tracking. A renamed
 * chat, an unusual spelling or a title in Cyrillic is enough to cause it.
 *
 * So a deactivation now needs more than a title. This function looks at what
 * the driver has actually been DOING — from records the application already
 * keeps, no extra API call — and refuses the deactivation when any of it says
 * they are working. It never blocks the opposite direction: marking a driver
 * ACTIVE again is safe by construction, and is what an operator wants when a
 * title is fixed.
 *
 * ACTIVITY IS EVIDENCE OF WORK, SILENCE IS NOT EVIDENCE OF LEAVING. A driver
 * with no signals at all is not protected here — a genuinely departed driver
 * goes quiet, and `identity.silent_active_group` already raises the ones who
 * merely went quiet for a human to look at.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How recent a signal has to be to mean "still working". */
const DEFAULTS = Object.freeze({
  messageDays: 21,
  homeTimeDays: 30,
  unitDays: 45,
});

function daysAgo(value, nowMs) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / DAY_MS;
}

/**
 * @param {object} signals
 *   lastMessageSeenAt   groups.last_message_seen_at — the chat is alive
 *   homeStatusAt        driver_home_status.last_status_at — being tracked
 *   openHomeCycle       an unfinished home-time cycle
 *   lastRoadHistoryAt   the most recent completed leg
 *   openUnitAt          driver_units — a truck currently assigned to them
 *   hasActiveLoad       Datatruck says they are working a load right now
 * @returns {{allowed: boolean, reasons: string[]}} `allowed: false` means DO NOT
 *   deactivate, with the reasons in plain words for the log and the finding.
 */
function mayDeactivate(signals = {}, { now = Date.now(), options = {} } = {}) {
  const opts = { ...DEFAULTS, ...options };
  const reasons = [];

  const messageDays = daysAgo(signals.lastMessageSeenAt, now);
  if (messageDays != null && messageDays <= opts.messageDays) {
    reasons.push(`the chat had a message ${Math.round(messageDays)} day(s) ago`);
  }
  const statusDays = daysAgo(signals.homeStatusAt, now);
  if (statusDays != null && statusDays <= opts.homeTimeDays) {
    reasons.push(`home-time tracking saw them ${Math.round(statusDays)} day(s) ago`);
  }
  if (signals.openHomeCycle) reasons.push('they have an open home-time cycle');
  const legDays = daysAgo(signals.lastRoadHistoryAt, now);
  if (legDays != null && legDays <= opts.homeTimeDays) {
    reasons.push(`they finished a road leg ${Math.round(legDays)} day(s) ago`);
  }
  const unitDays = daysAgo(signals.openUnitAt, now);
  if (unitDays != null && unitDays <= opts.unitDays) {
    reasons.push('a truck is currently assigned to them');
  }
  if (signals.hasActiveLoad) reasons.push('they are working a load right now');

  return { allowed: reasons.length === 0, reasons };
}

/** One sentence for the log and the finding. */
function describeRefusal(label, reasons) {
  return `${label} was NOT deactivated: ${reasons.join('; ')}.`;
}

module.exports = { DEFAULTS, mayDeactivate, describeRefusal };
