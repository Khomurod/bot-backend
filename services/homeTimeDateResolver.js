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

module.exports = {
  TZ,
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
};
