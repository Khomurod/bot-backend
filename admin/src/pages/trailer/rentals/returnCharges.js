/**
 * Pure helpers for the guided trailer return: charge aggregation and the
 * confirm-gating requirements. Kept free of React so the rules are unit-tested
 * in isolation (tests/trailerReturnCharges.test.js) and shared by GuidedReturn.
 */

export const CHARGE_TYPES = [
  ["damage_charge", "Damage"],
  ["cleaning_charge", "Cleaning"],
  ["late_fee", "Late fee"],
  ["other_charge", "Other"],
];

export const CHARGE_LABEL = Object.fromEntries(CHARGE_TYPES);

// The server requires at least one stored return photo before it accepts a
// return, so the UI must not let the employee reach a submit it will reject.
export const MIN_RETURN_PHOTOS = 1;

/**
 * Sum extra charge amounts BY TYPE. Two "Cleaning" rows of $100 and $50 must
 * bill $150 — an object keyed by type would silently keep only the last, which
 * was the reported data-loss bug.
 */
export function sumChargesByType(rows) {
  const totals = {};
  for (const row of rows || []) {
    const amount = Number(row.amount || 0);
    if (!amount) continue;
    totals[row.type] = Number(((totals[row.type] || 0) + amount).toFixed(2));
  }
  return totals;
}

/** The first charge type not already used by a row, or null when all are used. */
export function nextUnusedChargeType(rows) {
  const used = new Set((rows || []).map((r) => r.type));
  return CHARGE_TYPES.find(([value]) => !used.has(value))?.[0] || null;
}

/**
 * Plain-language list of everything still blocking "Confirm return". Empty ⇒
 * the return may be submitted.
 *
 * @param {object} state
 * @param {number} state.returnPhotoCount stored + selected return photos
 * @param {boolean} state.hasDamage
 * @param {string}  state.damageDescription
 * @param {number}  state.damagePhotoCount freshly added damage photos
 */
export function returnBlockers({
  returnPhotoCount = 0, hasDamage = false, damageDescription = "", damagePhotoCount = 0,
} = {}) {
  const missing = [];
  if (returnPhotoCount < MIN_RETURN_PHOTOS) missing.push("Add at least one return photo");
  if (hasDamage && !String(damageDescription).trim()) missing.push("Describe the new damage");
  if (hasDamage && damagePhotoCount < 1) missing.push("Add at least one photo of the new damage");
  return missing;
}

/**
 * Build the return payload from the wizard state, summing charges by type so no
 * duplicate-type amount is lost. The damage row and the dedicated damage field
 * both roll into the single damage_charge the server bills.
 */
export function buildReturnCharges({ charges = [], damageCharge = 0, chargeNote = "", hasDamage = false, damageDescription = "" } = {}) {
  const byType = sumChargesByType(charges);
  const descriptions = charges
    .filter((c) => c.description && c.description.trim())
    .map((c) => `${CHARGE_LABEL[c.type]}: ${c.description.trim()}`);
  if (String(chargeNote).trim()) descriptions.push(String(chargeNote).trim());
  const description = hasDamage
    ? [damageDescription, ...descriptions].filter(Boolean).join("; ")
    : (descriptions.join("; ") || undefined);
  return {
    damage_charge: Number(((Number(damageCharge || 0)) + (byType.damage_charge || 0)).toFixed(2)),
    cleaning_charge: byType.cleaning_charge || 0,
    late_fee: byType.late_fee || 0,
    other_charge: byType.other_charge || 0,
    description,
  };
}
