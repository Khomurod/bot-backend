'use strict';

/**
 * Brief visits and how Home Time counts days (owner, 27 November 2026). PURE.
 *
 * THE RULE. A visit home shorter than 12 hours is not going home, and a few
 * hours on the road between two home stays is not a road trip. The Dispatcher
 * Board flips HOME and back for reasons that have nothing to do with a driver's
 * week — a dispatcher fixing a row, a truck parked at the yard for an hour —
 * and in the 30 days to 27 November 15 of 53 company-driver home stays lasted
 * under 12 hours. Each one cut a road trip in two: the extra weeks were split,
 * the bonus was decided on a home stay of 0 days, and accounting was told the
 * next trip "came home early after 0 days on the road".
 *
 *   a home stay under MIN_STAY_HOURS is FOLDED into the road trip it
 *     interrupted: the road clock goes on from the trip's start, and the next
 *     real arrival records the whole trip, with its whole bonus;
 *   a road segment under MIN_STAY_HOURS between two home stays REOPENS the
 *     first stay: one stay, its days counted from the first arrival.
 *
 * Applied where the record is written (services/homeTime/briefVisits.js) and
 * again where accounting's verdicts are read (lib/homeTime/ownViolations.js),
 * so a record written before the rule, or by a path that cannot fold, is
 * judged the same way.
 *
 * ONE WAY TO COUNT DAYS. `wholeDays` is complete 24-hour periods. The bonus's
 * "home more than 4 days", accounting's "overstayed", the road days and the
 * managers' notices all count with it, so the bonus and the fine can never
 * disagree about the same stay. It used to be counted twice — once in calendar
 * days in the process's time zone, once in 24-hour periods — and the two
 * differed by a day across a daylight-saving change.
 */

const MIN_STAY_HOURS = 12;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Two recorded moments this close are the same moment (rounding in storage). */
const SAME_MOMENT_MS = 60 * 1000;

function toMs(value) {
  if (value == null || value === '') return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  // A luxon DateTime, without requiring luxon here.
  if (typeof value.toMillis === 'function') return value.toMillis();
  return new Date(value).getTime();
}

/** Complete 24-hour periods from `from` to `to`, never negative; null when either is unreadable. */
function wholeDays(from, to) {
  const a = toMs(from);
  const b = toMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / DAY_MS));
}

/** `from` → `to` is a real, non-negative span shorter than MIN_STAY_HOURS. */
function isBrief(from, to) {
  const a = toMs(from);
  const b = toMs(to);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a < MIN_STAY_HOURS * HOUR_MS;
}

function sameMoment(a, b) {
  const x = toMs(a);
  const y = toMs(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= SAME_MOMENT_MS;
}

/** "40 min" / "3.5 h" — a manager reads it on a phone. */
function durationLabel(from, to) {
  const span = toMs(to) - toMs(from);
  if (!Number.isFinite(span) || span < 0) return null;
  const minutes = Math.round(span / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round((span / HOUR_MS) * 10) / 10;
  return `${hours} h`;
}

/** The bonus on this row has not been posted or decided, so the row may still change. */
function bonusStillOpen(row) {
  if (!(Number(row?.bonus_usd) > 0)) return true;
  return row.bonus_posted_at == null
    && (row.bonus_decision == null || row.bonus_decision === 'waiting_home_stay');
}

/**
 * Going back on the road: is the stay that ends here too short to be one?
 *
 * @param {object} stay  the open `driver_road_history` row
 * @param {string|Date} returnAt
 */
function shouldFold(stay, returnAt) {
  return Boolean(stay && stay.road_started_at && stay.home_arrived_at
    && stay.return_to_road_at == null && stay.folded_at == null
    && isBrief(stay.home_arrived_at, returnAt) && bonusStillOpen(stay));
}

/**
 * Coming home: was the road segment that ends here too short to be a trip, so
 * the stay before it goes on?
 *
 * @param {object|null} lastStay  this driver's newest closed, unfolded stay
 * @param {object} p
 * @param {string|Date} p.roadSince  when the current road state began
 * @param {string|Date} p.arrivedAt  this arrival
 */
function shouldReopen(lastStay, { roadSince, arrivedAt }) {
  return Boolean(lastStay && lastStay.home_arrived_at && lastStay.return_to_road_at
    && lastStay.folded_at == null
    // The road state began when THAT stay closed. Anything else — a state an
    // admin set, a first observation — is not "the stay before this one".
    && sameMoment(lastStay.return_to_road_at, roadSince)
    && isBrief(roadSince, arrivedAt) && bonusStillOpen(lastStay));
}

function shortDay(value) {
  const t = toMs(value);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '?';
}

/** Why a stay was folded, with the figures it held, for the row and for a person. */
function foldReason(stay, returnAt) {
  const bonus = Number(stay.bonus_usd) > 0
    ? ` It had recorded ${stay.days_on_road} day(s) on the road and a $${Number(stay.bonus_usd).toFixed(0)} bonus; `
      + 'the trip continues, so both are counted when the driver really gets home.'
    : '';
  return `Home only ${durationLabel(stay.home_arrived_at, returnAt) || 'briefly'} `
    + `(under ${MIN_STAY_HOURS} hours), so not a home stay: the road trip from `
    + `${shortDay(stay.road_started_at)} continues.${bonus}`;
}

/** The short road segment a reopen undid, in words. */
function reopenNote(lastStay, arrivedAt) {
  return `On the road only ${durationLabel(lastStay.return_to_road_at, arrivedAt) || 'briefly'} `
    + `(${shortDay(lastStay.return_to_road_at)}), under ${MIN_STAY_HOURS} hours, so not a trip: `
    + `the home stay from ${shortDay(lastStay.home_arrived_at)} continues.`;
}

module.exports = {
  MIN_STAY_HOURS,
  HOUR_MS,
  DAY_MS,
  toMs,
  wholeDays,
  isBrief,
  sameMoment,
  durationLabel,
  bonusStillOpen,
  shouldFold,
  shouldReopen,
  foldReason,
  reopenNote,
};
