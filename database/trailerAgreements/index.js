/**
 * Trailer agreements data-access façade.
 *
 * Aggregates the header, item, amendment and backfill modules into one surface
 * so callers can `require('../database/trailerAgreements')`. Each sibling module
 * has a single responsibility and depends only on ./pool and pure helpers.
 */
'use strict';

const agreements = require('./agreements');
const items = require('./items');
const amendments = require('./amendments');
const backfill = require('./backfill');

module.exports = {
  ...agreements,
  ...items,
  ...amendments,
  ...backfill,
};
