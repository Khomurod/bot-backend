/**
 * Trailer unit-number normalization and similarity — PURE functions only.
 *
 * The single owner of unit-number normalization for the whole application:
 * database/trailers.js and the master-list services all import from here, so
 * matching can never drift between the Telegram ingest path, the master-list
 * import, and the admin UI.
 *
 * No I/O, no database, no config — everything here is trivially unit-testable.
 */
'use strict';

/**
 * Canonical storage/matching form of a unit number: uppercase, with '#' and all
 * whitespace removed. Returns null for anything blank.
 *
 * This is the exact historical behavior of database/trailers.js and MUST NOT
 * change casually — every trailers.unit_number in production is already stored
 * in this form, and changing it would silently orphan existing rows.
 */
function normalizeUnitNumber(value) {
  if (value == null) return null;
  const text = String(value).toUpperCase().replace(/[#\s]+/g, '').trim();
  return text || null;
}

/**
 * Characters OCR and humans routinely confuse. Folded letter -> digit so that
 * "T-1OO" and "T-100" collapse to the same skeleton.
 *
 * Deliberately limited to the four pairs the spec calls out (0/O, 1/I, 5/S,
 * 8/B). Every extra pair increases the chance of falsely merging two genuinely
 * different trailers, which is far worse than asking a human to review.
 */
const CONFUSABLE_FOLDING = new Map([
  ['O', '0'],
  ['I', '1'],
  ['S', '5'],
  ['B', '8'],
]);

/**
 * A comparison skeleton: the normalized number with confusable characters
 * folded and separators dropped. Two different unit numbers sharing a skeleton
 * are a likely OCR conflict — a REVIEW signal, never an automatic merge.
 */
function confusableSkeleton(value) {
  const normalized = normalizeUnitNumber(value);
  if (!normalized) return null;
  let skeleton = '';
  for (const char of normalized.replace(/[-_./]+/g, '')) {
    skeleton += CONFUSABLE_FOLDING.get(char) || char;
  }
  return skeleton || null;
}

/** True when two unit numbers differ but are plausibly the same OCR'd value. */
function isConfusablePair(a, b) {
  const left = normalizeUnitNumber(a);
  const right = normalizeUnitNumber(b);
  if (!left || !right || left === right) return false;
  const leftSkeleton = confusableSkeleton(left);
  return Boolean(leftSkeleton) && leftSkeleton === confusableSkeleton(right);
}

/** Levenshtein edit distance. Iterative single-row: O(a*b) time, O(b) space. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      current[j + 1] = Math.min(
        previous[j + 1] + 1, // deletion
        current[j] + 1, // insertion
        previous[j] + (a[i] === b[j] ? 0 : 1), // substitution
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Similarity in [0,1]. Confusable-folded, so "T-1OO" scores 1 against "T-100":
 * the pair is identical to a human eye and should rank top of the suggestions.
 */
function similarity(a, b) {
  const left = confusableSkeleton(a);
  const right = confusableSkeleton(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const longest = Math.max(left.length, right.length);
  return (longest - editDistance(left, right)) / longest;
}

/**
 * Rank known unit numbers by similarity to an unmatched one, for the
 * "suggested similar known trailers" hint on the review queue.
 *
 * Suggestions are a HUMAN AID ONLY. Nothing downstream may auto-link on them.
 *
 * @param {string} unitNumber unmatched number
 * @param {Array<{id:number, unit_number:string}>} candidates known trailers
 * @param {object} [options]
 * @param {number} [options.limit=5]
 * @param {number} [options.threshold=0.6] minimum similarity to suggest at all
 * @returns {Array<{id:number, unit_number:string, similarity:number, confusable:boolean}>}
 */
function suggestSimilar(unitNumber, candidates = [], options = {}) {
  const { limit = 5, threshold = 0.6 } = options;
  const target = normalizeUnitNumber(unitNumber);
  if (!target) return [];
  return candidates
    .map((candidate) => ({
      id: candidate.id,
      unit_number: candidate.unit_number,
      similarity: similarity(target, candidate.unit_number),
      confusable: isConfusablePair(target, candidate.unit_number),
    }))
    .filter((candidate) => candidate.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity || String(a.unit_number).localeCompare(String(b.unit_number)))
    .slice(0, limit);
}

module.exports = {
  normalizeUnitNumber,
  confusableSkeleton,
  isConfusablePair,
  similarity,
  suggestSimilar,
  editDistance,
};
