'use strict';

/**
 * Checking a model's reading of a finance message against the message. PURE.
 *
 * THE PROPERTY THIS FILE ENFORCES, and it is the only reason AI is allowed near
 * this feature at all:
 *
 *     EVERY NUMBER A MODEL RETURNS MUST ALREADY BE IN THE TEXT.
 *
 * Not "should be". Not "we ask it nicely in the prompt". A prompt is a request
 * and a model under pressure to be helpful will complete a pattern — it will
 * offer a plausible ten-digit code for a message that was too blurry to read,
 * and the result is a payment record for money nobody sent. So the digits come
 * back through here and are looked for, character by character, in the captured
 * text. A code that is not there is dropped and the reading is refused.
 *
 * WHAT AI IS ACTUALLY FOR HERE. Meaning, not measurement. "is this an issue, a
 * void, or two people arranging lunch" is a judgement about language, which is
 * what a model is good at; "which digits are the code" is a lookup, which it
 * has no business doing. So the shape below carries a KIND and a confidence,
 * and any number in it is a pointer into the message rather than a value the
 * model composed.
 *
 * A refusal here is not a failure of the feature. It is the feature: the
 * message stays exactly as captured and a person decides.
 */

const { scanCodes, scanAmounts } = require('./moneycode/values');

/** What a model is allowed to conclude. Anything else is refused outright. */
const AI_KIND = Object.freeze({
  ISSUE: 'issue',
  VOID_COMPLETED: 'void_completed',
  VOID_REQUEST: 'void_request',
  REPLACEMENT: 'replacement',
  UNRELATED: 'unrelated',
  UNCLEAR: 'unclear',
});

const KINDS = Object.freeze(Object.values(AI_KIND));

/** Digits only, so "1491-583-146" in the reply still matches the message. */
function digitsOnly(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

/**
 * Is this exact run of digits present in the message?
 *
 * Compared against the message's own digit runs rather than a substring of the
 * whole text: a substring test would accept "4915" out of the middle of
 * "1491583146", which is not the same number and never was.
 */
function codeIsInText(code, text) {
  const wanted = digitsOnly(code);
  if (!wanted) return false;
  return scanCodes(text).includes(wanted)
    || (String(text || '').match(/\d[\d\s-]*\d/g) || [])
      .some((run) => digitsOnly(run) === wanted);
}

/** Is this amount one the message actually states? */
function amountIsInText(amount, text) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return false;
  if (scanAmounts(text).includes(value)) return true;
  // A labelled or bare figure — the same numbers `values.amountFrom` would read.
  const bare = String(text || '').match(/\b\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\b/g) || [];
  return bare.some((raw) => Number(String(raw).replace(/,/g, '')) === value);
}

/** Is this run of text present in the message, ignoring case and spacing? */
function textIsInMessage(value, text) {
  const wanted = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!wanted) return false;
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').includes(wanted);
}

/**
 * Take a model's reading apart and keep only what the message supports.
 *
 * @param reading  whatever came back from the model
 * @param text     the captured message, verbatim
 * @returns `{ ok, kind, code, amount, reportReference, issuedTo, referencesCode,
 *   confidence, dropped, reason }`
 *
 * `dropped` names every field that was refused, so a reading that came back
 * mostly invented is visible as such in the audit rather than quietly thin.
 */
function verifyAiReading(reading, text) {
  const dropped = [];
  const refuse = (reason) => ({
    ok: false, kind: AI_KIND.UNCLEAR, code: null, amount: null,
    reportReference: null, issuedTo: null, referencesCode: null,
    confidence: 0, dropped, reason,
  });

  if (!reading || typeof reading !== 'object') return refuse('no reading');

  const kind = String(reading.kind || '').trim();
  if (!KINDS.includes(kind)) return refuse(`"${kind}" is not a kind this accepts`);

  const confidence = Number(reading.confidence);
  const safeConfidence = Number.isFinite(confidence)
    ? Math.max(0, Math.min(100, Math.round(confidence)))
    : 0;

  const source = String(text || '');

  let code = null;
  if (reading.code != null && String(reading.code).trim() !== '') {
    if (codeIsInText(reading.code, source)) code = digitsOnly(reading.code);
    else dropped.push('code');
  }

  let referencesCode = null;
  if (reading.referencesCode != null && String(reading.referencesCode).trim() !== '') {
    if (codeIsInText(reading.referencesCode, source)) referencesCode = digitsOnly(reading.referencesCode);
    else dropped.push('referencesCode');
  }

  let amount = null;
  if (reading.amount != null && String(reading.amount).trim?.() !== '') {
    if (amountIsInText(reading.amount, source)) amount = Number(reading.amount);
    else dropped.push('amount');
  }

  let reportReference = null;
  if (reading.reportReference != null && String(reading.reportReference).trim() !== '') {
    if (codeIsInText(reading.reportReference, source)) reportReference = digitsOnly(reading.reportReference);
    else dropped.push('reportReference');
  }

  let issuedTo = null;
  if (reading.issuedTo != null && String(reading.issuedTo).trim() !== '') {
    if (textIsInMessage(reading.issuedTo, source)) issuedTo = String(reading.issuedTo).trim();
    else dropped.push('issuedTo');
  }

  // An ISSUE whose code the message does not contain is the exact failure this
  // exists to stop. There is nothing to salvage; it is refused whole.
  if (kind === AI_KIND.ISSUE && !code) {
    return refuse('the reading claims a code the message does not contain');
  }
  if ((kind === AI_KIND.VOID_COMPLETED || kind === AI_KIND.REPLACEMENT)
    && reading.referencesCode != null && !referencesCode) {
    return refuse('the reading points at a code the message does not contain');
  }

  return {
    ok: true, kind, code, amount, reportReference, issuedTo, referencesCode,
    confidence: safeConfidence, dropped,
    reason: dropped.length ? `dropped: ${dropped.join(', ')}` : null,
  };
}

module.exports = {
  AI_KIND, KINDS, digitsOnly, codeIsInText, amountIsInText, textIsInMessage, verifyAiReading,
};
