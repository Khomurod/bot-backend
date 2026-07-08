/**
 * Pure helpers for the Route Control searchable driver-group dropdown.
 *
 * Dependency-free ESM (no React) so the option-building and live-filter logic
 * can be unit-tested under node:test (via dynamic import) and imported by
 * RouteControlPage.jsx for the actual combobox. No frontend test runner is
 * configured in this repo, so this is how the dropdown search is covered.
 */

/** Human driver-type label. */
export function driverTypeLabel(t) {
  if (t === 'company_driver') return 'Company Driver';
  if (t === 'owner') return 'Owner Operator';
  return null;
}

/**
 * Build { groupId, label, groupName, search } options from driver-profile rows
 * (which carry unit_number / first_name / last_name / driver_type + group_id +
 * group_name). `label` is the clean display string; `search` is the lowercased
 * haystack matched while typing.
 */
export function buildGroupOptions(profiles) {
  return (profiles || [])
    .filter((p) => p && p.group_id != null)
    .map((p) => {
      const name = (p.full_name && String(p.full_name).trim())
        || [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
      const typeLabel = driverTypeLabel(p.driver_type);
      const parts = [];
      if (p.unit_number) parts.push(`Unit #${p.unit_number}`);
      if (name) parts.push(name);
      if (typeLabel) parts.push(typeLabel);
      const label = parts.length ? parts.join(' — ') : (p.group_name || `Group ${p.group_id}`);
      const search = [p.unit_number, name, p.group_name, typeLabel]
        .filter(Boolean).join(' ').toLowerCase();
      return { groupId: Number(p.group_id), label, groupName: p.group_name || label, search };
    });
}

/**
 * Live-filter options by a query. Every whitespace-separated token must appear
 * somewhere in the option's search haystack (AND semantics), so "800 dil"
 * narrows to unit 800 AND a name containing "dil".
 */
export function filterGroupOptions(options, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return options || [];
  const tokens = q.split(/\s+/).filter(Boolean);
  return (options || []).filter((o) => tokens.every((t) => o.search.includes(t)));
}
