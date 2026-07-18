/**
 * Plain-language permission labels (§7).
 *
 * A raw key like "trailer_payments.record_overpayment" means nothing to the
 * office manager assigning a role. Every known key maps to a sentence a person
 * can act on; the technical key is shown only as secondary small text for
 * administrators. Unknown/future keys fall back to a humanized form so a raw
 * underscore key is never the primary label.
 */

export const PERMISSION_LABELS = {
  'admin.full_access': 'Full administrator (every permission, entire application)',
  'users.manage': 'Manage administrator accounts',
  'roles.manage': 'Create and edit roles and their permissions',
  'trailers.view': 'See the trailer list and details',
  'trailers.create': 'Add new trailers',
  'trailers.edit': 'Edit trailer details and status',
  'trailers.delete_or_archive': 'Archive trailers',
  'trailers.verify_master': 'Verify trailers against the official master list',
  'trailers.archive': 'Archive a trailer out of the active master list',
  'trailers.merge': 'Merge duplicate trailer records',
  'trailer_imports.manage': 'Upload and review trailer master-list imports',
  'trailer_unmatched_mentions.manage': 'Resolve unknown trailer messages',
  'trailer_rentals.view': 'See rentals',
  'trailer_rentals.create': 'Start new rentals',
  'trailer_rentals.edit': 'Edit rental details',
  'trailer_rentals.close': 'Return trailers and close rentals',
  'trailer_agreements.view': 'See multi-trailer rental agreements',
  'trailer_agreements.manage': 'Create and manage rentals with several trailers',
  'trailer_companies.manage': 'Add and edit renter companies',
  'trailer_inspections.manage': 'Complete inspections and add condition photos',
  'trailer_payments.view': 'See invoices and payments',
  'trailer_payments.record': 'Record payments',
  'trailer_payments.record_without_receipt': 'Record a payment without a receipt (reason required)',
  'trailer_payments.record_overpayment': 'Record extra payments as company credit',
  'trailer_payments.reverse': 'Reverse recorded payments',
  'trailer_receipts.view': 'Open and download payment receipts',
  'trailer_reports.view': 'View and export reports',
  'trailer_settings.manage': 'Change Trailer Department settings and Telegram delivery',
  'trailer_users.manage': 'Manage Trailer Department user accounts',
  'trailer_map.view': 'See the trailer map',
};

/** Humanize an unknown key: "foo_bar.baz_qux" → "Foo bar: baz qux". */
function humanize(key) {
  const [scope, action] = String(key || '').split('.');
  const words = (s) => String(s || '').replace(/_/g, ' ').trim();
  if (!action) return words(scope) || String(key || '');
  const scopeText = words(scope);
  return `${scopeText.charAt(0).toUpperCase()}${scopeText.slice(1)}: ${words(action)}`;
}

/** The primary, plain-language label for a permission key — never the raw key. */
export function permissionLabel(key, fallbackDescription) {
  return PERMISSION_LABELS[key] || fallbackDescription || humanize(key);
}

/**
 * Group permissions for the checklist: [{ group, items: [{ key, label }] }].
 * Grouped by key prefix so related permissions sit together.
 */
export function groupPermissions(permissions) {
  const GROUP_NAMES = {
    admin: 'Administration', users: 'Administration', roles: 'Administration',
    trailers: 'Trailers', trailer_imports: 'Trailers', trailer_unmatched_mentions: 'Trailers',
    trailer_map: 'Trailers',
    trailer_rentals: 'Rentals', trailer_agreements: 'Rentals', trailer_inspections: 'Rentals',
    trailer_companies: 'Companies',
    trailer_payments: 'Money', trailer_receipts: 'Money', trailer_reports: 'Money',
    trailer_settings: 'Settings', trailer_users: 'Settings',
  };
  const groups = new Map();
  for (const p of permissions || []) {
    const key = p.permission_key || p;
    const scope = String(key).split('.')[0];
    const group = GROUP_NAMES[scope] || 'Other';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ key, label: permissionLabel(key, p.description) });
  }
  return Array.from(groups, ([group, items]) => ({ group, items }));
}
