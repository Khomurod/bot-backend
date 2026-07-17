/**
 * Pure invoice-line builder for multi-trailer agreements.
 *
 * Turns a set of rental items (plus optional bundle terms and per-item return
 * charges) into invoice lines and a total. Two modes:
 *   - combined: every item on one invoice (one line per trailer + bundle line).
 *   - separate: caller invokes buildItemLines() per item and issues N invoices.
 *
 * No I/O — the caller persists the returned lines into trailer_invoice_lines and
 * maintains the denormalized trailer_invoices column totals.
 */
'use strict';

const { priceItem, round2 } = require('./itemPricing');

/**
 * Build one rental line for an item, folding in any return charges passed by the
 * caller (damage/cleaning/late/other from the return dialog).
 */
function buildItemLine(item, window, charges = {}) {
  const priced = priceItem(item, window);
  const damage = round2(charges.damage_charge ?? charges.damageCharge ?? 0);
  const cleaning = round2(charges.cleaning_charge ?? charges.cleaningCharge ?? 0);
  const late = round2(charges.late_fee ?? charges.lateFee ?? 0);
  const other = round2(charges.other_charge ?? charges.otherCharge ?? 0);
  const lineTotal = round2(priced.lineTotal + damage + cleaning + late + other);
  return {
    agreement_item_id: item.id ?? null,
    trailer_id: item.trailer_id ?? item.trailerId ?? null,
    line_type: priced.pricingMode === 'included_in_bundle' ? 'bundle' : 'rental',
    description: charges.description || null,
    quantity: priced.quantity,
    unit: priced.unit,
    unit_price: priced.unitPrice,
    base_amount: priced.baseAmount,
    discount_amount: priced.discountAmount,
    damage_charge: damage,
    cleaning_charge: cleaning,
    late_fee: late,
    other_charge: other,
    line_total: lineTotal,
    calculation_inputs: priced.inputs,
    service_period_start: window.startAt ?? null,
    service_period_end: window.endAt ?? null,
  };
}

/**
 * Build lines for a whole agreement.
 * @param {object} agreement  header (pricing_mode, current_agreed_amount, agreement_discount)
 * @param {Array} entries     [{ item, window, charges }]
 * @returns {{ lines: Array, total: number }}
 */
function buildInvoiceLines(agreement = {}, entries = []) {
  const lines = entries.map((e) => buildItemLine(e.item, e.window || {}, e.charges || {}));

  const pricingMode = agreement.pricing_mode || agreement.pricingMode || 'per_item';
  const bundleModes = new Set(['bundle_flat', 'bundle_daily', 'bundle_weekly', 'bundle_monthly']);
  if (bundleModes.has(pricingMode)) {
    // A bundle agreement bills a single header amount for all included trailers;
    // per-item rental lines are zeroed and one bundle line carries the amount.
    const bundleAmount = round2(agreement.current_agreed_amount ?? agreement.currentAgreedAmount ?? 0);
    const bundleDiscount = round2(agreement.agreement_discount ?? agreement.agreementDiscount ?? 0);
    lines.forEach((l) => {
      if (l.line_type === 'rental') {
        l.base_amount = 0;
        l.unit_price = 0;
        l.line_total = round2(l.damage_charge + l.cleaning_charge + l.late_fee + l.other_charge - l.discount_amount);
      }
    });
    lines.unshift({
      agreement_item_id: null,
      trailer_id: null,
      line_type: 'bundle',
      description: 'Bundle rental',
      quantity: 1,
      unit: 'bundle',
      unit_price: bundleAmount,
      base_amount: bundleAmount,
      discount_amount: bundleDiscount,
      damage_charge: 0,
      cleaning_charge: 0,
      late_fee: 0,
      other_charge: 0,
      line_total: round2(bundleAmount - bundleDiscount),
      calculation_inputs: { pricingMode },
      service_period_start: agreement.start_date ?? null,
      service_period_end: null,
    });
  }

  const total = round2(lines.reduce((sum, l) => sum + Number(l.line_total || 0), 0));
  return { lines, total };
}

module.exports = { buildItemLine, buildInvoiceLines };
