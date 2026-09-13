'use strict';

/**
 * Whether there is ANY moment in the week when Wenze is allowed to answer a
 * candidate. PURE.
 *
 * THE DEFECT THIS EXISTS TO CATCH. A reply needs two things to be true at once:
 * the office is closed, AND it is not quiet hours. Readiness used to ask
 * whether a working-hours row EXISTED — a boolean — and never looked at quiet
 * hours at all. So the most ordinary configuration anybody would type,
 *
 *     work Mon–Fri 08:00–21:00, do not text after 21:00 until 08:00
 *
 * leaves ZERO reachable minutes on every working day, and the feature reported
 * itself ready. A candidate texts at 22:00 on a Tuesday, the office is shut so
 * the AI's turn begins, quiet hours immediately end it, and nobody hears
 * anything until morning — which is the exact situation the feature was built
 * to prevent. Health said OK throughout.
 *
 * "Configured" and "reachable" are different questions, and only the second one
 * is worth anything to a candidate.
 *
 * HOW IT ANSWERS. It sweeps the week a minute at a time — 10 080 pure integer
 * comparisons, no clock, no database, no allocation per minute — and asks the
 * SAME functions the live path asks: `coversAt` for the working schedule,
 * `quietCoversAt` for the quiet period. A cleverer interval algebra would be a
 * second implementation of the overnight-window rule, which is the drift this
 * repository keeps paying for.
 *
 * IT NEVER INVENTS THE INTENDED SCHEDULE. A zero-window answer reports the
 * conflict and names both halves of it; choosing which half is wrong is the
 * owner's decision, and guessing it would quietly change when Wenze speaks to
 * strangers on the company's behalf.
 */
const { normaliseSchedule, coversAt, minutesToTime, DAY_NAMES } = require('./workingHours');
const { quietCoversAt } = require('./quietHours');

const MINUTES_PER_DAY = 24 * 60;

/**
 * @param {object} schedule  { timezone, windows, quietStartLocal, quietEndLocal }
 * @returns {{reachable: boolean, minutesPerWeek: number, byDay: Array,
 *            spans: Array<{day: string, from: string, to: string}>,
 *            timezone: string, summary: string, conflict: string|null}}
 */
function effectiveReachability(schedule = {}) {
  const { timezone, windows } = normaliseSchedule(schedule);
  const quiet = {
    quietStartLocal: schedule.quietStartLocal,
    quietEndLocal: schedule.quietEndLocal,
  };

  // NO WINDOWS MEANS THE OFFICE IS ALWAYS OPEN, so the after-hours turn never
  // arrives and nothing is reachable. `evaluateHours` returns `open` for an
  // unconfigured schedule — deliberately, so Wenze cannot start answering
  // strangers on the strength of a form nobody filled in — and a sweep that
  // read "no window covers this minute" as "the office is shut" would be a
  // SECOND answer to the same question, disagreeing with the live path. This
  // module was written to stop exactly that, and got it wrong on the first
  // draft: the empty schedule scored 5 460 reachable minutes a week.
  if (!windows.length) {
    return {
      reachable: false,
      minutesPerWeek: 0,
      byDay: DAY_NAMES.slice(1).map((day, i) => ({ day, weekday: i + 1, minutes: 0 })),
      spans: [],
      zeroDays: DAY_NAMES.slice(1),
      timezone,
      conflict: 'no_working_hours',
      summary: 'No working hours are set, so the office never counts as closed '
        + 'and the after-hours reply can never take its turn.',
    };
  }

  const byDay = [];
  const spans = [];
  let minutesPerWeek = 0;

  for (let weekday = 1; weekday <= 7; weekday += 1) {
    let dayMinutes = 0;
    let runStart = null;

    for (let m = 0; m < MINUTES_PER_DAY; m += 1) {
      const working = windows.some((win) => coversAt(win, weekday, m));
      const free = !working && !quietCoversAt(quiet, m);

      if (free) {
        dayMinutes += 1;
        if (runStart === null) runStart = m;
      } else if (runStart !== null) {
        spans.push({ day: DAY_NAMES[weekday], from: minutesToTime(runStart), to: minutesToTime(m) });
        runStart = null;
      }
    }
    // A run reaching midnight is closed at 24:00 rather than wrapped, so the
    // description reads the way a person would say it.
    if (runStart !== null) {
      spans.push({ day: DAY_NAMES[weekday], from: minutesToTime(runStart), to: '24:00' });
    }

    byDay.push({ day: DAY_NAMES[weekday], weekday, minutes: dayMinutes });
    minutesPerWeek += dayMinutes;
  }

  const reachable = minutesPerWeek > 0;
  const daysWithNone = byDay.filter((d) => d.minutes === 0).map((d) => d.day);

  return {
    reachable,
    minutesPerWeek,
    byDay,
    spans,
    // PER-DAY ZERO IS ITS OWN FACT, and not the same as per-week zero. Working
    // Mon–Fri 08:00–21:00 with quiet hours from 21:00 leaves the weekends
    // reachable, so the feature "works" — while a candidate who texts at 22:00
    // on a Tuesday is never answered, ever. That is worth an operator's
    // attention even though nothing is strictly broken, so it is reported
    // rather than folded into the boolean.
    zeroDays: daysWithNone,
    timezone,
    // Named separately from `summary` so a caller can show the conflict without
    // the prose, and so a test can assert the cause rather than the wording.
    conflict: reachable ? null : conflictReason(windows, quiet),
    summary: describe({ reachable, minutesPerWeek, spans, daysWithNone, timezone }),
  };
}

/** Which of the two rules is doing the covering — both halves, never a verdict. */
function conflictReason(windows, quiet) {
  const anyQuiet = quietCoversAt(quiet, 0) || quietCoversAt(quiet, MINUTES_PER_DAY - 1)
    || Array.from({ length: 24 }, (_, h) => quietCoversAt(quiet, h * 60)).some(Boolean);
  return anyQuiet ? 'working_hours_and_quiet_hours_cover_the_week' : 'working_hours_cover_the_week';
}

function describe({ reachable, minutesPerWeek, spans, daysWithNone, timezone }) {
  if (!reachable) {
    return 'There is no moment in the week when Wenze may answer a candidate: '
      + 'working hours and quiet hours together cover every hour of every day.';
  }
  const hours = Math.round((minutesPerWeek / 60) * 10) / 10;
  const first = spans[0];
  const shape = first ? `, e.g. ${first.day} ${first.from}–${first.to}` : '';
  return `${hours} hour${hours === 1 ? '' : 's'} a week when Wenze may answer${shape} (${timezone}).`;
}

module.exports = { effectiveReachability, MINUTES_PER_DAY };
