/**
 * Home quick actions and their permissions — pure, so visibility is unit-tested
 * for every common role (blocker §13). Each action gates on its OWN permission;
 * there is deliberately no broad fallback that would make every action visible
 * to anyone holding a single manage permission. A full administrator
 * (admin.full_access) still sees everything.
 */

export const QUICK_ACTIONS = [
  { label: "Start a rental", perm: "trailer_agreements.manage", section: "rentals", query: "action=start" },
  { label: "Confirm a pickup", perm: "trailer_inspections.manage", section: "rentals", query: "tab=upcoming_pickups" },
  { label: "Return a trailer", perm: "trailer_rentals.close", section: "rentals", query: "tab=currently_rented" },
  { label: "Record a payment", perm: "trailer_payments.record", section: "money", query: "action=record-payment" },
];

/**
 * The quick actions a user may see, each gated ONLY on its specific permission
 * (or full access). No cross-action fallback.
 */
export function visibleQuickActions(permissions) {
  const held = new Set(permissions || []);
  const full = held.has("admin.full_access");
  return QUICK_ACTIONS.filter((a) => full || held.has(a.perm));
}
