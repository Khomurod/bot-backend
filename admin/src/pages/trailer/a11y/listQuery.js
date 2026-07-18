/**
 * Pure helpers for URL-persisted list state: filters + pagination (§2, §10, §17).
 * React/DOM-free so the parse/serialize/paging math is unit-tested and shared by
 * every large list (trailers, invoices, companies…).
 */

/** Total pages for a total count at a given page size (min 1). */
export function totalPages(total, pageSize) {
  const size = Math.max(Number(pageSize) || 25, 1);
  return Math.max(1, Math.ceil((Number(total) || 0) / size));
}

/** Count of active (non-empty) filter values, excluding paging keys. */
export function activeFilterCount(filters, ignore = ['page', 'page_size']) {
  const skip = new Set(ignore);
  return Object.entries(filters || {})
    .filter(([k, v]) => !skip.has(k) && v != null && v !== '' && v !== false)
    .length;
}

/**
 * Parse a URLSearchParams-like string into a plain filter object. Only keys in
 * `allowed` are kept; page/page_size are coerced to numbers.
 */
export function parseListParams(search, allowed = []) {
  const params = new URLSearchParams(search || '');
  const out = {};
  for (const key of allowed) {
    const v = params.get(key);
    if (v == null || v === '') continue;
    out[key] = (key === 'page' || key === 'page_size') ? Number(v) : v;
  }
  return out;
}

/** Serialize a filter object to a query string, dropping empty values. */
export function serializeListParams(filters) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters || {})) {
    if (v == null || v === '' || v === false) continue;
    params.set(k, String(v));
  }
  return params.toString();
}

/** Merge a filter change and reset to page 1 (filters changing must reset paging). */
export function withFilterChange(filters, patch) {
  return { ...filters, ...patch, page: 1 };
}
