/**
 * Trailer pricing package façade.
 *
 * Pure pricing helpers for the multi-trailer agreement model: per-item rates
 * (daily/weekly/monthly/flat/bundle) and invoice-line assembly. No I/O.
 */
'use strict';

const itemPricing = require('./itemPricing');
const invoiceBuilder = require('./invoiceBuilder');

module.exports = {
  ...itemPricing,
  ...invoiceBuilder,
};
