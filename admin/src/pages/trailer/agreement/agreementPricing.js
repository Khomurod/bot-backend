/**
 * Pure client-side pricing estimate for the agreement builder's summary step.
 *
 * This is an ESTIMATE for reviewer confidence only — the backend recomputes the
 * authoritative amounts from the billable window at invoice time. Kept pure so
 * it is trivial to reason about and reuse.
 */

const DAY_MS = 86_400_000;

/** Whole billing units between two datetimes, minimum 1 when both are set. */
export function spanDays(startAt, endAt) {
  if (!startAt || !endAt) return 0;
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.max(1, Math.ceil((end - start) / DAY_MS));
}

/** Base amount for one item from its pricing mode and rates. */
export function itemBase(item) {
  const days = spanDays(item.scheduled_pickup_at, item.expected_return_at);
  switch (item.pricing_mode) {
    case "daily":
      return Number(item.daily_rate || 0) * (days || 1);
    case "weekly":
      return Number(item.weekly_rate || 0) * Math.max(1, Math.ceil(days / 7));
    case "monthly":
      return Number(item.monthly_rate || 0) * Math.max(1, Math.ceil(days / 30));
    case "flat":
      return Number(item.flat_amount || 0);
    case "included_in_bundle":
      return 0;
    default:
      return 0;
  }
}

/** Net line total for one item: base + additional − discount. */
export function itemTotal(item) {
  return (
    itemBase(item) +
    Number(item.additional_amount || 0) -
    Number(item.discount_amount || 0)
  );
}

/** Whole-agreement summary from the terms and item rows. */
export function summarize(terms, items) {
  const lines = items.map((item) => ({
    item,
    base: itemBase(item),
    total: itemTotal(item),
    days: spanDays(item.scheduled_pickup_at, item.expected_return_at),
  }));
  const itemsTotal = lines.reduce((sum, line) => sum + line.total, 0);
  const agreementDiscount = Number(terms.agreement_discount || 0);
  const deposit = Number(terms.deposit_amount || 0);
  const netDue = itemsTotal - agreementDiscount;
  return { lines, itemsTotal, agreementDiscount, deposit, netDue };
}
