/**
 * Home-Time date resolver — pure date math + normalization (no network / DB).
 *
 * The single source of truth for the home-time DATE MODEL. Three concepts are
 * kept strictly separate (see the prompt / schema notes):
 *
 *   - home_start_date     : the day the driver ARRIVES home.
 *   - return_to_road_date : the day the driver LEAVES home to go back on the road.
 *   - last_day_home       : the final calendar day at home (= return_to_road − 1).
 *
 * homeDays = calendar difference between return-to-road and home-start. Example:
 * home Monday, back Friday → 4 home days (Mon, Tue, Wed, Thu); Friday is NOT a
 * home day.
 *
 * The cardinal rule: a SINGLE supplied date is never copied into both ends. If
 * only the start is known, the return stays null (and vice-versa) so the flow can
 * ask for the missing piece.
 */
const { DateTime } = require('luxon');
const { wholeDaysBetween } = require('./homeTimeConstants');

const TZ = 'America/Chicago';

/** Coerce an ISO date (YYYY-MM-DD) or datetime into a YYYY-MM-DD string or null. */
function toISODate(value, timezone = TZ) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const dt = DateTime.fromJSDate(value).setZone(timezone);
    return dt.isValid ? dt.toISODate() : null;
  }
  const s = String(value).trim();
  if (!s) return null;
  const dt = DateTime.fromISO(s, { zone: timezone });
  return dt.isValid ? dt.toISODate() : null;
}

function addDays(iso, n, timezone = TZ) {
  const dt = DateTime.fromISO(String(iso), { zone: timezone });
  if (!dt.isValid) return null;
  return dt.plus({ days: n }).toISODate();
}

/** homeDays = calendar difference (return − start). Null unless both are known. */
function computeHomeDays(homeStart, returnToRoad) {
  if (!homeStart || !returnToRoad) return null;
  return wholeDaysBetween(homeStart, returnToRoad);
}

/** last day home = return-to-road − 1 day. */
function lastDayHomeFromReturn(returnToRoad) {
  return returnToRoad ? addDays(returnToRoad, -1) : null;
}

/** return-to-road = last day home + 1 day. */
function returnFromLastDayHome(lastDayHome) {
  return lastDayHome ? addDays(lastDayHome, 1) : null;
}

/**
 * Normalize candidate date fields (from AI extraction OR a deterministic parse)
 * together with already-known context into the canonical window. PURE + fully
 * unit-testable.
 *
 * @param {object} p
 * @param {string|Date|null} [p.homeStart]        candidate home-start date
 * @param {string|Date|null} [p.returnToRoad]     candidate return-to-road date
 * @param {string|Date|null} [p.lastDayHome]      candidate last-day-home date
 * @param {number|null}      [p.durationDays]     stated home duration in days
 * @param {string|Date|null} [p.knownHomeStart]   home-start already on record
 * @param {string|Date|null} [p.knownReturnToRoad] return already on record
 * @returns {{ homeStartDate:(string|null), returnToRoadDate:(string|null),
 *   lastDayHome:(string|null), homeTo:(string|null), homeDays:(number|null),
 *   missingFields:string[], complete:boolean }}
 */
function normalizeHomeTimeWindow({
  homeStart = null, returnToRoad = null, lastDayHome = null, durationDays = null,
  knownHomeStart = null, knownReturnToRoad = null,
} = {}) {
  let start = toISODate(homeStart) || toISODate(knownHomeStart) || null;
  let ret = toISODate(returnToRoad) || toISODate(knownReturnToRoad) || null;
  const last = toISODate(lastDayHome);
  const durNum = Number(durationDays);
  const dur = Number.isFinite(durNum) && durNum > 0 ? Math.floor(durNum) : null;

  // Derive the return from an explicit "last day home".
  if (!ret && last) ret = returnFromLastDayHome(last);
  // Derive the return from start + a stated duration ("home Monday for 4 days").
  if (!ret && start && dur) ret = addDays(start, dur);
  // Derive the start from return − duration ("back Friday, I need 4 days").
  if (!start && ret && dur) start = addDays(ret, -dur);

  // A return on or before the start is not a real home window — discard it rather
  // than fabricate one. This also enforces "never copy one date into both ends":
  // a single date resolved to start==return collapses the return back to null.
  if (start && ret && !(DateTime.fromISO(ret) > DateTime.fromISO(start))) {
    ret = null;
  }

  const missingFields = [];
  if (!start) missingFields.push('home_start');
  if (!ret) missingFields.push('return_to_road');

  return {
    homeStartDate: start,
    returnToRoadDate: ret,
    lastDayHome: lastDayHomeFromReturn(ret),
    homeTo: lastDayHomeFromReturn(ret), // DB column `home_to` = last day home
    homeDays: computeHomeDays(start, ret),
    missingFields,
    complete: Boolean(start && ret),
  };
}

/**
 * Date-only (YYYY-MM-DD) from a DATE-column value that node-pg may hand back as a
 * JS Date OR a string. Deliberately UTC-based (NOT the Chicago TZ used elsewhere):
 * a bare DATE has no time, so shifting it into a negative-offset zone would move
 * a midnight-UTC Date to the previous calendar day. Returns null when unusable.
 */
function isoDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const dt = DateTime.fromJSDate(value, { zone: 'utc' });
    return dt.isValid ? dt.toISODate() : null;
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const dt = DateTime.fromISO(s, { zone: 'utc' });
  return dt.isValid ? dt.toISODate() : null;
}

/**
 * The return-to-road date already registered on a home-time request. Prefers the
 * explicit `return_to_road_date`; falls back to `home_to` (last day home) + 1 day
 * so a manually-registered window that only carries the last-day-home still yields
 * a usable return. Returns a YYYY-MM-DD string or null.
 */
function resolveRequestReturnDate(request) {
  if (!request) return null;
  const explicit = isoDateOnly(request.return_to_road_date);
  if (explicit) return explicit;
  const lastDayHome = isoDateOnly(request.home_to);
  return lastDayHome ? returnFromLastDayHome(lastDayHome) : null;
}

/**
 * Is a previously-registered return-to-road date usable for a driver who has just
 * arrived home on `arrivalDate`? True only when the return is a valid date
 * strictly AFTER the arrival and no more than `maxHomeDays` out, so a stale or
 * unrelated old approval is never silently reused in place of asking the driver.
 */
function isUsableKnownReturnDate(returnDate, arrivalDate, { maxHomeDays = 60 } = {}) {
  const ret = isoDateOnly(returnDate);
  const arr = isoDateOnly(arrivalDate);
  if (!ret || !arr) return false;
  const r = DateTime.fromISO(ret, { zone: 'utc' });
  const a = DateTime.fromISO(arr, { zone: 'utc' });
  if (!r.isValid || !a.isValid) return false;
  const days = r.diff(a, 'days').days;
  if (days <= 0) return false;
  if (days > Math.max(1, Number(maxHomeDays) || 60)) return false;
  return true;
}

/** Map the missing-field set to the request's clarification status. */
function statusForMissingFields(missingFields = []) {
  const set = new Set(missingFields);
  if (set.has('home_start') && set.has('return_to_road')) return 'awaiting_dates';
  if (set.has('home_start')) return 'awaiting_home_start';
  if (set.has('return_to_road')) return 'awaiting_return_to_road';
  return 'pending';
}

/**
 * Is `{homeStart, returnToRoad}` a sane window relative to `referenceIso`?
 * Both valid dates, return strictly after start, and the start within
 * [yesterday, +1 year]. Used to validate resolved windows before persisting.
 */
function isReasonableWindow(homeStart, returnToRoad, referenceIso, timezone = TZ) {
  const start = toISODate(homeStart, timezone);
  const ret = toISODate(returnToRoad, timezone);
  if (!start || !ret) return false;
  const s = DateTime.fromISO(start, { zone: timezone });
  const r = DateTime.fromISO(ret, { zone: timezone });
  if (!s.isValid || !r.isValid || r <= s) return false;
  const ref = referenceIso ? DateTime.fromISO(String(referenceIso), { zone: timezone }) : DateTime.now().setZone(timezone);
  const refSafe = ref.isValid ? ref : DateTime.now().setZone(timezone);
  if (s < refSafe.minus({ days: 1 }).startOf('day')) return false;
  if (s > refSafe.plus({ years: 1 })) return false;
  return true;
}

/**
 * The default when the settings row is missing or nonsensical. Matches the
 * `|| 4` the rest of this subsystem already falls back to — a NULL allowance
 * must not become a licence for any window at all.
 */
const DEFAULT_HOME_ALLOWANCE_DAYS = 4;

/**
 * How far ahead a home-time REQUEST can reasonably sit. Beyond this it is a
 * plan, not a request, and almost certainly a mis-parsed year: request 139
 * stored a `home_from` of 2027-01-02 and nothing questioned it, because a year
 * is inside `isReasonableWindow`'s horizon.
 */
const DEFAULT_MAX_FUTURE_DAYS = 120;

/**
 * Does this window survive POLICY, and if not, which half to ask about? PURE.
 *
 * `isReasonableWindow` asks whether two dates are plausible. That is a different
 * question from whether the company grants them, and conflating the two is how
 * request 132 came to store a THIRTY-DAY home stay against a four-day allowance
 * and sit there `pending`. Nothing compared the parsed dates to the settings the
 * entire feature is configured by.
 *
 * The point is not to refuse the driver. It is to stop silently persisting a
 * number nobody agreed to and calling it a request — an out-of-policy answer is
 * a clarification, so this names the field to ask about again:
 *
 *   too_far_ahead → the START is wrong (and is reported FIRST even when the
 *     window is also too long, because asking about a return date whose start is
 *     nonsense wastes the driver's turn);
 *   too_long      → the START is fine and the RETURN is the disputed half.
 *
 * `invalid` is kept distinct from both: a parse that failed and a request the
 * company does not grant deserve different answers.
 *
 * @returns {{ok:boolean, reason:null|'invalid'|'too_long'|'too_far_ahead',
 *            days:number|null, allowanceDays:number, maxFutureDays:number,
 *            disputedField:null|'home_start'|'return_to_road'}}
 */
function classifyWindowAgainstPolicy(homeStart, returnToRoad, {
  referenceIso = null, homeAllowanceDays = null, maxFutureDays = null, timezone = TZ,
} = {}) {
  const allowanceDays = Number(homeAllowanceDays) > 0
    ? Math.floor(Number(homeAllowanceDays)) : DEFAULT_HOME_ALLOWANCE_DAYS;
  const horizonDays = Number(maxFutureDays) > 0
    ? Math.floor(Number(maxFutureDays)) : DEFAULT_MAX_FUTURE_DAYS;
  const base = { allowanceDays, maxFutureDays: horizonDays };

  if (!isReasonableWindow(homeStart, returnToRoad, referenceIso, timezone)) {
    return {
      ok: false, reason: 'invalid', days: null, disputedField: null, ...base,
    };
  }

  const start = DateTime.fromISO(toISODate(homeStart, timezone), { zone: timezone });
  const ret = DateTime.fromISO(toISODate(returnToRoad, timezone), { zone: timezone });
  const ref = referenceIso ? DateTime.fromISO(String(referenceIso), { zone: timezone }) : DateTime.now().setZone(timezone);
  const refSafe = ref.isValid ? ref : DateTime.now().setZone(timezone);

  if (start > refSafe.plus({ days: horizonDays })) {
    return {
      ok: false, reason: 'too_far_ahead', days: computeHomeDays(start.toISODate(), ret.toISODate()),
      disputedField: 'home_start', ...base,
    };
  }

  const days = computeHomeDays(start.toISODate(), ret.toISODate());
  if (days != null && days > allowanceDays) {
    return {
      ok: false, reason: 'too_long', days, disputedField: 'return_to_road', ...base,
    };
  }

  return {
    ok: true, reason: null, days, disputedField: null, ...base,
  };
}

/**
 * Re-open the disputed half of an out-of-policy window. PURE.
 *
 * An out-of-policy answer is a CLARIFICATION, not a rejection and not a value to
 * store. Clearing exactly one date turns a "complete" window back into a partial
 * one, which is the state the existing clarification flow already knows how to
 * ask about — no new send path, no new status, and the driver is asked about the
 * half that is actually in dispute rather than made to repeat both.
 */
function reopenWindowForPolicy(window, disputedField) {
  if (!window || !disputedField) return window;
  return normalizeHomeTimeWindow({
    homeStart: disputedField === 'home_start' ? null : window.homeStartDate,
    returnToRoad: disputedField === 'return_to_road' ? null : window.returnToRoadDate,
  });
}

// A partial clarification with NO resolvable end date is treated as stale (and
// safe to auto-close) only after the reminder cycle is exhausted AND it has been
// open at least this many days — long enough that a legitimately active
// clarification (driver still expected to answer) is never expired early.
const STALE_CLARIFICATION_DAYS = 21;

// Statuses that can still be "open" and therefore candidates for auto-expiry.
const OUTDATABLE_STATUSES = [
  'pending', 'awaiting_dates', 'awaiting_home_start', 'awaiting_return_to_road',
  'clarification_unanswered',
];

/**
 * True when the ENTIRE requested home-time window is already in the past relative
 * to `todayIso` (the driver should be back on the road). The window end is the
 * return-to-road date, or last-day-home + 1. Returns false when no end date is
 * known (a partial clarification). Used both to block approving an outdated
 * request and as the primary auto-expiry rule.
 */
function isHomeTimeWindowInPast(request, todayIso = null) {
  const end = resolveRequestReturnDate(request);
  if (!end) return false;
  const today = isoDateOnly(todayIso) || DateTime.now().setZone(TZ).toISODate();
  return end < today;
}

/**
 * True when an open home-time request is no longer actionable and should be
 * auto-closed as "Expired — No Action":
 *   1. any request whose resolvable end date is already in the past; OR
 *   2. a partial clarification with no end date, but ONLY once its reminders are
 *      exhausted (next_reminder_at cleared) AND it has been open beyond
 *      `staleClarificationDays` (anchored on home_from when known, else
 *      requested_at) — so an active clarification is never expired prematurely.
 * Terminal requests (approved/denied/cancelled/expired) are never "outdated".
 */
function isHomeTimeRequestOutdated(request, { todayIso = null, staleClarificationDays = STALE_CLARIFICATION_DAYS } = {}) {
  if (!request) return false;
  if (!OUTDATABLE_STATUSES.includes(String(request.status || ''))) return false;
  if (isHomeTimeWindowInPast(request, todayIso)) return true;

  const status = String(request.status || '');
  const isOpenClarification = status === 'awaiting_dates' || status === 'awaiting_home_start'
    || status === 'awaiting_return_to_road' || status === 'clarification_unanswered';
  if (!isOpenClarification) return false; // a 'pending' card is judged only on its dates
  if (request.next_reminder_at) return false; // reminders still pending → still active

  const today = isoDateOnly(todayIso) || DateTime.now().setZone(TZ).toISODate();
  const anchor = isoDateOnly(request.home_from) || isoDateOnly(request.requested_at);
  if (!anchor) return false;
  const cutoff = DateTime.fromISO(today, { zone: TZ })
    .minus({ days: Math.max(1, Number(staleClarificationDays) || STALE_CLARIFICATION_DAYS) })
    .toISODate();
  return anchor < cutoff;
}

module.exports = {
  TZ,
  STALE_CLARIFICATION_DAYS,
  DEFAULT_HOME_ALLOWANCE_DAYS,
  DEFAULT_MAX_FUTURE_DAYS,
  classifyWindowAgainstPolicy,
  reopenWindowForPolicy,
  OUTDATABLE_STATUSES,
  toISODate,
  isoDateOnly,
  addDays,
  computeHomeDays,
  lastDayHomeFromReturn,
  returnFromLastDayHome,
  resolveRequestReturnDate,
  isUsableKnownReturnDate,
  normalizeHomeTimeWindow,
  statusForMissingFields,
  isReasonableWindow,
  isHomeTimeWindowInPast,
  isHomeTimeRequestOutdated,
};
