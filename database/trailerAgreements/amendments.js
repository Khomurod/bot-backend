/**
 * Agreement amendments — immutable, append-only ledger data access.
 *
 * Every material change to an agreement after creation (add/remove/replace a
 * trailer, change an amount or rate, extend a return, change terms) is recorded
 * as an amendment. There is deliberately NO update path: amendments are history
 * and must never be rewritten. Corrections are new amendments.
 */
'use strict';

const { query } = require('../pool');

async function nextAmendmentNumber(agreementId, client = { query }) {
  const res = await client.query(
    'SELECT COALESCE(MAX(amendment_number), 0) + 1 AS n FROM trailer_rental_amendments WHERE agreement_id = $1',
    [Number(agreementId)],
  );
  return res.rows[0].n;
}

/** Append an amendment. Returns the created row. Immutable thereafter. */
async function createAmendment(agreementId, input = {}, client = { query }) {
  const number = input.amendment_number || (await nextAmendmentNumber(agreementId, client));
  const cols = {
    agreement_id: Number(agreementId),
    amendment_number: number,
    amendment_type: input.amendment_type,
    effective_date: input.effective_date || new Date(),
    previous_amount: input.previous_amount ?? null,
    change_amount: input.change_amount ?? null,
    new_amount: input.new_amount ?? null,
    previous_pricing_terms: input.previous_pricing_terms
      ? JSON.stringify(input.previous_pricing_terms) : null,
    new_pricing_terms: input.new_pricing_terms ? JSON.stringify(input.new_pricing_terms) : null,
    reason: input.reason || null,
    notes: input.notes || null,
    supporting_media_id: input.supporting_media_id || null,
    rental_item_id: input.rental_item_id || null,
    created_by_admin_id: input.created_by_admin_id || null,
  };
  const keys = Object.keys(cols);
  const res = await client.query(
    `INSERT INTO trailer_rental_amendments (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => cols[k]),
  );
  return res.rows[0];
}

async function listAmendments(agreementId, client = { query }) {
  const res = await client.query(
    'SELECT * FROM trailer_rental_amendments WHERE agreement_id = $1 ORDER BY amendment_number',
    [Number(agreementId)],
  );
  return res.rows;
}

module.exports = { nextAmendmentNumber, createAmendment, listAmendments };
