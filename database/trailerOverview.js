'use strict';

/**
 * One trailer's full story for the detail page: the trailer row, its rental
 * history from BOTH systems (legacy rentals and agreement items), movements,
 * document/photo metadata (never bytes), invoices and audit trail. Read-only.
 */

const { query } = require('./pool');
const { listTrailerAudit } = require('./trailerAudit');

async function getTrailerOverview(trailerId) {
  const id = Number(trailerId);
  const trailerRes = await query(
    `SELECT t.*, s.possession_status, s.cargo_status, s.display_status,
            s.current_location_text, s.current_lat, s.current_lng, s.location_source,
            s.last_event_at
       FROM trailers t LEFT JOIN trailer_current_status s ON s.trailer_id = t.id
      WHERE t.id = $1`,
    [id],
  );
  const trailer = trailerRes.rows[0];
  if (!trailer) return null;

  const [rentals, movements, media, invoices, aliases, audit] = await Promise.all([
    // Rental history from both systems, one unified shape. Backfilled legacy
    // rentals also exist as items; prefer the item row and skip its mirror.
    query(
      `SELECT 'agreement' AS kind, a.id AS agreement_id, a.agreement_number AS display_number,
              c.display_name AS company_name, it.item_status AS status,
              COALESCE(it.actual_pickup_at, it.scheduled_pickup_at) AS start_at,
              COALESCE(it.actual_return_at, it.expected_return_at) AS end_at
         FROM trailer_rental_items it
         JOIN trailer_rental_agreements a ON a.id = it.agreement_id
         JOIN trailer_renter_companies c ON c.id = a.company_id
        WHERE it.trailer_id = $1
        UNION ALL
       SELECT 'legacy', NULL, r.agreement_number, c.display_name, r.status,
              r.start_at, COALESCE(r.actual_return_at, r.expected_return_at)
         FROM trailer_rentals r
         JOIN trailer_renter_companies c ON c.id = r.company_id
        WHERE r.trailer_id = $1
          AND NOT EXISTS (SELECT 1 FROM trailer_rental_items x WHERE x.legacy_rental_id = r.id)
        ORDER BY start_at DESC NULLS LAST
        LIMIT 100`,
      [id],
    ),
    query(
      `SELECT id, movement_type, to_location, event_at, source
         FROM trailer_rental_movements WHERE trailer_id = $1
        ORDER BY event_at DESC NULLS LAST LIMIT 100`,
      [id],
    ),
    query(
      `SELECT id, media_type, original_filename, mime_type, original_size_bytes,
              storage_backend, created_at, rental_id, rental_item_id, inspection_id
         FROM trailer_media WHERE trailer_id = $1
        ORDER BY created_at DESC LIMIT 200`,
      [id],
    ),
    query(
      `SELECT i.id, i.invoice_number, i.status, i.total_amount, i.due_at, i.created_at,
              COALESCE((SELECT SUM(amount) FROM trailer_payments
                 WHERE invoice_id=i.id AND verification_status IN ('recorded','verified')),0)
            + COALESCE((SELECT SUM(amount) FROM trailer_company_credit_applications
                 WHERE invoice_id=i.id),0) AS total_paid
         FROM trailer_invoices i WHERE i.trailer_id = $1
        ORDER BY i.created_at DESC LIMIT 100`,
      [id],
    ),
    query(
      `SELECT id, alias_unit_number, active, created_at
         FROM trailer_aliases WHERE trailer_id = $1 ORDER BY created_at DESC`,
      [id],
    ),
    listTrailerAudit({ entityType: 'trailer', entityId: id, limit: 100 }),
  ]);

  return {
    trailer,
    rentals: rentals.rows,
    movements: movements.rows,
    media: media.rows,
    invoices: invoices.rows.map((i) => ({
      ...i,
      outstanding_balance: Math.max(Number(i.total_amount) - Number(i.total_paid), 0),
    })),
    aliases: aliases.rows,
    audit,
  };
}

module.exports = { getTrailerOverview };
