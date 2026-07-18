/**
 * Pure map/list filtering for the Trailer Map (§3). One predicate set drives
 * BOTH the markers and the side list so they always agree. React/DOM-free so
 * every dimension is unit-tested.
 */

/** A trailer is "rented" if it is out in either system (has a current renter) or physically rented. */
export function isRented(row) {
  return Boolean(row.current_company_name) || row.physical_status === 'rented';
}

export function hasLocation(row) {
  return row.current_lat != null && row.current_lng != null
    && Number.isFinite(Number(row.current_lat)) && Number.isFinite(Number(row.current_lng));
}

const includesCI = (value, q) => String(value || '').toLowerCase().includes(String(q).toLowerCase());

/**
 * Filter map rows by the active filter set. Empty/absent filters match all.
 * Recognized keys: q, condition, company, rental_state, missing_location,
 * needs_attention, location_source, invoice_status, outstanding_only,
 * return_before (ISO date).
 */
export function filterMapRows(rows, filters = {}) {
  const f = filters || {};
  return (rows || []).filter((row) => {
    if (f.q && ![row.unit_number, row.current_company_name, row.physical_status, row.current_location_text]
      .some((v) => includesCI(v, f.q))) return false;
    if (f.condition && row.physical_status !== f.condition) return false;
    if (f.company && !includesCI(row.current_company_name, f.company)) return false;
    if (f.rental_state === 'available' && isRented(row)) return false;
    if (f.rental_state === 'rented' && !isRented(row)) return false;
    if ((f.missing_location === true || f.missing_location === 'true') && hasLocation(row)) return false;
    if ((f.needs_attention === true || f.needs_attention === 'true')
      && !(row.needs_review || row.status_needs_review)) return false;
    if (f.location_source && String(row.location_source || 'unknown') !== f.location_source) return false;
    if (f.invoice_status && row.invoice_status !== f.invoice_status) return false;
    if ((f.outstanding_only === true || f.outstanding_only === 'true')
      && !(Number(row.outstanding_balance) > 0)) return false;
    if (f.return_before && row.expected_return_at
      && new Date(row.expected_return_at) > new Date(f.return_before)) return false;
    return true;
  });
}

/**
 * Plain-language label for a location source, making clear when a position is
 * driver-derived rather than live trailer GPS (§3).
 */
export function locationSourceLabel(source, hasCoords = true) {
  if (!hasCoords) return 'No location';
  switch (source) {
    case 'gps': return 'Trailer GPS';
    case 'manual': return 'Manual location';
    case 'ai':
    case 'geocoded':
    case 'derived_from_driver': return 'Driver-derived — not trailer GPS';
    default: return 'Unknown source';
  }
}
