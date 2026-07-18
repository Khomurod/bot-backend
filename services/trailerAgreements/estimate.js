/**
 * Server-validated rental estimate (§1).
 *
 * The wizard's Price step must not rely on a client-side calculation alone —
 * this computes the estimate with the SAME pure pricing helpers invoicing uses
 * (services/trailerPricing), so what the employee sees at review time is what
 * an invoice would bill. Stateless: nothing is written and no rows are read;
 * the draft payload carries everything.
 */
'use strict';

const { buildInvoiceLines } = require('../trailerPricing/invoiceBuilder');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * @param {object} draft { pricing_mode, current_agreed_amount, agreement_discount,
 *                         deposit_amount, billing_timezone, items: [{ pricing_mode,
 *                         daily_rate…, scheduled_pickup_at, expected_return_at }] }
 * @returns {object} { lines, subtotal, discount, deposit, estimated_due, warnings }
 */
function estimateAgreement(draft = {}) {
  const timezone = draft.billing_timezone || 'America/Chicago';
  const warnings = [];
  const items = Array.isArray(draft.items) ? draft.items : [];
  if (!items.length) warnings.push('No trailers on this rental yet.');

  const TIME_BASED = new Set(['daily', 'weekly', 'monthly']);
  const entries = items.map((item, i) => {
    const startAt = item.scheduled_pickup_at || null;
    const endAt = item.expected_return_at || null;
    if ((!startAt || !endAt) && TIME_BASED.has(item.pricing_mode || 'daily')) {
      warnings.push(`Trailer ${i + 1} has no pickup/return window — its time-based charge is estimated as 0.`);
      // An honest estimate: without dates a time-based charge is unknowable, so
      // it contributes nothing rather than a misleading minimum day.
      return { item: { ...item, pricing_mode: 'flat', flat_amount: 0 }, window: { startAt, endAt, timezone } };
    }
    return { item, window: { startAt, endAt, timezone } };
  });

  const { lines, total } = buildInvoiceLines(draft, entries);

  const subtotal = round2(lines.reduce((s, l) => s + Number(l.base_amount || 0), 0));
  const discount = round2(lines.reduce((s, l) => s + Number(l.discount_amount || 0), 0));
  const deposit = round2(draft.deposit_amount);
  const estimatedDue = round2(Math.max(total - deposit, 0));
  if (deposit > total && total > 0) {
    warnings.push('The deposit is larger than the estimated total.');
  }

  return {
    lines,
    subtotal,
    discount,
    deposit,
    total: round2(total),
    estimated_due: estimatedDue,
    warnings,
  };
}

module.exports = { estimateAgreement };
