/** Shared constants for the Agreements section. */

export const AGREEMENT_STATUSES = [
  "draft",
  "scheduled",
  "active",
  "partially_returned",
  "completed",
  "closed",
  "cancelled",
];

export const PRICING_MODES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "flat", label: "Flat amount" },
  { value: "included_in_bundle", label: "Included in bundle" },
];

export const AGREEMENT_PRICING_MODES = [
  { value: "per_item", label: "Per item" },
  { value: "bundle", label: "Bundle" },
];

export const RETURN_STATUSES = [
  { value: "available", label: "Available" },
  { value: "held_damage", label: "Held — damage" },
  { value: "maintenance", label: "Maintenance" },
  { value: "out_of_service", label: "Out of service" },
];

export const EMPTY_TERMS = {
  company_id: "",
  pricing_mode: "per_item",
  agreement_date: "",
  deposit_amount: "0",
  agreement_discount: "0",
  payment_terms: "",
  payment_grace_period_days: "0",
  billing_timezone: "America/Chicago",
  notes: "",
};

export function emptyItem() {
  return {
    trailer_id: "",
    scheduled_pickup_at: "",
    expected_return_at: "",
    pickup_location: "",
    pricing_mode: "daily",
    daily_rate: "",
    weekly_rate: "",
    monthly_rate: "",
    flat_amount: "",
    additional_amount: "0",
    discount_amount: "0",
    notes: "",
  };
}

export function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

export function readableStatus(value) {
  return String(value || "unknown").replaceAll("_", " ");
}
