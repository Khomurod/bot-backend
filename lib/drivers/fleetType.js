'use strict';

/**
 * Which fleet a truck belongs to — and why a truck number alone means nothing.
 *
 * Wenze runs three fleets that number their trucks independently. Company 001,
 * Owner-Operator 001 and Lease 001 are three different trucks driven by three
 * different people. Production already carries ten unit numbers that appear on
 * more than one active driver group, `001` on four of them, and every one of
 * those looks like a duplicate to anything that compares bare numbers.
 *
 * So the fleet is part of the truck's name, not a label on it. `unknown` is a
 * real answer and the rule everywhere is the same: **unknown never wins a
 * match.** A row Wenze cannot place is a question, never a merge.
 *
 * The Dispatcher Board spells the fleet in the driver's own name field:
 *
 *     JOHN SMITH (COMPANY DRIVER)   → company
 *     JANE DOE (LEASE DRIVERS)      → lease
 *     SAM JONES                     → owner_operator   (the unlabelled default)
 *     PAT LEE (SOMETHING ELSE)      → unknown
 *
 * Tolerance is deliberate and bounded. Singular and plural both appear, so do
 * the bare `(COMPANY)` and `(LEASE)`, and the live Board carries one
 * `(COMPNAY DRIVER)` typo. A typo is normalised and SAID SO — `normalised:
 * true` — rather than silently accepted, because "we guessed" is a fact the
 * finding needs to carry. Anything outside the list is `unknown`, never a
 * closest guess.
 */

const FLEET_TYPES = Object.freeze({
  COMPANY: 'company',
  LEASE: 'lease',
  OWNER_OPERATOR: 'owner_operator',
  UNKNOWN: 'unknown',
});

const FLEET_TYPE_VALUES = Object.freeze(Object.values(FLEET_TYPES));

/** Exactly the spellings seen on the Board, plus their obvious plurals. */
const COMPANY_LABEL = /^company(?:\s+drivers?)?$/i;
const LEASE_LABEL = /^lease(?:\s+drivers?(?:\(s\))?)?$/i;
/** The one typo the live Board actually carries, kept separate so it is named. */
const TYPO_LABEL = /^compnay(?:\s+drivers?)?$/i;

/** Is this one of the four values? Guards anything coming from outside. */
function isFleetType(value) {
  return FLEET_TYPE_VALUES.includes(value);
}

/**
 * Read the parenthesised label out of a Board driver name.
 *
 * @param {string} rawName  e.g. `JOHN SMITH (COMPANY DRIVER)`
 * @returns {{fleetType: string, label: string|null, cleanName: string,
 *   normalised: boolean}}
 *   `normalised` is true only when a misspelling was accepted as a known label.
 */
function parseFleetLabel(rawName) {
  const text = String(rawName == null ? '' : rawName).trim().replace(/\s+/g, ' ');
  if (!text) {
    return {
      fleetType: FLEET_TYPES.UNKNOWN, label: null, cleanName: '', normalised: false,
    };
  }

  // The LAST parenthesised group, because a name may carry another one before
  // it and the fleet label is written at the end.
  const matches = [...text.matchAll(/\(([^)]*)\)/g)];
  const last = matches.length ? matches[matches.length - 1] : null;
  const cleanName = (last
    ? `${text.slice(0, last.index)}${text.slice(last.index + last[0].length)}`
    : text
  ).replace(/\s+/g, ' ').trim();

  if (!last) {
    // No label at all is the owner-operator default — the Board's own
    // convention, and the reason an absent label is NOT `unknown`.
    return {
      fleetType: FLEET_TYPES.OWNER_OPERATOR, label: null, cleanName, normalised: false,
    };
  }

  const label = last[1].trim().replace(/\s+/g, ' ');
  if (COMPANY_LABEL.test(label)) {
    return { fleetType: FLEET_TYPES.COMPANY, label, cleanName, normalised: false };
  }
  if (TYPO_LABEL.test(label)) {
    return { fleetType: FLEET_TYPES.COMPANY, label, cleanName, normalised: true };
  }
  if (LEASE_LABEL.test(label)) {
    return { fleetType: FLEET_TYPES.LEASE, label, cleanName, normalised: false };
  }
  return { fleetType: FLEET_TYPES.UNKNOWN, label, cleanName, normalised: false };
}

module.exports = {
  FLEET_TYPES,
  FLEET_TYPE_VALUES,
  isFleetType,
  parseFleetLabel,
};
