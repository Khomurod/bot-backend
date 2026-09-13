'use strict';

/**
 * The hours Wenze must not text a candidate, whatever else is true. PURE.
 *
 * SHUT AND ASLEEP ARE DIFFERENT THINGS. The office being closed is what makes
 * the after-hours reply this feature's turn; 03:00 is what makes a text from it
 * rude. So quiet hours sit BESIDE the working-hours schedule rather than inside
 * it, and a reply needs both answers: outside working hours AND outside quiet
 * hours.
 *
 * That conjunction is the whole reason this module was lifted out of
 * `services/recruiting/afterHoursCompose.js`. Working out whether the feature
 * can EVER speak means sweeping a week against both rules, and that sweep lives
 * in `lib/` — the layer below the database — so it cannot reach up into a
 * service. Duplicating the rule there instead would have been the same
 * two-copies-that-drift bug this repository keeps paying for.
 *
 * `afterHoursCompose` re-exports this, so the live reply path and every
 * existing caller still ask exactly one implementation.
 */
const { timeToMinutes } = require('./workingHours');

/**
 * Is `minutes` past midnight inside the quiet period?
 *
 * START == END MEANS NO QUIET PERIOD AT ALL, not a zero-length one and not a
 * whole day. It is the shape a settings row has when nobody has chosen, and the
 * safe reading of "nobody chose" here is that no hour is forbidden — the
 * working-hours schedule is still what decides whether Wenze may speak.
 */
function quietCoversAt({ quietStartLocal, quietEndLocal }, minutes) {
  const start = timeToMinutes(quietStartLocal);
  const end = timeToMinutes(quietEndLocal);
  if (minutes === null || start === null || end === null) return false;
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  // Overnight: 21:00–08:00 is the evening plus the small hours.
  return minutes >= start || minutes < end;
}

/** The same question from an 'HH:MM' local time, which is what the reply path holds. */
function inQuietHours(settings, localTimeHHMM) {
  return quietCoversAt(settings, timeToMinutes(localTimeHHMM));
}

module.exports = { quietCoversAt, inQuietHours };
