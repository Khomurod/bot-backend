/**
 * Trailer agreements service façade.
 *
 * The orchestration layer for multi-trailer rental agreements: create, amend,
 * schedule/activate/return items, and invoice. Every operation that changes
 * items re-derives the agreement status in the same transaction. Pure helpers
 * (status derivation, pricing) live under services/trailerAgreements/
 * statusDerivation.js and services/trailerPricing/.
 */
'use strict';

const lifecycle = require('./lifecycle');
const activation = require('./activation');
const returns = require('./returns');
const invoicing = require('./invoicing');
const amendmentOps = require('./amendmentOps');
const { deriveAgreementStatus } = require('./statusDerivation');
const { estimateAgreement } = require('./estimate');

module.exports = {
  ...lifecycle,
  ...activation,
  ...returns,
  ...invoicing,
  ...amendmentOps,
  deriveAgreementStatus,
  estimateAgreement,
};
