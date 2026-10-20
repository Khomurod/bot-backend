'use strict';

/**
 * "Is this the same driver?", forgiving the near misses seen in production.
 * Pure.
 *
 * `driverNamesMatch` (driverGroupTitle.js) stays exactly as strict as it is:
 * the board resolution runs it against the WHOLE fleet, where a looser rule
 * would let one driver's row land on another's, and its normaliser keys board
 * rows. This is for the places where the field is already narrowed to one
 * truck or one chat, so a near miss is evidence rather than a risk:
 *
 *   - linking a chat to its Samsara vehicle (services/duplicateUnitCheckService.js)
 *   - the one person in a driver's chat (lib/identity/telegramResolution.js)
 *
 * On top of `driverNamesMatch` it accepts three things the owner's review of
 * 20 October 2026 found blocking a correct link:
 *
 *   an apostrophe        "Charlie O'Neal Jr"  ↔ "CHARLIE ONEAL"
 *   one letter off       "TERENCE NESBITT"    ↔ "TERRENCE NESBIT"
 *                        — in the first AND the last name, and only in names
 *                        of four letters or more
 *   a team label         "PRINCE / OTIS"      ↔ "PRINCE BURTON"
 *                        — either half naming the driver
 *
 * A different person is still a different person: "TORREY SWATT" is not
 * "JAVOKHIR ISLOMOV", and nothing here makes it so.
 */

const { driverNamesMatch, normalizePersonName } = require('./driverGroupTitle');

const MIN_TYPO_TOKEN = 4;

/** "O'Neal" → "ONeal": an apostrophe joins a name, it does not split it. */
function joinApostrophes(value) {
  return String(value || '').replace(/['’`ʼ]/g, '');
}

function tokens(value) {
  return normalizePersonName(joinApostrophes(value)).split(' ').filter((t) => t.length >= 2);
}

/** True when `a` becomes `b` by one insertion, deletion or substitution. */
function oneEditApart(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (s.length === l.length) i += 1;
    j += 1;
  }
  return edits + (l.length - j) <= 1;
}

function closeTokens(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return Math.min(a.length, b.length) >= MIN_TYPO_TOKEN && oneEditApart(a, b);
}

/** First and last name each equal or one letter apart. */
function typoMatch(expected, actual) {
  const a = tokens(expected);
  const b = tokens(actual);
  if (a.length < 2 || b.length < 2) return false;
  return closeTokens(a[0], b[0]) && closeTokens(a[a.length - 1], b[b.length - 1]);
}

/** "PRINCE / OTIS" → ["PRINCE", "OTIS"]; a name with no slash → [name]. */
function teamParts(value) {
  return String(value || '').split('/').map((p) => p.trim()).filter(Boolean);
}

function namesLikelySame(expected, actual) {
  if (!normalizePersonName(expected) || !normalizePersonName(actual)) return false;
  if (driverNamesMatch(expected, actual)) return true;
  if (driverNamesMatch(joinApostrophes(expected), joinApostrophes(actual))) return true;
  if (typoMatch(expected, actual)) return true;

  const left = teamParts(expected);
  const right = teamParts(actual);
  if (left.length < 2 && right.length < 2) return false;
  return left.some((a) => right.some((b) => (a !== expected || b !== actual)
    && (driverNamesMatch(a, b) || typoMatch(a, b))));
}

module.exports = { namesLikelySame, oneEditApart, joinApostrophes };
