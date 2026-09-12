'use strict';

/**
 * How a truck number from the Dispatcher Board is compared with one from Wenze.
 *
 * A truck number is not a number. The Board carries `001`, `#310`, `UNIT 27`
 * and `001A`; Telegram group titles carry `WENZE 2024 UNIT # 310`; Samsara
 * carries whatever the fleet typed. Two spellings of the same truck must meet,
 * and two different trucks must not.
 *
 * TWO KEYS, AND ONLY ONE OF THEM MAY ACT.
 *
 *   exact       upper-cased, prefix stripped, LEADING ZEROS AND SUFFIXES KEPT.
 *               `001` and `1` are different trucks here, and so are `001` and
 *               `001A`. This is the only key strong enough to justify a write.
 *   digitsOnly  what `samsaraLocationService.normalizeUnitNumber` produces —
 *               digits, leading zeros dropped, any letter discarded. `001`,
 *               `1` and `001A` all collapse to `1`. Useful as a candidate
 *               generator, never as proof.
 *
 * The existing fleet has ten unit numbers on more than one active driver group,
 * including `001` on four. A key that cannot tell `001` from `1` would merge
 * people, which is the one thing this program says must never happen.
 */

/** `UNIT #`, `UNIT`, `#`, and the stray punctuation around them. */
const PREFIX = /^(?:unit\s*#?\s*|#\s*|no\.?\s*)/i;

/**
 * @param {*} value
 * @returns {string|null} the Board's own spelling, tidied but not reduced
 */
function normalizeBoardTruck(value) {
  if (value == null) return null;
  const trimmed = String(value).trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  const stripped = trimmed.replace(PREFIX, '').trim();
  if (!stripped) return null;
  // Internal spaces go: `001 A` and `001A` are one truck written two ways, and
  // nobody names a truck with a space in the middle on purpose.
  const compact = stripped.replace(/\s+/g, '').toUpperCase();
  return compact || null;
}

/** Digits only, leading zeros dropped — the weak key, for candidates. */
function digitsOnlyTruck(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (!digits) return null;
  return digits.replace(/^0+(?=\d)/, '');
}

/**
 * Both keys for one truck string.
 * @returns {{exact: string|null, digitsOnly: string|null}}
 */
function truckComparisonKeys(value) {
  return { exact: normalizeBoardTruck(value), digitsOnly: digitsOnlyTruck(value) };
}

/**
 * Do two truck strings name the same truck, and how sure is that?
 * @returns {'exact'|'digits'|'none'}
 */
function compareTrucks(a, b) {
  const left = truckComparisonKeys(a);
  const right = truckComparisonKeys(b);
  if (left.exact && right.exact && left.exact === right.exact) return 'exact';
  if (left.digitsOnly && right.digitsOnly && left.digitsOnly === right.digitsOnly) return 'digits';
  return 'none';
}

module.exports = {
  normalizeBoardTruck,
  digitsOnlyTruck,
  truckComparisonKeys,
  compareTrucks,
};
