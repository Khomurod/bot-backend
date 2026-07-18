'use strict';

/**
 * Plain-language error mapping.
 *
 * Backend error codes (and the two Postgres constraint codes that can reach a
 * route) map to one short human sentence each. Routes send {error, code} with
 * the mapped message — never a raw pg error or stack trace. A message the
 * service already phrased for humans (err.status < 500 with a message) is kept
 * when no mapping exists.
 */

const MESSAGES = {
  TRAILER_OVERLAP: 'This trailer is already booked for those dates. Choose another trailer or change the dates.',
  VERSION_CONFLICT: 'This record changed while you were editing. Reload and try again.',
  PICKUP_INSPECTION_INCOMPLETE: 'Finish the pickup inspection and add the pickup photo before confirming this pickup.',
  RETURN_INSPECTION_INCOMPLETE: 'Finish the return inspection and add the return photo before completing this return.',
  DAMAGE_STATUS_REQUIRED: 'A trailer with new damage cannot be marked available. Choose a different condition.',
  DAMAGE_EVIDENCE_REQUIRED: 'Describe the new damage and add at least one photo of it first.',
  CREDIT_EXHAUSTED: 'This credit has already been fully used.',
  CREDIT_OVER_APPLY: 'That is more than the remaining credit balance.',
  CREDIT_COMPANY_MISMATCH: 'This credit belongs to a different company.',
  INVOICE_REQUIRED: 'Choose the invoice this credit should be applied to.',
  INVOICE_ALREADY_PAID: 'This invoice is already fully paid.',
  AGREEMENT_NOT_CLOSABLE: 'This rental cannot be completed yet — every trailer must be returned or resolved first.',
  ITEM_STATUS_NOT_ALLOWED: 'A new trailer on a rental always starts as “being set up” (or “pickup planned” when its dates are set).',
  AGREEMENT_STATUS_NOT_ALLOWED: 'A new rental always starts as “being set up”.',
  AGREEMENT_TERMINAL: 'This rental is already completed or cancelled and can no longer be changed.',
  ITEM_NOT_ACTIVATABLE: 'Only a trailer that has not been picked up yet can be confirmed for pickup.',
  ITEM_NOT_ACTIVE: 'Only a trailer that is currently rented can be returned.',
  ITEM_NOT_REMOVABLE: 'Only a trailer that has not been picked up can be removed.',
  ITEM_NOT_REPLACEABLE: 'Only a trailer that has not been picked up can be replaced.',
  TRAILER_NOT_FOUND: 'That trailer could not be found.',
  TRAILER_NOT_OFFICIAL: 'This trailer is not on the official trailer list and cannot be rented.',
  TRAILER_NOT_IN_MASTER_LIST: 'This trailer is not on the official trailer list.',
  COMPANY_REQUIRED: 'Choose the company that is renting.',
  TRAILER_REQUIRED: 'Choose a trailer.',
  NOTHING_TO_INVOICE: 'There is nothing to invoice on this rental yet.',
  // Postgres constraint violations that can surface directly.
  '23P01': 'This trailer is already booked for an overlapping period.',
  23505: 'That record already exists.',
};

/**
 * The message to show a person for this error. A message the service already
 * phrased for humans (4xx with text, often more specific — naming the trailer
 * or the dates) wins; the map covers bare codes and raw pg constraint errors.
 */
function humanMessage(err) {
  if (!err) return 'Something went wrong. Try again.';
  if (err.status && err.status < 500 && err.message) return err.message;
  const mapped = MESSAGES[err.code];
  if (mapped) return mapped;
  return 'Something went wrong. Try again.';
}

/**
 * Express-style error payload: {error, code}. 500s never leak internals.
 */
function errorPayload(err) {
  const status = err?.status || (err?.code === '23505' || err?.code === '23P01' ? 409 : 500);
  const payload = { error: humanMessage(err) };
  if (err?.code) payload.code = err.code;
  if (err?.currentVersion !== undefined) payload.currentVersion = err.currentVersion;
  return { status, payload };
}

module.exports = { MESSAGES, humanMessage, errorPayload };
