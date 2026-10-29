'use strict';

/**
 * "Is this the same driver?" between a Dispatcher Board line and a Bitrix deal
 * title. PURE.
 *
 * THE OWNER'S RULE (29 October 2026): a difference of a letter or two, an extra
 * space, or the first and last name the other way round is the same person and
 * is NOT worth a question. A bigger difference is asked about, and a person
 * looks. Nothing here writes anything — the price of a wrong "same" is a
 * question not asked, the price of a wrong "different" is a question that did
 * not need asking — so this may be a little more forgiving than the identity
 * rules that move records (lib/identity/boardResolution.js), and stays strict
 * where forgiving would hide a real discrepancy:
 *
 *   - a short word gets no typo allowance ("ALI" is not "ABU");
 *   - at most two letters differ across the whole name;
 *   - ONE word on its own matches only when the caller already narrowed the
 *     field to one truck (`namesCompatible`). Bitrix titles are often just a
 *     first name ("ABDINASIR"); on the right truck that is the driver, across
 *     the fleet it is a guess.
 *
 * Bitrix titles carry trailing spaces and no fixed name order; Board names
 * carry a fleet label in brackets. Both are tidied before anything compares.
 */

const { normalizePersonName } = require('../drivers/driverGroupTitle');
const { oneEditApart, joinApostrophes } = require('../drivers/nameTolerance');

const MAX_TOTAL_EDITS = 2;
const MAX_PERMUTED_TOKENS = 4;

/** Upper-case words of a name: brackets, apostrophes and punctuation gone. */
function nameTokens(value) {
  const withoutLabels = String(value || '').replace(/\([^)]*\)/g, ' ');
  return normalizePersonName(joinApostrophes(withoutLabels))
    .split(' ')
    .filter((t) => t.length >= 2)
    .map((t) => t.toUpperCase());
}

/** The name as a person reads it, tidied: "OLABODE OLUDAISI". */
function tidyName(value) {
  return nameTokens(value).join(' ');
}

/** Word order does not matter: the stable key a discrepancy about a person is filed under. */
function personKey(value) {
  return [...nameTokens(value)].sort().join(' ');
}

/** Levenshtein distance, small strings only. */
function editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** How many letters two words differ by, or Infinity when they are different words. */
function tokenEdits(a, b) {
  if (a === b) return 0;
  const shortest = Math.min(a.length, b.length);
  if (shortest >= 4 && oneEditApart(a, b)) return 1;
  if (shortest >= 6) {
    const d = editDistance(a, b);
    if (d <= 2) return d;
  }
  return Infinity;
}

/** Every permutation of a short list (at most MAX_PERMUTED_TOKENS long). */
function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((head, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [head, ...rest]));
}

/**
 * Fewest letters by which every word of `shorter` meets a DIFFERENT word of
 * `longer`, or Infinity.
 */
function bestCover(shorter, longer) {
  if (longer.length > MAX_PERMUTED_TOKENS) {
    // A five-word name: exact words only, in any order.
    const pool = [...longer];
    for (const t of shorter) {
      const at = pool.indexOf(t);
      if (at < 0) return Infinity;
      pool.splice(at, 1);
    }
    return 0;
  }
  let best = Infinity;
  for (const order of permutations(longer)) {
    let total = 0;
    for (let i = 0; i < shorter.length && total <= best; i += 1) total += tokenEdits(shorter[i], order[i]);
    if (total < best) best = total;
  }
  return best;
}

function splitTokens(a, b) {
  const left = nameTokens(a);
  const right = nameTokens(b);
  return left.length <= right.length ? [left, right] : [right, left];
}

/**
 * The same person across the whole fleet: at most two letters apart, word order
 * free, a missing middle name forgiven only when at least two words agree.
 */
function namesClose(a, b) {
  const [shorter, longer] = splitTokens(a, b);
  if (!shorter.length) return false;
  // "ABDI NASIR" and "ABDINASIR": one space is not a different person.
  if (shorter.join('') === longer.join('') || [...shorter].sort().join('') === [...longer].sort().join('')) return true;
  if (shorter.length < longer.length && shorter.length < 2) return false;
  return bestCover(shorter, longer) <= MAX_TOTAL_EDITS;
}

/**
 * The same person ON ONE TRUCK: `namesClose`, or one word of at least three
 * letters that matches a word of the other name ("ABDINASIR" on the truck
 * whose Board line reads "ABDINASIR MOHAMED").
 */
function namesCompatible(a, b) {
  if (namesClose(a, b)) return true;
  const [shorter, longer] = splitTokens(a, b);
  if (shorter.length !== 1 || shorter[0].length < 3) return false;
  return longer.some((t) => tokenEdits(shorter[0], t) <= 1);
}

/** "PRINCE/OTIS" → ["PRINCE", "OTIS"]: one Bitrix deal titled with two people. */
function titleParts(title) {
  return String(title || '').split('/').map((p) => p.trim()).filter((p) => nameTokens(p).length > 0);
}

module.exports = {
  nameTokens,
  tidyName,
  personKey,
  editDistance,
  namesClose,
  namesCompatible,
  titleParts,
};
