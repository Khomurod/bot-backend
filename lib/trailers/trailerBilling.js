'use strict';

const { DateTime } = require('luxon');

function money(value, name = 'amount') {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error(`${name} must be a non-negative number.`), { status: 400 });
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function elapsedDays(startAt, endAt) {
  const milliseconds = new Date(endAt).getTime() - new Date(startAt).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw Object.assign(new Error('Return time must be after rental start time.'), { status: 400 });
  }
  return milliseconds / 86_400_000;
}

function calculateBillableDays({ startAt, endAt, billingMethod, timezone = 'America/Chicago', manualDays, manualReason }) {
  const elapsed = elapsedDays(startAt, endAt);
  if (billingMethod === 'calendar_day') {
    const start = DateTime.fromISO(new Date(startAt).toISOString(), { zone: 'utc' }).setZone(timezone).startOf('day');
    const end = DateTime.fromISO(new Date(endAt).toISOString(), { zone: 'utc' }).setZone(timezone).startOf('day');
    return { billableDays: Math.max(1, Math.round(end.diff(start, 'days').days) + 1), elapsedDays: elapsed };
  }
  if (billingMethod === 'twenty_four_hour') {
    return { billableDays: Math.max(1, Math.ceil(elapsed)), elapsedDays: elapsed };
  }
  if (billingMethod === 'manual_days') {
    const count = Number(manualDays);
    if (!Number.isInteger(count) || count < 1 || !String(manualReason || '').trim()) {
      throw Object.assign(new Error('Manual billable days require a positive whole-day count and a reason.'), { status: 400 });
    }
    return { billableDays: count, elapsedDays: elapsed };
  }
  if (billingMethod === 'flat_rate') {
    return { billableDays: Math.max(1, Math.ceil(elapsed)), elapsedDays: elapsed };
  }
  throw Object.assign(new Error('Unsupported billing method.'), { status: 400 });
}

function calculateInvoice(input) {
  if ((input.currency || 'USD') !== 'USD') throw Object.assign(new Error('Only USD is supported.'), { status: 400 });
  const timing = calculateBillableDays(input);
  const baseAmount = input.billingMethod === 'flat_rate'
    ? money(input.flatRate, 'flat rate')
    : money(timing.billableDays * money(input.dailyRate, 'daily rate'));
  const depositCredit = money(input.depositCredit, 'deposit credit');
  const discountAmount = money(input.discountAmount, 'discount');
  const damageCharge = money(input.damageCharge, 'damage charge');
  const cleaningCharge = money(input.cleaningCharge, 'cleaning charge');
  const lateFee = money(input.lateFee, 'late fee');
  const otherCharges = money(input.otherCharges, 'other charges');
  const totalAmount = Math.max(0, money(
    baseAmount - depositCredit - discountAmount + damageCharge + cleaningCharge + lateFee + otherCharges,
  ));
  return { ...timing, baseAmount, depositCredit, discountAmount, damageCharge, cleaningCharge, lateFee, otherCharges, totalAmount };
}

module.exports = { calculateBillableDays, calculateInvoice, elapsedDays, money };
