'use strict';

/**
 * Turning the text after a label into a number. PURE.
 *
 * NOTHING IN THIS FILE IS FUZZY. The label may be misspelled; the value may
 * not. Every digit returned here appears verbatim in the message — the only
 * transformation is dropping the spaces and dashes a person used to group a
 * code, which changes no digit. A parser that could repair "148158314" into a
 * ten-digit code would be inventing money, and the whole feature exists to be
 * auditable.
 */

/** A code is 6–16 digits, optionally grouped by spaces or dashes. */
const CODE_RUN = /\b\d[\d\s-]{4,20}\d\b/g;
const MIN_CODE_DIGITS = 6;
const MAX_CODE_DIGITS = 16;

/**
 * $1,234.56 / USD 1234 — an amount that announced itself with a symbol.
 *
 * Unlabelled text needs the symbol: a bare number in prose is as likely to be
 * a truck number or a date. A LABELLED amount does not (see `amountFrom`),
 * because the word "Amount" is the announcement.
 */
const SYMBOL_AMOUNT = /(?:\$|\bUSD\s*)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\b/gi;

/** Grouping removed. No digit is added, removed or changed. */
function normaliseCode(raw) {
  return String(raw || '').replace(/[\s-]/g, '');
}

function toAmount(raw) {
  const value = Number(String(raw == null ? '' : raw).replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Every code-shaped digit run in some text, deduplicated, order preserved. */
function scanCodes(text) {
  const withoutAmounts = String(text || '').replace(SYMBOL_AMOUNT, ' ');
  const out = [];
  for (const raw of withoutAmounts.match(CODE_RUN) || []) {
    const digits = normaliseCode(raw);
    if (digits.length >= MIN_CODE_DIGITS && digits.length <= MAX_CODE_DIGITS) out.push(digits);
  }
  return [...new Set(out)];
}

/** Every symbol-announced amount in some text. */
function scanAmounts(text) {
  const out = [];
  for (const match of String(text || '').matchAll(SYMBOL_AMOUNT)) {
    const value = toAmount(match[1]);
    if (value !== null) out.push(value);
  }
  return [...new Set(out)];
}

/**
 * The code a labelled value holds.
 *
 * `{ code, digits }` when the value names exactly one, `null` when it names
 * none, and `{ ambiguous: true, digits: [...] }` when it names several — which
 * is a real disagreement inside one field and is never resolved by picking.
 */
function codeFrom(value) {
  const found = scanCodes(value);
  if (found.length === 0) return null;
  if (found.length > 1) return { ambiguous: true, digits: found };
  // `code` IS THE NORMALISED DIGITS, as it has been since version 1. Returning
  // the run as the person typed it — "4567 8901 2345" — was tempting and wrong:
  // the column is read by the admin and compared by people, and the grouping a
  // sender happened to use is not part of the code. The message itself is kept
  // verbatim, so nothing about how it was written is lost.
  return { code: found[0], digits: found[0] };
}

/**
 * The amount a labelled value holds — `Amount: 480.00` as readily as `$480`.
 *
 * The label is the announcement, so a bare number is accepted here and only
 * here. Anything with more than one number in it is refused rather than
 * guessed at.
 */
function amountFrom(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const symbol = scanAmounts(text);
  if (symbol.length === 1) return symbol[0];
  if (symbol.length > 1) return null;

  const bare = text.match(/\b\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\b/g) || [];
  if (bare.length !== 1) return null;
  return toAmount(bare[0]);
}

module.exports = {
  CODE_RUN, SYMBOL_AMOUNT, MIN_CODE_DIGITS, MAX_CODE_DIGITS,
  normaliseCode, scanCodes, scanAmounts, codeFrom, amountFrom,
};
