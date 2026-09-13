'use strict';

/**
 * When the weekly finance report is due, and which week it covers. PURE.
 *
 * Monday 08:00 America/Chicago, which is the start of the working week for the
 * people who read it. Luxon does the zone arithmetic, because DST is where a
 * hand-rolled weekly schedule goes wrong: twice a year the local hour and the
 * elapsed hours disagree, and a report that silently fires at 07:00 or 09:00 on
 * those two Mondays is the kind of defect nobody reports and nobody notices.
 *
 * THE PERIOD IS THE WEEK THAT ENDED, not the one beginning. A report sent on
 * Monday morning covers the previous Monday 08:00 to this Monday 08:00 —
 * everything that has happened, and nothing that has not. Using the calendar
 * week instead would make a Monday-morning report almost entirely empty.
 *
 * BACKFILL IS A REFUSAL, NOT A GAP. If the monitor was switched on last
 * Thursday, the period for this Monday's report begins before Wenze was
 * watching, and a total drawn from it would read as "$0 issued" when the truth
 * is "we were not there". `isBackfill` says so, and the service records a
 * `suppressed_backfill` row rather than sending a number it cannot stand
 * behind. The 72-hour grace exists because a monitor switched on a few hours
 * into a period has still seen essentially all of it.
 */

const { DateTime } = require('luxon');

const ZONE = 'America/Chicago';
/** Luxon: 1 = Monday. */
const WEEKDAY = 1;
const HOUR = 8;
/** How much of a period may predate `enabled_at` before it is a backfill. */
const BACKFILL_GRACE_HOURS = 72;

function local(at) {
  if (at instanceof Date) return DateTime.fromJSDate(at).setZone(ZONE);
  if (at) return DateTime.fromISO(String(at), { setZone: true }).setZone(ZONE);
  return DateTime.now().setZone(ZONE);
}

/**
 * The most recent Monday 08:00 at or before `at`.
 *
 * `startOf('week')` is Monday in Luxon, and setting the hour afterwards is what
 * keeps this correct across a DST boundary: the local 08:00 is the local 08:00
 * whether the week was 167 or 169 hours long.
 */
function mostRecentScheduledRun(at = null) {
  const now = local(at);
  const thisWeek = now.startOf('week').set({ hour: HOUR, minute: 0, second: 0, millisecond: 0 });
  return (now < thisWeek ? thisWeek.minus({ weeks: 1 }) : thisWeek).toJSDate();
}

/** The next Monday 08:00 strictly after `at`. */
function nextScheduledRun(at = null) {
  const now = local(at);
  const previous = DateTime.fromJSDate(mostRecentScheduledRun(at)).setZone(ZONE);
  const next = previous.plus({ weeks: 1 });
  return (next > now ? next : next.plus({ weeks: 1 })).toJSDate();
}

/**
 * The week a run at `scheduledFor` reports on: the seven days BEFORE it.
 *
 * Half-open on purpose — `[start, end)` — so a code issued exactly at 08:00 on
 * a Monday lands in precisely one report rather than in two or in none.
 */
function periodFor(scheduledFor) {
  const end = local(scheduledFor);
  return { periodStart: end.minus({ weeks: 1 }).toJSDate(), periodEnd: end.toJSDate() };
}

/** The idempotency key. One send per period, whatever restarts in between. */
function runKeyFor(periodStart) {
  return `weekly:${local(periodStart).toISODate()}`;
}

/**
 * Would this report cover time Wenze was not watching?
 *
 * @param {Date} periodStart
 * @param {Date|string|null} enabledAt  when the monitor was FIRST switched on
 */
function isBackfill(periodStart, enabledAt) {
  if (!enabledAt) return true;
  const start = local(periodStart);
  const enabled = local(enabledAt);
  if (enabled <= start) return false;
  return enabled.diff(start, 'hours').hours > BACKFILL_GRACE_HOURS;
}

/** "1–8 September" — for the report's own heading. */
function describePeriod(periodStart, periodEnd) {
  const a = local(periodStart);
  const b = local(periodEnd).minus({ days: 1 });
  if (a.month === b.month) return `${a.day}–${b.day} ${b.toFormat('LLLL yyyy')}`;
  return `${a.toFormat('d LLLL')} – ${b.toFormat('d LLLL yyyy')}`;
}

module.exports = {
  ZONE,
  WEEKDAY,
  HOUR,
  BACKFILL_GRACE_HOURS,
  mostRecentScheduledRun,
  nextScheduledRun,
  periodFor,
  runKeyFor,
  isBackfill,
  describePeriod,
};
