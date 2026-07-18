/**
 * The one status vocabulary for the Trailer Department UI.
 *
 * Technical statuses (database values) map to a user-facing label and a tone
 * (neutral / attention / success). Every page renders statuses through this
 * map, so wording is never invented twice. Dependency-free ESM, tested by
 * node:test like trailerNavigation.js.
 */

export const RENTAL_STATUS_LABELS = {
  draft: { label: "Being set up", tone: "neutral" },
  scheduled: { label: "Pickup planned", tone: "neutral" },
  ready_for_pickup: { label: "Pickup planned", tone: "neutral" },
  active: { label: "Currently rented", tone: "success" },
  partially_active: { label: "Partly picked up", tone: "neutral" },
  returned: { label: "Returned", tone: "success" },
  partially_returned: { label: "Partly returned", tone: "neutral" },
  closed: { label: "Completed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  disputed: { label: "Needs review", tone: "attention" },
  removed_before_pickup: { label: "Removed", tone: "neutral" },
  replaced: { label: "Replaced", tone: "neutral" },
};

export const INVOICE_STATUS_LABELS = {
  draft: { label: "Being prepared", tone: "neutral" },
  issued: { label: "Waiting for payment", tone: "neutral" },
  partially_paid: { label: "Partly paid", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  overdue: { label: "Overdue", tone: "attention" },
  voided: { label: "Cancelled", tone: "neutral" },
  disputed: { label: "Needs review", tone: "attention" },
};

export const TRAILER_CONDITION_LABELS = {
  unknown: { label: "Unknown", tone: "neutral" },
  available: { label: "Available", tone: "success" },
  rented: { label: "Currently rented", tone: "neutral" },
  under_inspection: { label: "Needs inspection", tone: "attention" },
  maintenance: { label: "In maintenance", tone: "attention" },
  out_of_service: { label: "Out of service", tone: "attention" },
  held_damage: { label: "Held because of damage", tone: "attention" },
};

const FALLBACK = { label: "Unknown", tone: "neutral" };

export function rentalStatus(status) {
  return RENTAL_STATUS_LABELS[status] || { label: String(status || "Unknown"), tone: "neutral" };
}

export function invoiceStatus(status) {
  return INVOICE_STATUS_LABELS[status] || { label: String(status || "Unknown"), tone: "neutral" };
}

export function trailerCondition(status) {
  return TRAILER_CONDITION_LABELS[status] || FALLBACK;
}
