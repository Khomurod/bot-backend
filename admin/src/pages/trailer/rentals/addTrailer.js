/**
 * Pure helpers for the "Add a trailer to this rental" workflow.
 *
 * Kept React-free so the selection rules (which trailers may be added) and the
 * add payload shaping are unit-tested in isolation and can never drift from the
 * dialog. This is the ADD flow — distinct from Swap/Replace — so the vocabulary
 * here is deliberately "add", never "replace".
 */

export const PRICING_MODES = [
  ["daily", "Daily rate", "daily_rate"],
  ["weekly", "Weekly rate", "weekly_rate"],
  ["monthly", "Monthly rate", "monthly_rate"],
  ["flat", "Flat amount", "flat_amount"],
];

/** The rate field name a pricing mode writes to. */
export function rateFieldFor(mode) {
  return (PRICING_MODES.find(([value]) => value === mode) || [])[2] || "daily_rate";
}

/**
 * Trailers that may be ADDED to this rental: official + available, excluding any
 * trailer already on the agreement (so the same trailer can't be picked twice)
 * and excluding archived / pending-review / non-available stock.
 *
 * @param {Array} allTrailers  the department trailer list ({id, unit_number, physical_status, master_status, active})
 * @param {Array} existingItems  the rental's current items ({trailer_id})
 */
export function selectableTrailersForAdd(allTrailers, existingItems) {
  const taken = new Set((existingItems || []).map((it) => Number(it.trailer_id)));
  return (allTrailers || []).filter((t) => {
    if (taken.has(Number(t.id))) return false;
    // Only official stock: active soft-delete flag AND master_status active.
    if (t.active === false) return false;
    if (t.master_status && t.master_status !== "active") return false;
    // Physically available only (an active/rented/maintenance trailer is not addable).
    if (t.physical_status && t.physical_status !== "available") return false;
    return true;
  });
}

/** Case-insensitive filter of trailers by unit number / VIN / plate for the search box. */
export function filterTrailersByText(trailers, text) {
  const q = String(text || "").trim().toLowerCase();
  if (!q) return trailers;
  return (trailers || []).filter((t) => [t.unit_number, t.vin, t.plate_number]
    .some((v) => String(v || "").toLowerCase().includes(q)));
}

/** What must be answered before "Add trailer" unlocks, in plain language. */
export function addTrailerBlockers(form) {
  const missing = [];
  if (!form.trailer_id) missing.push("Choose a trailer");
  if (!form.scheduled_pickup_at) missing.push("Set the scheduled pickup date/time");
  if (!form.expected_return_at) missing.push("Set the expected return date/time");
  if (form.scheduled_pickup_at && form.expected_return_at
    && new Date(form.expected_return_at) <= new Date(form.scheduled_pickup_at)) {
    missing.push("Expected return must be after the pickup");
  }
  const rateField = rateFieldFor(form.pricing_mode);
  if (!(Number(form[rateField]) > 0)) missing.push("Enter a rate or amount");
  return missing;
}

/** Shape the add-item payload the backend addItem endpoint expects. */
export function buildAddItemPayload(form) {
  const rateField = rateFieldFor(form.pricing_mode);
  return {
    trailer_id: Number(form.trailer_id),
    item_status: "scheduled",
    scheduled_pickup_at: form.scheduled_pickup_at ? new Date(form.scheduled_pickup_at).toISOString() : null,
    expected_return_at: form.expected_return_at ? new Date(form.expected_return_at).toISOString() : null,
    pickup_location: form.pickup_location || null,
    pricing_mode: form.pricing_mode,
    [rateField]: Number(form[rateField]) || null,
    notes: form.notes || null,
  };
}
