'use strict';

/**
 * Which Bitrix pipeline-33 card is this driver's? By NAME only — the card is
 * titled with the driver's name and carries nothing else to match on. PURE.
 *
 * The owner's rule (11 November 2026): the same name, in any word order and
 * any case, is a match; ONE letter different in one word (of four letters or
 * more) is still a match — "Goowin" / "Goodwin". Anything further apart is a
 * different person. Two cards matching is no match at all: Wenze then moves
 * nothing and says so.
 */

function tidyWords(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z\s'-]/g, ' ').split(/\s+/).filter((w) => w.length > 1).sort();
}

/** Levenshtein distance, stopping early above 1. */
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The same driver by the owner's one-letter rule. */
function sameDriver(a, b) {
  const x = tidyWords(a);
  const y = tidyWords(b);
  if (!x.length || x.length !== y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const unmatched = y.slice();
  const left = [];
  for (const w of x) {
    const k = unmatched.indexOf(w);
    if (k >= 0) unmatched.splice(k, 1); else left.push(w);
  }
  return left.length === 1 && unmatched.length === 1 && Math.min(left[0].length, unmatched[0].length) >= 4
    && withinOneEdit(left[0], unmatched[0]);
}

/**
 * @param {string} driverName
 * @param {{id, title}[]} cards
 * @returns {{card: object} | {none: true} | {ambiguous: number}}
 */
function matchCard(driverName, cards) {
  const hits = (cards || []).filter((c) => sameDriver(driverName, c.title));
  if (hits.length === 1) return { card: hits[0] };
  return hits.length ? { ambiguous: hits.length } : { none: true };
}

/** The word to search Bitrix by: the longest one. */
function searchWord(name) {
  return tidyWords(name).sort((a, b) => b.length - a.length)[0] || null;
}

module.exports = { sameDriver, matchCard, searchWord, withinOneEdit };
