'use strict';

/**
 * Trailer map data — the read model behind the Trailer Map (§3).
 *
 * Extracted from database/trailers.js so that file stays within the size budget
 * and this map-specific query (with its renter/invoice joins that power the map
 * filters) lives in one focused place. Official trailers only.
 */

const { query } = require('./pool');

const OFFICIAL_TRAILER_PREDICATE = "t.active = TRUE AND t.master_status = 'active'";

/**
 * Every official trailer with its current status, renter, expected return and
 * latest invoice/outstanding — enough for the map markers, the side list, and
 * all the map filters. Bounded to 2000 (a map cannot usefully show more).
 */
async function listTrailerMapData() {
  const res = await query(
    `SELECT t.id AS trailer_id, t.unit_number, t.type, t.ownership_status, t.needs_review, t.physical_status, t.tracking_reference,
            COALESCE(cs.current_status, 'unknown') AS current_status,
            COALESCE(cs.possession_status, 'unknown') AS possession_status,
            COALESCE(cs.cargo_status, 'unknown') AS cargo_status,
            cs.display_status,
            cs.current_driver_name, cs.current_driver_group_id, cs.current_driver_profile_id,
            cs.current_location_text, cs.current_lat, cs.current_lng,
            cs.current_condition, cs.last_reporter_name,
            cs.last_event_type, cs.last_event_at,
            COALESCE(cs.needs_review, FALSE) AS status_needs_review,
            cs.location_source, cs.location_confidence,
            COALESCE(c.display_name, ic.display_name) AS current_company_name,
            COALESCE(r.expected_return_at, it.expected_return_at) AS expected_return_at,
            i.status AS invoice_status,
            GREATEST(COALESCE(i.total_amount,0)-COALESCE(p.total_paid,0),0) AS outstanding_balance
     FROM trailers t
     LEFT JOIN trailer_current_status cs ON cs.trailer_id = t.id
     LEFT JOIN trailer_rentals r ON r.trailer_id = t.id AND r.status = 'active'
     LEFT JOIN trailer_renter_companies c ON c.id = r.company_id
     LEFT JOIN LATERAL (SELECT * FROM trailer_rental_items x WHERE x.trailer_id = t.id AND x.item_status = 'active' LIMIT 1) it ON TRUE
     LEFT JOIN trailer_rental_agreements ia ON ia.id = it.agreement_id
     LEFT JOIN trailer_renter_companies ic ON ic.id = ia.company_id
     LEFT JOIN LATERAL (SELECT * FROM trailer_invoices x WHERE x.rental_id = r.id ORDER BY created_at DESC LIMIT 1) i ON TRUE
     LEFT JOIN LATERAL (SELECT SUM(amount) total_paid FROM trailer_payments WHERE invoice_id = i.id AND verification_status IN ('recorded','verified')) p ON TRUE
     WHERE ${OFFICIAL_TRAILER_PREDICATE}
     ORDER BY cs.last_event_at DESC NULLS LAST, t.unit_number ASC
     LIMIT 2000`,
  );
  return res.rows;
}

module.exports = { listTrailerMapData };
