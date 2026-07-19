/** Shared company form fields — used by both the list page (create) and the
 *  detail page (edit) so the two dialogs can never drift apart. */

export const EMPTY = {
  legal_name: "", display_name: "", contact_name: "", phone: "", email: "",
  payment_terms: "", default_daily_rate: "", notes: "",
};

export const FIELD_LABELS = {
  legal_name: "Legal name", display_name: "Company name", contact_name: "Contact person",
  phone: "Phone", email: "Email", payment_terms: "Payment terms",
  default_daily_rate: "Default daily rate", notes: "Notes",
};
