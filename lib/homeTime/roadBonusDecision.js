/**
 * Whether a completed road leg's extra-week bonus may be paid. PURE — no I/O.
 *
 * THE OWNER'S RULE (2026-10-06), in the order it is applied:
 *
 *   1. NOTHING IS DECIDED WHILE THE DRIVER IS HOME. The bonus is paid after
 *      the home stay, because the home stay is part of what it pays for.
 *
 *   2. HOME LONGER THAN THE ALLOWANCE MEANS NO BONUS. The allowance is
 *      `home_time_settings.home_allowance_days` (4). Staying longer breaks
 *      the arrangement, and the bonus is forfeited outright — not reduced.
 *      Counted in whole days, the same way `home_days` and the efficiency
 *      report count it, so the two can never disagree about who was over.
 *
 *   3. A TRIP LONGER THAN SIX WEEKS IS CHECKED BY A PERSON. An inflated road
 *      clock — one nobody reset when the driver went home unseen — produces
 *      exactly this: production reported 117 days and $1,200. A long trip is
 *      sometimes real, so it is held, never refused.
 *
 *   4. Otherwise it is released and the summary is posted.
 *
 * A leg whose home stay closed without a measured length cannot be checked
 * against rule 2, so it goes to a person too — never released on a guess.
 */

const DECISIONS = Object.freeze({
  WAITING: 'waiting_home_stay',
  RELEASED: 'released',
  REVIEW: 'needs_review',
  FORFEITED: 'forfeited',
});

/** Rule 3. Owner-chosen; longer than this and a person looks first. */
const REVIEW_AFTER_WEEKS = 6;
const DEFAULT_HOME_ALLOWANCE_DAYS = 4;

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * @param {object} leg  a `driver_road_history` row
 * @param {object} [opts]
 * @param {number} [opts.homeAllowanceDays]
 * @param {number} [opts.reviewAfterWeeks]
 * @returns {{decision:string, reason:string|null}|null} null when the leg
 *   carries no bonus and there is nothing to decide.
 */
function decideRoadBonus(leg, {
  homeAllowanceDays = DEFAULT_HOME_ALLOWANCE_DAYS,
  reviewAfterWeeks = REVIEW_AFTER_WEEKS,
} = {}) {
  if (!leg || !(Number(leg.bonus_usd) > 0)) return null;
  if (!leg.return_to_road_at) return { decision: DECISIONS.WAITING, reason: null };

  const allowance = Number.isFinite(Number(homeAllowanceDays)) && homeAllowanceDays !== null
    ? Number(homeAllowanceDays) : DEFAULT_HOME_ALLOWANCE_DAYS;
  const homeDays = leg.home_days == null ? null : Number(leg.home_days);
  if (homeDays == null || !Number.isFinite(homeDays)) {
    return {
      decision: DECISIONS.REVIEW,
      reason: 'the length of the home stay was not recorded, so the home-time rule cannot be checked',
    };
  }
  if (homeDays > allowance) {
    return {
      decision: DECISIONS.FORFEITED,
      reason: `stayed home ${plural(homeDays, 'day')}; the limit is ${plural(allowance, 'day')}`,
    };
  }
  const daysOnRoad = Number(leg.days_on_road) || 0;
  if (daysOnRoad > reviewAfterWeeks * 7) {
    return {
      decision: DECISIONS.REVIEW,
      reason: `${plural(daysOnRoad, 'day')} on the road is longer than ${reviewAfterWeeks} weeks — `
        + 'check the trip really was that long before paying',
    };
  }
  return { decision: DECISIONS.RELEASED, reason: null };
}

module.exports = {
  DECISIONS, REVIEW_AFTER_WEEKS, DEFAULT_HOME_ALLOWANCE_DAYS, decideRoadBonus,
};
