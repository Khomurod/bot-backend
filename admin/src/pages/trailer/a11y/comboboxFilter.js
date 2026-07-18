/**
 * Pure filtering + default-extraction for the accessible Combobox and the
 * rental wizard (§1). React/DOM-free so the search and company-defaults rules
 * are unit-tested in isolation.
 */

/** Case-insensitive substring filter of options by their display text. */
export function filterByText(options, query, toText) {
  const q = String(query || '').trim().toLowerCase();
  const text = toText || ((o) => (o && o.label) || '');
  if (!q) return options || [];
  return (options || []).filter((o) => String(text(o) || '').toLowerCase().includes(q));
}

/**
 * Combobox options for a trailer picker row: excludes trailers already chosen in
 * OTHER rows (so the same trailer can't be picked twice) while always keeping
 * this row's current selection. Returns [{ value, label, hint }].
 */
export function trailerPickerOptions(trailers, currentValue, excludeIds = []) {
  const taken = new Set((excludeIds || []).map(String));
  return (trailers || [])
    .filter((t) => !taken.has(String(t.id)) || String(t.id) === String(currentValue))
    .map((t) => ({ value: String(t.id), label: t.unit_number, hint: t.type || t.condition || '' }));
}

/**
 * The rental-terms defaults a company carries. Only defined fields are
 * returned, so selecting a company never blanks a field the company hasn't set.
 */
export function companyDefaults(company) {
  if (!company) return {};
  const out = {};
  if (company.contact_name != null) out.contact_name = company.contact_name;
  if (company.payment_terms != null && company.payment_terms !== '') out.payment_terms = company.payment_terms;
  if (company.default_daily_rate != null) out.default_daily_rate = company.default_daily_rate;
  if (company.billing_timezone != null && company.billing_timezone !== '') out.billing_timezone = company.billing_timezone;
  if (company.payment_grace_period_days != null) out.payment_grace_period_days = company.payment_grace_period_days;
  return out;
}
