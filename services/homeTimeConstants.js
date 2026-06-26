/**
 * Driver Home-Time Tracking — constants and pure helpers.
 *
 * The bot reads each driver group's messages. The "update specialist" posts:
 *   - "Status: Home"                  → the driver is HOME
 *   - "Status: Ready" / "Status: Rolling" (or "ready to roll") → the driver is
 *     ON THE ROAD
 *
 * Drivers get a number of weeks on the road for free (default 4). Each FULL
 * extra week beyond that earns a fixed bonus (default $100). The allowance
 * resets every time the driver goes home.
 *
 * Everything here is side-effect free so it can be unit-tested without a
 * network or database.
 */
const { DateTime } = require('luxon');

const DEFAULT_ROAD_ALLOWANCE_WEEKS = 4;
const DEFAULT_HOME_ALLOWANCE_DAYS = 4;
const DEFAULT_BONUS_PER_WEEK = 100;
const DAYS_PER_WEEK = 7;

// Require the word "status" so ordinary chatter ("almost home", "ready when you
// are") never trips the tracker. Tolerant of punctuation, emoji and spacing:
// "Status: Home", "status home", "🏠 Status - Ready", "Status: Ready to roll".
const STATUS_RE = /\bstatus\b\s*[:\-–]?\s*(home|ready\s*to\s*roll|ready|rolling)/i;

/**
 * Read a driver status out of a free-text message.
 * @returns {'home'|'road'|null}
 */
function parseDriverStatus(text) {
  const match = STATUS_RE.exec(String(text || ''));
  if (!match) return null;
  const word = match[1].toLowerCase().replace(/\s+/g, ' ');
  if (word === 'home') return 'home';
  // ready | rolling | ready to roll
  return 'road';
}

/**
 * Coerce an ISO string, JS Date, epoch-millis number, or DateTime into a luxon
 * DateTime. Postgres timestamptz columns arrive as JS Date objects via node-pg,
 * so we must handle those — String(date) is NOT ISO and would parse as invalid.
 */
function toDateTime(value) {
  if (value instanceof DateTime) return value;
  if (value instanceof Date) return DateTime.fromJSDate(value);
  if (typeof value === 'number') return DateTime.fromMillis(value);
  return DateTime.fromISO(String(value));
}

/** Whole days between two ISO/Date timestamps (floored, never negative). */
function wholeDaysBetween(startIso, endIso) {
  const start = toDateTime(startIso);
  const end = toDateTime(endIso);
  if (!start.isValid || !end.isValid) return 0;
  return Math.max(0, Math.floor(end.diff(start, 'days').days));
}

function normalizeHomeTimeDriverType(driverType) {
  return driverType === 'company_driver' ? 'company_driver' : 'owner';
}

function homeTimePolicyApplies(driverType) {
  return normalizeHomeTimeDriverType(driverType) === 'company_driver';
}

/**
 * Bonus for one road trip.
 * Only FULL extra weeks count: allowance is `roadAllowanceWeeks × 7` days, and
 * the bonus is `floor(extraDays / 7) × bonusPerWeek`.
 *
 * @returns {{ daysOnRoad:number, exceededWeeks:number, bonusUsd:number }}
 */
function computeRoadBonus(roadStart, roadEnd, {
  roadAllowanceWeeks = DEFAULT_ROAD_ALLOWANCE_WEEKS,
  bonusPerWeek = DEFAULT_BONUS_PER_WEEK,
  driverType = 'company_driver',
} = {}) {
  const daysOnRoad = wholeDaysBetween(roadStart, roadEnd);
  const allowanceDays = Math.max(0, Number(roadAllowanceWeeks) || 0) * DAYS_PER_WEEK;
  const extraDays = Math.max(0, daysOnRoad - allowanceDays);
  const exceededWeeks = Math.floor(extraDays / DAYS_PER_WEEK);
  const policyApplies = homeTimePolicyApplies(driverType);
  const bonusUsd = policyApplies ? exceededWeeks * (Number(bonusPerWeek) || 0) : 0;
  return {
    daysOnRoad,
    exceededWeeks,
    bonusUsd,
    driverType: normalizeHomeTimeDriverType(driverType),
    policyApplies,
    overLimit: policyApplies && exceededWeeks > 0,
  };
}

module.exports = {
  DEFAULT_ROAD_ALLOWANCE_WEEKS,
  DEFAULT_HOME_ALLOWANCE_DAYS,
  DEFAULT_BONUS_PER_WEEK,
  DAYS_PER_WEEK,
  parseDriverStatus,
  wholeDaysBetween,
  normalizeHomeTimeDriverType,
  homeTimePolicyApplies,
  computeRoadBonus,
};
