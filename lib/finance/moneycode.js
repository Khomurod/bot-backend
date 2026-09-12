/**
 * Reading a money-code message — pure, no I/O, no model.
 *
 * WHAT THIS IS NOT. It is not a parser that understands the company's finance
 * messages. Nobody has shown it one. It is the CAPTURE-FIRST half of the
 * Finance Monitor: every message in the finance group is stored verbatim, and
 * this says only how much of it could be read with certainty. The statuses are
 * the point, not the extraction:
 *
 *   not_moneycode  no finance keyword at all — ordinary chat, stored and ignored
 *   unparsed       a keyword, but no code this recognises
 *   ambiguous      more than one candidate code, or more than one amount
 *   parsed         exactly one code and at most one amount
 *
 * `ambiguous` and `unparsed` are OUTCOMES, not failures. A parser that guessed
 * which of two numbers was the code would produce a finance record nobody could
 * audit, and the whole feature exists to be auditable. Everything it is unsure
 * about is left for a person, and the raw text is always kept.
 *
 * PARSER_VERSION is stored on every row so that when real messages exist, a
 * tightened parser can re-read exactly the rows the old one produced — including
 * the ones it got wrong — instead of leaving a silent mix of two vocabularies in
 * the table.
 */

/** Bump on ANY change to what this function returns for the same input. */
const PARSER_VERSION = 1;

const STATUS = Object.freeze({
  PARSED: 'parsed',
  AMBIGUOUS: 'ambiguous',
  UNPARSED: 'unparsed',
  NOT_MONEYCODE: 'not_moneycode',
});

/**
 * The gate. A message without one of these is not about money and is not read
 * any further — which is what keeps an ordinary conversation in the finance
 * group out of the finance tables.
 *
 * Deliberately the vocabulary of the US trucking fuel-card world rather than a
 * generic "payment" list: these are the words that appear beside a code.
 */
const KEYWORDS = Object.freeze([
  'money code', 'moneycode', 'money-code',
  'comchek', 'comcheck', 'com check',
  'efs', 't-chek', 'tchek', 'tcheck',
  'fuel advance', 'advance',
  'express code', 'check code',
]);

/**
 * A candidate code: 6 to 16 digits, optionally grouped by spaces or dashes.
 *
 * Wide on purpose. Issuers differ and this has seen none of them, so narrowing
 * it would turn a real code into `unparsed` — which loses the record — while
 * being wide only risks `ambiguous`, which keeps it and asks a person.
 */
const CODE_PATTERN = /\b\d[\d\s-]{4,20}\d\b/g;

/** $1,234.56 / 1234.56 / USD 1234 — the amount, with or without a symbol. */
const AMOUNT_PATTERN = /(?:\$|\bUSD\s*)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\b/gi;

function normaliseCode(raw) {
  return String(raw || '').replace(/[\s-]/g, '');
}

function hasKeyword(text) {
  const lower = String(text || '').toLowerCase();
  return KEYWORDS.some((word) => lower.includes(word));
}

/**
 * Digit runs that are plausibly a code.
 *
 * An amount is excluded by matching the amount pattern FIRST and blanking what
 * it consumed, so "$500" never becomes code 500. A run of exactly 4 digits that
 * reads as a year is not excluded — that is the kind of guess this refuses to
 * make, and two candidates is an honest `ambiguous`.
 */
function candidateCodes(text) {
  const withoutAmounts = String(text || '').replace(AMOUNT_PATTERN, ' ');
  const found = withoutAmounts.match(CODE_PATTERN) || [];
  const codes = [];
  for (const raw of found) {
    const digits = normaliseCode(raw);
    if (digits.length >= 6 && digits.length <= 16) codes.push(digits);
  }
  return [...new Set(codes)];
}

function candidateAmounts(text) {
  const amounts = [];
  const source = String(text || '');
  for (const match of source.matchAll(AMOUNT_PATTERN)) {
    const value = Number(String(match[1]).replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0) amounts.push(value);
  }
  return [...new Set(amounts)];
}

/**
 * Read one message.
 *
 * Returns `{ status, parserVersion, code, codeNormalized, amount, currency,
 * codes, amounts, reason }`. `code` and `amount` are set ONLY on `parsed`;
 * every status carries the full candidate lists, so a person looking at an
 * `ambiguous` row sees what the machine saw rather than having to re-read the
 * message themselves.
 */
function parseMoneycodeMessage(text) {
  const base = { parserVersion: PARSER_VERSION, code: null, codeNormalized: null, amount: null, currency: 'USD' };
  const source = String(text || '');

  if (!hasKeyword(source)) {
    return { ...base, status: STATUS.NOT_MONEYCODE, codes: [], amounts: [], reason: 'no finance keyword' };
  }

  const codes = candidateCodes(source);
  const amounts = candidateAmounts(source);

  if (codes.length === 0) {
    return { ...base, status: STATUS.UNPARSED, codes, amounts, reason: 'a finance keyword but no code this recognises' };
  }
  if (codes.length > 1) {
    return { ...base, status: STATUS.AMBIGUOUS, codes, amounts, reason: `${codes.length} candidate codes` };
  }
  if (amounts.length > 1) {
    return { ...base, status: STATUS.AMBIGUOUS, codes, amounts, reason: `${amounts.length} candidate amounts` };
  }

  return {
    ...base,
    status: STATUS.PARSED,
    code: codes[0],
    codeNormalized: codes[0],
    amount: amounts.length === 1 ? amounts[0] : null,
    codes,
    amounts,
    reason: null,
  };
}

module.exports = {
  PARSER_VERSION,
  STATUS,
  KEYWORDS,
  parseMoneycodeMessage,
  normaliseCode,
};
