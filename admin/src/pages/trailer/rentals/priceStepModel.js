/**
 * Pure model for the wizard's Price step (§1): the three plain-language
 * charging choices, their validation, and the mapping onto the agreement/item
 * payload the backend expects. React-free so every rule is unit-tested.
 *
 * The three user-facing options:
 *   total       → "One total price for all trailers"   (bundle_flat agreement)
 *   per_trailer → "Each trailer has its own rate"      (per_item agreement)
 *   manual      → "Enter a final amount manually"      (bundle_flat + reason)
 */

export const PRICING_CHOICES = [
  { value: "total", label: "One total price for all trailers" },
  { value: "per_trailer", label: "Each trailer has its own rate" },
  { value: "manual", label: "Enter a final amount manually" },
];

export const RATE_MODES = [
  { value: "daily", label: "Daily", field: "daily_rate" },
  { value: "weekly", label: "Weekly", field: "weekly_rate" },
  { value: "monthly", label: "Monthly", field: "monthly_rate" },
  { value: "flat", label: "Flat amount", field: "flat_amount" },
];

export function rateField(mode) {
  return (RATE_MODES.find((m) => m.value === mode) || RATE_MODES[0]).field;
}

/** Plain-language list of what still blocks the Price step. Empty ⇒ valid. */
export function priceBlockers(choice, { totalAmount, manualAmount, manualReason, items = [] } = {}) {
  const missing = [];
  if (choice === "total") {
    if (!(Number(totalAmount) > 0)) missing.push("Enter the total rental price");
  } else if (choice === "manual") {
    if (!(Number(manualAmount) > 0)) missing.push("Enter the final agreed amount");
    if (!String(manualReason || "").trim()) missing.push("Explain why the amount is entered manually");
  } else {
    items.forEach((it, i) => {
      const field = rateField(it.pricing_mode);
      if (!(Number(it[field]) > 0)) missing.push(`Enter a rate for trailer ${i + 1}`);
    });
  }
  return missing;
}

/**
 * Copy the first trailer's pricing mode + rate to every trailer
 * ("Use the same rate for all trailers").
 */
export function applySameRate(items) {
  if (!items.length) return items;
  const src = items[0];
  const field = rateField(src.pricing_mode);
  return items.map((it) => ({
    ...it,
    pricing_mode: src.pricing_mode,
    daily_rate: "", weekly_rate: "", monthly_rate: "", flat_amount: "",
    [field]: src[field],
  }));
}

/**
 * The agreement-level payload fields for the chosen pricing, plus a transform
 * for each item's pricing fields. Manual pricing REQUIRES the reason — it is
 * appended to the agreement notes so the audit trail explains the number.
 */
export function buildPricingPayload(choice, { totalAmount, manualAmount, manualReason, deposit, discount, notes } = {}) {
  const base = {
    deposit_amount: Number(deposit || 0),
    agreement_discount: Number(discount || 0),
    notes: notes || null,
  };
  if (choice === "total") {
    return {
      agreement: {
        ...base,
        pricing_mode: "bundle_flat",
        original_agreed_amount: Number(totalAmount || 0),
        current_agreed_amount: Number(totalAmount || 0),
      },
      // Every trailer is covered by the bundle amount.
      itemPatch: () => ({ pricing_mode: "included_in_bundle", included_in_bundle: true }),
    };
  }
  if (choice === "manual") {
    const reason = String(manualReason || "").trim();
    return {
      agreement: {
        ...base,
        pricing_mode: "bundle_flat",
        original_agreed_amount: Number(manualAmount || 0),
        current_agreed_amount: Number(manualAmount || 0),
        notes: [notes, `Manual amount: ${reason}`].filter(Boolean).join("\n"),
      },
      itemPatch: () => ({ pricing_mode: "included_in_bundle", included_in_bundle: true }),
    };
  }
  // per_trailer: the agreement bills per item; item pricing stays as entered.
  return {
    agreement: { ...base, pricing_mode: "per_item" },
    itemPatch: (item) => ({ pricing_mode: item.pricing_mode || "daily" }),
  };
}
