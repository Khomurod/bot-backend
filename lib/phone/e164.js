'use strict';

/**
 * Phone numbers in the two shapes this application actually needs.
 *
 * These are DIFFERENT JOBS and confusing them is what broke recruiter SMS in
 * production, so they live side by side here rather than in whichever module
 * happened to need one first:
 *
 *   toE164()   an address you can SEND to or FROM. RingCentral rejects
 *              anything else outright.
 *   phoneKey()  a key you can COMPARE two numbers with, whatever punctuation
 *              a human typed. Never send this — it has no country code.
 *
 * The bug: `recruiters.phone_number` holds whatever an admin typed —
 * `(470) 480-4679`, `4702400064`, `470-419-4110` — and the SMS sender passed
 * that string straight to RingCentral as `from`. RingCentral answered
 * `MSG-245 … Cannot find the phone number which belongs to user`, every lead
 * fell back to the shared company number, and because the comparison helper
 * that the diagnostics used only looks at the last ten digits, the admin panel
 * reported the number as matching. Two shapes, one name, no way to tell.
 *
 * Pure: no I/O, no state. Used by services/, database/ and server/ alike,
 * which is what earns it a place in lib/ (see lib/README.md).
 */

// ITU-T E.164 allows at most 15 digits; nothing real is shorter than 8.
// The bounds exist to refuse junk locally rather than let RingCentral reject
// it, which costs a round trip and reports as an opaque provider error.
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

const NANP_NATIONAL_DIGITS = 10;

/**
 * A sendable E.164 address (`+14704804679`), or `''` when the input cannot be
 * one.
 *
 * `''` rather than a best guess is deliberate: a caller that cannot produce a
 * valid sender must fall back to a number that works, and a half-normalized
 * string would instead reach the provider and fail there.
 *
 * - `(470) 480-4679`, `470-419-4110`, `4702400064` → `+1…` (assumes NANP,
 *   which is the only region this company operates in)
 * - `14704804679`                                  → `+14704804679`
 * - `+1 (470) 480-4679`, `+442079460958`           → kept, punctuation dropped
 * - `''`, `null`, `'x'`, `'470480'`, `'4704804679 x12'` → `''`
 *
 * A leading `+` is treated as the author stating their own country code, so it
 * is trusted rather than re-derived — that is the one case where we must not
 * assume +1.
 */
function toE164(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const statesCountryCode = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (statesCountryCode) {
    return digits.length >= MIN_E164_DIGITS && digits.length <= MAX_E164_DIGITS
      ? `+${digits}`
      : '';
  }

  // Bare national number.
  if (digits.length === NANP_NATIONAL_DIGITS) return `+1${digits}`;
  // Already carries the country code, just without the plus.
  if (digits.length === NANP_NATIONAL_DIGITS + 1 && digits.startsWith('1')) return `+${digits}`;

  // Anything else — a fragment, or a number with an extension glued on — is
  // not something we can address. Say so instead of guessing.
  return '';
}

/**
 * The last ten digits, so two spellings of the same number compare equal.
 *
 * Returns `''` for anything shorter, because a value that short is an
 * extension (`104`) or a fragment, and treating those as comparable is how an
 * extension number silently "matches" a phone number.
 *
 * NOT a sendable number. See `toE164` for that.
 *
 * NOTE: `database/ringcentral/recruiters.js` keeps its own lenient variant
 * (short values pass through unchanged) and deliberately does NOT use this
 * one. It writes `recruiters.phone_number_normalized`, which is
 * `TEXT NOT NULL UNIQUE`, so collapsing every short value to `''` there would
 * make two such rows collide on that index.
 */
function phoneKey(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= NANP_NATIONAL_DIGITS ? digits.slice(-NANP_NATIONAL_DIGITS) : '';
}

/**
 * Are these two the same phone number, however each was written?
 *
 * Two unusable values are never "the same" — `phoneKey('')` matching
 * `phoneKey('nonsense')` would make an empty column look like a match.
 */
function sameNumber(a, b) {
  const keyA = phoneKey(a);
  return Boolean(keyA) && keyA === phoneKey(b);
}

module.exports = {
  toE164,
  phoneKey,
  sameNumber,
};
