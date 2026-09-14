'use strict';

/**
 * Reading one finance message. PURE — no I/O, no model, no clock.
 *
 * WHAT CHANGED AT VERSION 2, and why it was not a keyword patch. The live EFS
 * format is
 *
 *     Money Transfer code: 1491583146
 *     Report Reference: 165373918
 *     Amount: 480.00
 *
 * and version 1 answered `not_moneycode`: "money transfer code" was not in its
 * keyword list. Adding the phrase would have moved the answer to `ambiguous` —
 * two long numbers, one of them a reference that was never a code, and
 * `Amount: 480.00` invisible because the amount pattern demanded a `$`. Three
 * separate failures in one message, so the parser reads LABELS now. The word in
 * front of a number is what tells a person which number it is, and it is what
 * tells this.
 *
 * THE STATUSES ARE STILL THE POINT. `ambiguous` and `unparsed` are outcomes,
 * not failures: whatever cannot be read with certainty is left for a person and
 * the raw text is always kept. What version 2 removes is the cases that were
 * only uncertain because nobody had taught it to read.
 *
 * FUZZY ON THE LABEL, EXACT ON THE VALUE. See `labels.js` — that line is the
 * one safety property this module has.
 */

const { FIELD } = require('./labels');
const { extractFields, valuesFor } = require('./fields');
const values = require('./values');
const { classifyVoidLanguage, VOID_KIND } = require('../void/intent');

/** Bump on ANY change to what this returns for the same input. */
const PARSER_VERSION = 2;

const STATUS = Object.freeze({
  PARSED: 'parsed',
  AMBIGUOUS: 'ambiguous',
  UNPARSED: 'unparsed',
  NOT_MONEYCODE: 'not_moneycode',
  /** Somebody said a code WAS voided. The target is decided elsewhere. */
  VOID_ACTION: 'void_action',
  /** Somebody asked for a void, or asked whether to. Not the same thing. */
  VOID_REQUEST: 'void_request',
  /** Finance words, and a reading a person has to settle. */
  NEEDS_REVIEW: 'needs_review',
});

/**
 * The words that make a message finance business at all, for text that carries
 * no recognised label. A labelled message needs no keyword — the label IS the
 * keyword, which is why the production format now reads without one.
 */
const KEYWORDS = Object.freeze([
  'money code', 'moneycode', 'money-code', 'money transfer',
  'comchek', 'comcheck', 'com check', 'comdata',
  'efs', 't-chek', 'tchek', 'tcheck',
  'fuel advance', 'advance', 'express code', 'check code',
]);

function hasKeyword(text) {
  const lower = String(text || '').toLowerCase();
  return KEYWORDS.some((word) => lower.includes(word));
}

function firstOrNull(list) {
  return list.length ? list[0] : null;
}

function emptyResult(status, extra = {}) {
  return {
    parserVersion: PARSER_VERSION,
    status,
    code: null,
    codeNormalized: null,
    reportReference: null,
    amount: null,
    currency: 'USD',
    issuedTo: null,
    notes: null,
    codes: [],
    amounts: [],
    labelled: false,
    fields: [],
    void: null,
    reason: null,
    ...extra,
  };
}

/**
 * The money code, from labelled fields when there are any.
 *
 * Several money-code labels naming DIFFERENT codes is a disagreement inside one
 * message and comes back ambiguous. Several naming the same code is one code
 * said twice, which is not a disagreement at all.
 */
function labelledCode(fields) {
  const raw = valuesFor(fields, FIELD.MONEY_CODE);
  if (!raw.length) return null;

  const found = [];
  for (const value of raw) {
    const hit = values.codeFrom(value);
    if (!hit) continue;
    if (hit.ambiguous) return { ambiguous: true, digits: hit.digits };
    found.push(hit);
  }
  if (!found.length) return { labelledButEmpty: true };

  const distinct = [...new Set(found.map((f) => f.digits))];
  if (distinct.length > 1) return { ambiguous: true, digits: distinct };
  return found[0];
}

/** The amount, preferring a labelled one. Two different amounts is ambiguous. */
function resolveAmount(fields, text) {
  const labelled = valuesFor(fields, FIELD.AMOUNT)
    .map((v) => values.amountFrom(v))
    .filter((v) => v !== null);
  const distinctLabelled = [...new Set(labelled)];
  if (distinctLabelled.length === 1) return { amount: distinctLabelled[0], candidates: distinctLabelled };
  if (distinctLabelled.length > 1) return { amount: null, candidates: distinctLabelled, ambiguous: true };

  const scanned = values.scanAmounts(text);
  if (scanned.length === 1) return { amount: scanned[0], candidates: scanned };
  if (scanned.length > 1) return { amount: null, candidates: scanned, ambiguous: true };
  return { amount: null, candidates: [] };
}

/**
 * Read one message.
 *
 * Back-compatible with version 1 for every field a caller already read:
 * `status`, `code`, `codeNormalized`, `amount`, `currency`, `codes`, `amounts`,
 * `parserVersion` and `reason` all keep their meaning. The new fields are
 * additions.
 */
function parseMoneycodeMessage(text) {
  const source = String(text || '');
  const { fields, unlabelledText } = extractFields(source);
  const hasLabels = fields.length > 0;

  // A void or a request to void is a different kind of message from an issue,
  // and it is asked FIRST: "void 1491583146" carries a code and must never be
  // read as issuing one.
  const voiding = classifyVoidLanguage(source);
  if (voiding.kind === VOID_KIND.COMPLETED || voiding.kind === VOID_KIND.REQUEST) {
    // ONE MESSAGE DOING TWO THINGS. "Voided — replacement below:" followed by a
    // labelled money code is a real shape, and reading it as only a void threw
    // the new code away silently: the status was settled, so nothing flagged
    // it, and the money in it would never have appeared anywhere. A code
    // merely NAMED in the prose of a void ("void 1491583146") is still just the
    // void's subject — it takes an explicit label to mean a message is also
    // issuing. Either way nothing here decides; it goes to a person.
    const alsoIssues = labelledCode(fields);
    if (alsoIssues && alsoIssues.digits && !alsoIssues.ambiguous) {
      return emptyResult(STATUS.NEEDS_REVIEW, {
        void: voiding,
        codes: [...new Set([...voiding.codes, alsoIssues.digits])],
        fields,
        labelled: hasLabels,
        reason: 'the message both reports a void and issues a code',
      });
    }
    return emptyResult(
      voiding.kind === VOID_KIND.COMPLETED ? STATUS.VOID_ACTION : STATUS.VOID_REQUEST,
      {
        void: voiding,
        codes: voiding.codes,
        fields,
        labelled: hasLabels,
        reason: voiding.reason,
      },
    );
  }

  if (!hasLabels && !hasKeyword(source)) {
    return emptyResult(STATUS.NOT_MONEYCODE, { reason: 'no finance label or keyword' });
  }

  const reference = firstOrNull(valuesFor(fields, FIELD.REFERENCE));
  const issuedTo = firstOrNull(valuesFor(fields, FIELD.ISSUED_TO));
  const notes = firstOrNull(valuesFor(fields, FIELD.NOTES));

  const amount = resolveAmount(fields, source);
  const code = labelledCode(fields);

  const base = {
    fields,
    labelled: hasLabels,
    reportReference: reference,
    issuedTo,
    notes,
    amounts: amount.candidates,
    void: null,
  };

  if (code && code.ambiguous) {
    return emptyResult(STATUS.AMBIGUOUS, {
      ...base, codes: code.digits, reason: `${code.digits.length} candidate codes`,
    });
  }

  if (code && code.digits) {
    if (amount.ambiguous) {
      return emptyResult(STATUS.AMBIGUOUS, {
        ...base, codes: [code.digits], reason: `${amount.candidates.length} candidate amounts`,
      });
    }
    return emptyResult(STATUS.PARSED, {
      ...base,
      code: code.code,
      codeNormalized: code.digits,
      amount: amount.amount,
      codes: [code.digits],
      reason: null,
    });
  }

  // NOTHING LABELLED AS THE CODE. Fall back to scanning, but only the text that
  // was NOT claimed by another label — which is what keeps a report reference
  // from becoming a candidate code and is the whole fix for the live format.
  const scanned = values.scanCodes(hasLabels ? unlabelledText : source);
  if (scanned.length === 0) {
    return emptyResult(STATUS.UNPARSED, {
      ...base, codes: [], reason: 'a finance message with no code this recognises',
    });
  }
  if (scanned.length > 1) {
    return emptyResult(STATUS.AMBIGUOUS, {
      ...base, codes: scanned, reason: `${scanned.length} candidate codes`,
    });
  }
  if (amount.ambiguous) {
    return emptyResult(STATUS.AMBIGUOUS, {
      ...base, codes: scanned, reason: `${amount.candidates.length} candidate amounts`,
    });
  }

  return emptyResult(STATUS.PARSED, {
    ...base,
    code: scanned[0],
    codeNormalized: scanned[0],
    amount: amount.amount,
    codes: scanned,
    reason: null,
  });
}

module.exports = { PARSER_VERSION, STATUS, KEYWORDS, parseMoneycodeMessage, hasKeyword };
