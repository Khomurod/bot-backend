'use strict';

/**
 * Reading a money-code message — the stable import path.
 *
 * Composition and re-export ONLY. The implementation is
 * `lib/finance/moneycode/`:
 *
 *   labels.js  what a field can be called, and how wrong a LABEL may be
 *   fields.js  splitting `Label: value` out of a message
 *   values.js  turning the text after a label into digits or an amount —
 *              the half where nothing is fuzzy
 *   parse.js   the statuses, and the order the evidence is weighed in
 *
 * Every existing caller keeps working: `parseMoneycodeMessage`, `STATUS`,
 * `KEYWORDS`, `PARSER_VERSION` and `normaliseCode` mean what they did, and the
 * result keeps every field version 1 returned.
 */

const parse = require('./moneycode/parse');
const values = require('./moneycode/values');
const labels = require('./moneycode/labels');
const fields = require('./moneycode/fields');

module.exports = {
  PARSER_VERSION: parse.PARSER_VERSION,
  STATUS: parse.STATUS,
  KEYWORDS: parse.KEYWORDS,
  parseMoneycodeMessage: parse.parseMoneycodeMessage,
  hasKeyword: parse.hasKeyword,
  normaliseCode: values.normaliseCode,
  scanCodes: values.scanCodes,
  scanAmounts: values.scanAmounts,
  FIELD: labels.FIELD,
  labelToField: labels.labelToField,
  extractFields: fields.extractFields,
};
