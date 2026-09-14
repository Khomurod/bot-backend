'use strict';

/**
 * The words staff put in front of a number, and how forgiving we are about
 * them. PURE — text in, a field name out. No I/O, no model.
 *
 * THE ONE RULE THAT MAKES FUZZY MATCHING SAFE HERE: tolerance applies to the
 * LABEL and never to the VALUE. "Money Trasfer Code" still means money code,
 * but the digits after it are copied exactly as written or not taken at all.
 * A parser that could "correct" a number is a parser that can invent money,
 * and no amount of convenience is worth that.
 *
 * WHY A DISTANCE AND NOT A LIST OF TYPOS. A hardcoded list of the three
 * misspellings somebody has made so far is a list that is wrong the first time
 * a fourth person types something. The vocabulary below is the set of things a
 * label MEANS; the matcher below decides how far from one a piece of text may
 * be. Adding a new issuer is one line in the vocabulary, not a new branch.
 *
 * THE TOLERANCE IS PROPORTIONAL, and short labels get none. "efs" is three
 * characters, so one edit reaches "eft", "ef" and "efs" alike; allowing that
 * would make an unrelated word a finance label. Anything under five characters
 * must match exactly.
 */

/**
 * Field names this recognises. `REFERENCE` exists so a report reference can be
 * told apart from a money code — the whole reason the production format read as
 * two competing codes and came out `ambiguous`.
 */
const FIELD = Object.freeze({
  MONEY_CODE: 'money_code',
  REFERENCE: 'reference',
  AMOUNT: 'amount',
  ISSUED_TO: 'issued_to',
  NOTES: 'notes',
});

/**
 * What each field can be called. Order matters only in that the LONGEST match
 * wins, so "money transfer code" is never read as the shorter "code".
 */
const VOCABULARY = Object.freeze([
  [FIELD.MONEY_CODE, [
    'money transfer code', 'money transfer', 'transfer code',
    'money code', 'moneycode', 'money',
    'efs code', 'efs money code', 'efs',
    'express code', 'express check',
    'comchek', 'comcheck', 'com check', 'comdata code',
    't chek code', 'tchek', 'tcheck', 't check code',
    'check code', 'fuel advance code', 'advance code', 'code',
  ]],
  [FIELD.REFERENCE, [
    'report reference', 'reference number', 'reference', 'report ref',
    'ref number', 'ref',
  ]],
  [FIELD.AMOUNT, ['amount', 'total amount', 'total', 'value', 'sum']],
  [FIELD.ISSUED_TO, [
    'issued to', 'issue to', 'issued for', 'payee', 'recipient', 'paid to',
    'beneficiary',
  ]],
  [FIELD.NOTES, ['notes', 'note', 'memo', 'comment', 'remarks', 'description']],
]);

/**
 * Lowercase, drop punctuation, collapse whitespace.
 *
 * Punctuation goes because a missing or doubled colon is the commonest
 * variation there is and it changes nothing about what was meant.
 */
function normaliseLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The same, with spaces removed — so "moneycode" and "money code" are one. */
function squash(text) {
  return normaliseLabel(text).replace(/ /g, '');
}

/**
 * How many single-character edits separate two strings, giving up once the
 * answer is certainly over `max`.
 *
 * Bounded on purpose: this runs per line per label, and an unbounded distance
 * on a long line of prose is work spent proving something is not a label.
 */
function editDistanceWithin(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    // Every remaining answer is at least `best`; stop when that already loses.
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * How wrong a label may be before it stops being that label.
 *
 * Under five characters: exactly right or nothing. `efs` and `ref` are real
 * labels and also three letters; one edit from either reaches a great many
 * words that are not labels at all.
 */
function toleranceFor(canonical) {
  if (canonical.length < 5) return 0;
  if (canonical.length < 10) return 1;
  return 2;
}

/**
 * Which field is this text the label for? `null` when it is not one.
 *
 * The longest canonical form that matches wins, so a line reading
 * "money transfer code" is a money code rather than the shorter "money".
 */
function labelToField(text) {
  const candidate = squash(text);
  if (!candidate || candidate.length > 40) return null;

  let best = null;
  for (const [field, forms] of VOCABULARY) {
    for (const form of forms) {
      const canonical = squash(form);
      const tolerance = toleranceFor(canonical);
      const distance = editDistanceWithin(candidate, canonical, tolerance);
      if (distance > tolerance) continue;
      // Longer canonical first, then the closer spelling.
      if (!best || canonical.length > best.length
        || (canonical.length === best.length && distance < best.distance)) {
        best = { field, length: canonical.length, distance, canonical: form };
      }
    }
  }
  return best ? { field: best.field, canonical: best.canonical, distance: best.distance } : null;
}

module.exports = {
  FIELD, VOCABULARY, normaliseLabel, squash, editDistanceWithin, toleranceFor, labelToField,
};
