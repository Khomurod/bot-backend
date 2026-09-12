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


// ── The two vocabularies, and the one place they meet ────────────────────────
//
// `driver_profiles.driver_type` predates the Board and speaks `owner` /
// `company_driver`; the Board speaks `owner_operator` / `company` / `lease`.
// Both are kept — renaming a column read by a dozen features to tidy a
// vocabulary is a migration with no benefit — and this is the ONLY place the
// two are translated, so they cannot drift apart in a corner of the code.
//
// `lease` is new on the profile side (migration 0047 widens its CHECK). It has
// no legacy spelling, so it is the same word in both.

/** Board/unit vocabulary → the profile column's tokens. */
const FLEET_TO_DRIVER_TYPE = Object.freeze({
  [FLEET_TYPES.COMPANY]: 'company_driver',
  [FLEET_TYPES.LEASE]: 'lease',
  [FLEET_TYPES.OWNER_OPERATOR]: 'owner',
});

/** The profile column's tokens → Board/unit vocabulary. */
const DRIVER_TYPE_TO_FLEET = Object.freeze({
  company_driver: FLEET_TYPES.COMPANY,
  lease: FLEET_TYPES.LEASE,
  owner: FLEET_TYPES.OWNER_OPERATOR,
});

/**
 * A profile's `driver_type` as a fleet type.
 *
 * A value nobody recognises becomes `unknown`, NOT owner_operator. The
 * unlabelled default belongs to the Board's naming convention — where an absent
 * label genuinely means owner operator — and must not be borrowed here, where an
 * unreadable stored value means we do not know.
 */
function toFleetType(driverType) {
  return DRIVER_TYPE_TO_FLEET[driverType] || FLEET_TYPES.UNKNOWN;
}

/**
 * A fleet type as a profile `driver_type`.
 *
 * `unknown` returns null rather than guessing: the column is nullable, and
 * writing `owner` for a driver nobody has classified would turn an open question
 * into a stored fact that later reads as deliberate.
 */
function toDriverType(fleetType) {
  return FLEET_TO_DRIVER_TYPE[fleetType] || null;
}

/**
 * The fleet a Telegram group title claims.
 *
 * The title is the Board's convention in a different container: `(COMPANY
 * DRIVERS)` and `(LEASE DRIVER)` appear in group names too, and an unlabelled
 * title is an owner operator. Same rules, one implementation — the substring
 * test this replaces (`/company\s+drivers?/i`) could not see `lease` at all,
 * so every lease driver read as an owner operator.
 */
function fleetTypeFromGroupName(groupName) {
  return parseFleetLabel(groupName || '').fleetType;
}

/**
 * WHICH ANSWER WINS, AND WHERE IT CAME FROM.
 *
 * A stored `driver_type` is somebody's decision — an administrator set it, or
 * the bot recorded it — and it beats a title, which is a string a dispatcher
 * typed and may have edited since. The title is the fallback for the rows where
 * nobody has decided, which is most of them.
 *
 * The SOURCE is returned with the value because the difference matters at the
 * call site: a broadcast that changes who it reaches should be able to say
 * whether it followed a person's decision or a guess from a chat name.
 *
 * @param {{column?: string|null, title?: string|null}} input
 * @returns {{value: string|null, fleetType: string, source: 'column'|'title'|'none'}}
 */
function resolveDriverType({ column = null, title = null } = {}) {
  if (column && DRIVER_TYPE_TO_FLEET[column]) {
    return { value: column, fleetType: DRIVER_TYPE_TO_FLEET[column], source: 'column' };
  }
  const fromTitle = fleetTypeFromGroupName(title);
  if (fromTitle === FLEET_TYPES.UNKNOWN) {
    return { value: null, fleetType: FLEET_TYPES.UNKNOWN, source: 'none' };
  }
  return { value: toDriverType(fromTitle), fleetType: fromTitle, source: 'title' };
}

module.exports = {
  FLEET_TYPES,
  FLEET_TYPE_VALUES,
  isFleetType,
  parseFleetLabel,
  toFleetType,
  toDriverType,
  fleetTypeFromGroupName,
  resolveDriverType,
  FLEET_TO_DRIVER_TYPE,
  DRIVER_TYPE_TO_FLEET,
};
