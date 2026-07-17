/**
 * Legacy-rental → agreement backfill: verification + re-run helper.
 *
 * The ACTUAL backfill runs inside database/schema.sql on every boot (INSERT-only
 * and fill-NULLs-only, guarded by legacy_rental_id / IS NULL, so re-running is a
 * no-op). This module does not duplicate that SQL; it exposes:
 *   - runBackfill(): re-execute the idempotent backfill statements on demand
 *     (used by tests and by an operator verifying a restored copy).
 *   - verifyBackfill(): report any legacy rental missing an agreement/item, and
 *     any duplication, so a human can confirm the migration is complete and
 *     rerun-safe.
 *
 * The SQL below is byte-identical in intent to the schema.sql block; keeping a
 * callable copy lets tests assert idempotency without booting the whole app.
 */
'use strict';

const { pool } = require('../pool');

const BACKFILL_SQL = `
INSERT INTO trailer_rental_agreements (
  agreement_number, company_id, status, pricing_mode, currency, agreement_date,
  start_date, original_agreed_amount, current_agreed_amount, deposit_amount,
  agreement_discount, payment_terms, payment_grace_period_days, notes,
  agreement_media_id, created_by_admin_id, updated_by_admin_id, closed_by_admin_id,
  created_at, updated_at, closed_at, legacy_rental_id
)
SELECT
  r.agreement_number, r.company_id, r.status, 'per_item', r.currency,
  r.created_at::date, r.start_at,
  COALESCE(r.flat_rate, 0), COALESCE(r.flat_rate, 0), r.deposit_amount,
  r.discount_amount, r.payment_terms, r.grace_period_days, r.notes,
  r.agreement_media_id, r.created_by_admin_id, r.updated_by_admin_id, r.closed_by_admin_id,
  r.created_at, r.updated_at, r.closed_at, r.id
FROM trailer_rentals r
WHERE NOT EXISTS (SELECT 1 FROM trailer_rental_agreements a WHERE a.legacy_rental_id = r.id);

INSERT INTO trailer_rental_items (
  agreement_id, trailer_id, item_sequence, item_status,
  scheduled_pickup_at, actual_pickup_at, expected_return_at, actual_return_at,
  pickup_location, pickup_lat, pickup_lng, return_location, return_lat, return_lng,
  pricing_mode, daily_rate, flat_amount, deposit_allocation, discount_amount,
  notes, created_by_admin_id, created_at, updated_at, legacy_rental_id
)
SELECT
  a.id, r.trailer_id, 1,
  CASE WHEN r.status = 'closed' THEN 'returned' ELSE r.status END,
  r.start_at,
  CASE WHEN r.status IN ('active','returned','closed') THEN r.start_at ELSE NULL END,
  r.expected_return_at, r.actual_return_at,
  r.pickup_location, r.pickup_lat, r.pickup_lng,
  r.return_location, r.return_lat, r.return_lng,
  CASE r.billing_method WHEN 'flat_rate' THEN 'flat' WHEN 'manual_days' THEN 'manual' ELSE 'daily' END,
  r.daily_rate, r.flat_rate, r.deposit_amount, r.discount_amount,
  r.notes, r.created_by_admin_id, r.created_at, r.updated_at, r.id
FROM trailer_rentals r
JOIN trailer_rental_agreements a ON a.legacy_rental_id = r.id
WHERE NOT EXISTS (SELECT 1 FROM trailer_rental_items it WHERE it.legacy_rental_id = r.id);

UPDATE trailer_invoices inv SET agreement_id = a.id, rental_item_id = it.id
  FROM trailer_rental_agreements a JOIN trailer_rental_items it ON it.agreement_id = a.id
 WHERE a.legacy_rental_id = inv.rental_id AND inv.agreement_id IS NULL;

UPDATE trailer_inspections ins SET agreement_id = a.id, rental_item_id = it.id
  FROM trailer_rental_agreements a JOIN trailer_rental_items it ON it.agreement_id = a.id
 WHERE a.legacy_rental_id = ins.rental_id AND ins.agreement_id IS NULL;

UPDATE trailer_rental_movements mv SET agreement_id = a.id, rental_item_id = it.id
  FROM trailer_rental_agreements a JOIN trailer_rental_items it ON it.agreement_id = a.id
 WHERE a.legacy_rental_id = mv.rental_id AND mv.rental_id IS NOT NULL AND mv.agreement_id IS NULL;

UPDATE trailer_media m SET agreement_id = a.id, rental_item_id = it.id
  FROM trailer_rental_agreements a JOIN trailer_rental_items it ON it.agreement_id = a.id
 WHERE a.legacy_rental_id = m.rental_id AND m.rental_id IS NOT NULL AND m.agreement_id IS NULL;
`;

async function runBackfill(client = pool) {
  await client.query(BACKFILL_SQL);
}

/** Report completeness and any accidental duplication. */
async function verifyBackfill(client = pool) {
  const missing = await client.query(
    `SELECT r.id FROM trailer_rentals r
      WHERE NOT EXISTS (SELECT 1 FROM trailer_rental_agreements a WHERE a.legacy_rental_id = r.id)
         OR NOT EXISTS (SELECT 1 FROM trailer_rental_items it WHERE it.legacy_rental_id = r.id)`,
  );
  const dupeAgreements = await client.query(
    `SELECT legacy_rental_id, COUNT(*)::int c FROM trailer_rental_agreements
      WHERE legacy_rental_id IS NOT NULL GROUP BY legacy_rental_id HAVING COUNT(*) > 1`,
  );
  const dupeItems = await client.query(
    `SELECT legacy_rental_id, COUNT(*)::int c FROM trailer_rental_items
      WHERE legacy_rental_id IS NOT NULL GROUP BY legacy_rental_id HAVING COUNT(*) > 1`,
  );
  return {
    complete: missing.rows.length === 0,
    missingRentalIds: missing.rows.map((r) => r.id),
    duplicateAgreements: dupeAgreements.rows,
    duplicateItems: dupeItems.rows,
  };
}

module.exports = { BACKFILL_SQL, runBackfill, verifyBackfill };
