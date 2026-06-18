/**
 * Mileage Bonus — constants and pure helpers.
 *
 * Tracks cumulative driven miles for COMPANY DRIVERS ONLY (Datatruck
 * driver_type === 'company_driver') and awards a one-time bonus each time a
 * driver crosses a mileage milestone since they started with us.
 *
 * Everything here is side-effect free so it can be unit-tested without a
 * network or database.
 */
const { DateTime } = require('luxon');

// Cumulative milestones (ascending). Each tier is awarded once, ever, the
// first time a driver's accumulated miles reach the threshold.
const MILEAGE_BONUS_TIERS = [
  { miles: 10000, amount: 200 },
  { miles: 40000, amount: 500 },
  { miles: 100000, amount: 700 },
  { miles: 150000, amount: 900 },
  { miles: 200000, amount: 1500 },
];

// Hard-coded "Bonus Penalty For Drivers" group.
const BONUS_GROUP_CHAT_ID = -5170359585;

// Only these usernames may approve/reject a bonus card (case-insensitive,
// stored without the leading @).
const ACCOUNTING_USERNAMES = ['cameron_acc', 'Ellaaccounting'];

// Tagged on the notification card so accounting is pinged.
const ACCOUNTING_MENTIONS = ['@cameron_acc', '@Ellaaccounting'];

// Tagged for follow-up when a bonus is rejected in pay.
const REJECTION_ESCALATION_MENTIONS = ['@tomr_robins0n', '@SaffieBNett'];

// Company-wide program start. Miles before this date never count, even for
// drivers hired earlier. Per-driver counting starts at max(hire_date, this).
const PROGRAM_START_ISO = '2026-04-17';

const SCHEDULE_TIMEZONE = 'America/Chicago';
// Weekly automatic run: Wednesday (luxon weekday 3) at 07:00 Central.
const SCHEDULE_WEEKDAY = 3;
const SCHEDULE_HOUR = 7;
const SCHEDULE_MINUTE = 0;

// Count loaded + empty (deadhead) miles as "driven" miles for bonus purposes.
const INCLUDE_EMPTY_MILES = true;
// Credit full trip miles to a team co-driver as well as the primary driver.
const CREDIT_TEAM_CO_DRIVER = true;

const BONUS_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  REJECTED: 'rejected',
};

/**
 * Normalize a driver full name for matching order rows to driver records.
 * Both come from the same Datatruck driver record, so an exact normalized
 * match is reliable.
 */
function normalizeDriverName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b(LLC|INC|JR|SR|II|III|IV)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAccountingUsername(username) {
  const u = String(username || '').replace(/^@/, '').toLowerCase();
  if (!u) return false;
  return ACCOUNTING_USERNAMES.some((name) => name.toLowerCase() === u);
}

/** Parse a number out of a Datatruck decimal string. */
function toMiles(value) {
  const n = parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pay period end = the Sunday two weeks behind the reference date (our pay
 * runs two weeks in arrears). Returns a luxon DateTime at end-of-day Central.
 *
 * e.g. reference Wed 2026-06-18 -> 2026-06-07 23:59:59 Central.
 */
function computePayPeriodEnd(reference) {
  const ref = reference.setZone(SCHEDULE_TIMEZONE);
  const daysSinceSunday = ref.weekday % 7; // luxon Sun=7 -> 0, Mon=1 ... Sat=6
  const thisSunday = ref.minus({ days: daysSinceSunday }).startOf('day');
  const endSunday = thisSunday.minus({ days: 7 });
  return endSunday.endOf('day');
}

/**
 * Most recent scheduled weekly run (Wed 07:00 Central) at or before `now`.
 * Used as the idempotency key so a sleeping instance still runs once after
 * waking, even if it missed the exact 07:00 tick.
 */
function mostRecentScheduledRun(now) {
  const ref = now.setZone(SCHEDULE_TIMEZONE);
  let candidate = ref.set({
    hour: SCHEDULE_HOUR, minute: SCHEDULE_MINUTE, second: 0, millisecond: 0,
  }).minus({ days: ref.weekday - SCHEDULE_WEEKDAY });
  if (candidate > ref) candidate = candidate.minus({ days: 7 });
  return candidate;
}

/** Per-driver counting window start: max(hire date, program start). */
function driverPeriodStart(hireDateIso) {
  const programStart = DateTime.fromISO(PROGRAM_START_ISO, { zone: SCHEDULE_TIMEZONE }).startOf('day');
  if (!hireDateIso) return programStart;
  const hire = DateTime.fromISO(String(hireDateIso), { zone: SCHEDULE_TIMEZONE }).startOf('day');
  if (!hire.isValid) return programStart;
  return hire > programStart ? hire : programStart;
}

/** All tiers whose mileage threshold has been reached by `miles`. */
function tiersReached(miles) {
  return MILEAGE_BONUS_TIERS.filter((tier) => miles >= tier.miles);
}

/** The next tier a driver is working toward, or null if all reached. */
function nextTier(miles) {
  return MILEAGE_BONUS_TIERS.find((tier) => miles < tier.miles) || null;
}

module.exports = {
  MILEAGE_BONUS_TIERS,
  BONUS_GROUP_CHAT_ID,
  ACCOUNTING_USERNAMES,
  ACCOUNTING_MENTIONS,
  REJECTION_ESCALATION_MENTIONS,
  PROGRAM_START_ISO,
  SCHEDULE_TIMEZONE,
  SCHEDULE_WEEKDAY,
  SCHEDULE_HOUR,
  SCHEDULE_MINUTE,
  INCLUDE_EMPTY_MILES,
  CREDIT_TEAM_CO_DRIVER,
  BONUS_STATUS,
  normalizeDriverName,
  isAccountingUsername,
  toMiles,
  computePayPeriodEnd,
  mostRecentScheduledRun,
  driverPeriodStart,
  tiersReached,
  nextTier,
};
