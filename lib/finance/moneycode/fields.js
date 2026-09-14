'use strict';

/**
 * Pulling `Label: value` pairs out of a finance message. PURE.
 *
 * The production EFS format is one field per line:
 *
 *     Money Transfer code: 1491583146
 *     Report Reference: 165373918
 *     Amount: 480.00
 *     Issued to: WENZE INVESTMENTS LLC
 *     Notes: B-1 911 BRHANE GEBRU
 *
 * WHY LABELS AT ALL, RATHER THAN A CLEVERER NUMBER SCANNER. Two of those lines
 * hold a long number and only one of them is money. No amount of pattern
 * tuning tells them apart, because they are the same shape — the difference is
 * the WORD in front, which is the thing a person reads too. Scanning for
 * numbers is what made this message `ambiguous`: "two candidate codes", one of
 * which was never a code.
 *
 * A LINE WITH NO RECOGNISED LABEL IS NOT DISCARDED. It is handed back as
 * unlabelled text, because a one-line "EFS 1491583146 $480" is a real message
 * and the fallback scan in `parse.js` is what reads it.
 */

const { labelToField } = require('./labels');

/** How many leading words may form a label when there is no colon at all. */
const MAX_LABEL_WORDS = 4;

/**
 * Split a line into label and value.
 *
 * A colon is the strong signal and is tried first. Without one, progressively
 * longer word prefixes are tested and the LONGEST match wins, so "efs code"
 * beats the shorter "efs" and the value does not silently begin with "code".
 */
function splitLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;

  const colon = text.indexOf(':');
  if (colon > 0) {
    const hit = labelToField(text.slice(0, colon));
    if (hit) {
      return { ...hit, label: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() };
    }
  }

  const words = text.split(/\s+/);
  let best = null;
  for (let n = 1; n <= Math.min(MAX_LABEL_WORDS, words.length - 1); n += 1) {
    const candidate = words.slice(0, n).join(' ');
    const hit = labelToField(candidate);
    if (hit) best = { ...hit, label: candidate, value: words.slice(n).join(' ').trim(), words: n };
  }
  return best;
}

/**
 * Every labelled field in the message, plus whatever was not labelled.
 *
 * Repeats are kept rather than collapsed: two lines both claiming to be the
 * money code is a real disagreement and the caller has to see both to refuse
 * it honestly.
 */
function extractFields(text) {
  const lines = String(text || '').split(/\r?\n/);
  const fields = [];
  const unlabelled = [];

  for (const line of lines) {
    const hit = splitLine(line);
    if (hit && hit.value !== '') {
      fields.push({ field: hit.field, label: hit.label, canonical: hit.canonical, value: hit.value });
    } else if (String(line || '').trim()) {
      unlabelled.push(String(line).trim());
    }
  }

  return { fields, unlabelledText: unlabelled.join('\n') };
}

/** The values given for one field, in the order they appeared. */
function valuesFor(fields, field) {
  return (fields || []).filter((f) => f.field === field).map((f) => f.value);
}

module.exports = { MAX_LABEL_WORDS, splitLine, extractFields, valuesFor };
