/**
 * Pure per-item rental pricing.
 *
 * Given a rental item and its billable window, compute the base rental amount.
 * Reuses the department's day math (lib/trailers/trailerBilling.js) so the
 * per-item calculation matches legacy single-trailer invoicing exactly rather
 * than reimplementing calendar/24h/manual day counting.
 *
 * No I/O. Amounts are returned as Numbers rounded to cents; callers persist.
 */
'use strict';

const { calculateBillableDays } = require('../../lib/trailers/trailerBilling');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Map an item's pricing_mode to the billing method its day math needs. */
function billingMethodFor(pricingMode) {
  switch (pricingMode) {
    case 'flat':
    case 'included_in_bundle':
      return 'flat_rate';
    case 'manual':
      return 'manual_days';
    case 'weekly':
    case 'monthly':
    case 'daily':
    default:
      return 'calendar_day';
  }
}

/**
 * Compute the base amount for one item over [startAt, endAt].
 *
 * @returns {{ pricingMode, billableDays, elapsedDays, unit, unitPrice, quantity,
 *            baseAmount, additionalAmount, discountAmount, lineTotal, inputs }}
 */
function priceItem(item = {}, { startAt, endAt, timezone } = {}) {
  const mode = item.pricing_mode || item.pricingMode || 'daily';
  const additional = round2(item.additional_amount ?? item.additionalAmount ?? 0);
  const discount = round2(item.discount_amount ?? item.discountAmount ?? 0);

  // Bundle items contribute nothing on their own line — the bundle header bills.
  if (mode === 'included_in_bundle' || item.included_in_bundle === true) {
    const total = round2(additional - discount);
    return {
      pricingMode: 'included_in_bundle',
      billableDays: 0, elapsedDays: 0, unit: 'bundle', unitPrice: 0, quantity: 0,
      baseAmount: 0, additionalAmount: additional, discountAmount: discount,
      lineTotal: total, inputs: { includedInBundle: true },
    };
  }

  if (mode === 'flat') {
    const flat = round2(item.flat_amount ?? item.flatAmount ?? 0);
    return {
      pricingMode: 'flat', billableDays: 0, elapsedDays: 0, unit: 'flat',
      unitPrice: flat, quantity: 1, baseAmount: flat, additionalAmount: additional,
      discountAmount: discount, lineTotal: round2(flat + additional - discount),
      inputs: { flatAmount: flat },
    };
  }

  const timing = calculateBillableDays({
    startAt, endAt,
    billingMethod: billingMethodFor(mode),
    timezone,
    manualDays: item.manual_billable_days ?? item.manualBillableDays,
    manualReason: item.manual_days_reason ?? item.manualDaysReason ?? 'manual',
  });
  const days = timing.billableDays;

  let unit;
  let unitPrice;
  let quantity;
  if (mode === 'weekly') {
    unit = 'week';
    unitPrice = round2(item.weekly_rate ?? item.weeklyRate ?? 0);
    quantity = Math.ceil(days / 7);
  } else if (mode === 'monthly') {
    unit = 'month';
    unitPrice = round2(item.monthly_rate ?? item.monthlyRate ?? 0);
    quantity = Math.ceil(days / 30);
  } else {
    unit = 'day';
    unitPrice = round2(item.daily_rate ?? item.dailyRate ?? 0);
    quantity = days;
  }

  const base = round2(unitPrice * quantity);
  return {
    pricingMode: mode,
    billableDays: days,
    elapsedDays: timing.elapsedDays,
    unit,
    unitPrice,
    quantity,
    baseAmount: base,
    additionalAmount: additional,
    discountAmount: discount,
    lineTotal: round2(base + additional - discount),
    inputs: { billableDays: days, unit, unitPrice, quantity, timezone: timezone || null },
  };
}

module.exports = { priceItem, billingMethodFor, round2 };
