'use strict';

/**
 * Unified rental read model.
 *
 * ONE paginated list over multi-trailer agreements — which, thanks to the boot
 * backfill, also mirror every legacy single-trailer rental — joined with the
 * company, items + trailers (with inspection/photo evidence) and invoice money.
 * Each row is normalized to the shape the redesigned UI consumes, including the
 * computed next action. Read-only; writes keep flowing through the services.
 */

const { query } = require('../database/pool');
const { agreementNextAction, itemNextAction } = require('./trailerNextAction');
const { pageArgs, paginated } = require('./trailerPagination');

const BUCKETS = ['needs_attention', 'upcoming_pickups', 'currently_rented', 'returns', 'completed', 'all'];

/** SQL predicate for a tab bucket (correlated on agreement alias `a`). */
function bucketPredicate(bucket) {
  switch (bucket) {
    case 'upcoming_pickups':
      return `a.status NOT IN ('closed','cancelled') AND EXISTS (
        SELECT 1 FROM trailer_rental_items it WHERE it.agreement_id=a.id
          AND it.item_status IN ('draft','scheduled','ready_for_pickup'))`;
    case 'currently_rented':
      return `EXISTS (SELECT 1 FROM trailer_rental_items it
        WHERE it.agreement_id=a.id AND it.item_status='active')`;
    case 'returns':
      return `a.status NOT IN ('closed','cancelled') AND EXISTS (
        SELECT 1 FROM trailer_rental_items it WHERE it.agreement_id=a.id
          AND it.item_status IN ('active','returned'))`;
    case 'completed':
      return `a.status IN ('closed','cancelled')`;
    case 'needs_attention':
      return `a.status NOT IN ('closed','cancelled') AND (
        EXISTS (SELECT 1 FROM trailer_rental_items it WHERE it.agreement_id=a.id
          AND it.item_status='active' AND it.expected_return_at < NOW())
        OR EXISTS (SELECT 1 FROM trailer_invoices inv WHERE inv.agreement_id=a.id
          AND inv.status IN ('overdue'))
        OR a.status='draft')`;
    default:
      return null;
  }
}

/** Page of agreements matching the filters, plus the total count. */
async function fetchAgreementPage(filters, pageArgsResolved) {
  const where = [];
  const vals = [];
  const bucket = BUCKETS.includes(filters.bucket) ? filters.bucket : 'all';
  const predicate = bucketPredicate(bucket);
  if (predicate) where.push(predicate);
  if (filters.companyId) { vals.push(Number(filters.companyId)); where.push(`a.company_id=$${vals.length}`); }
  if (filters.status) { vals.push(filters.status); where.push(`a.status=$${vals.length}`); }
  if (filters.q) {
    vals.push(`%${String(filters.q).trim()}%`);
    const n = vals.length;
    where.push(`(a.agreement_number ILIKE $${n} OR c.display_name ILIKE $${n} OR c.contact_name ILIKE $${n}
      OR EXISTS (SELECT 1 FROM trailer_rental_items it JOIN trailers t ON t.id=it.trailer_id
           WHERE it.agreement_id=a.id AND t.unit_number ILIKE $${n})
      OR EXISTS (SELECT 1 FROM trailer_invoices inv WHERE inv.agreement_id=a.id AND inv.invoice_number ILIKE $${n}))`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM trailer_rental_agreements a JOIN trailer_renter_companies c ON c.id=a.company_id`;
  const totalRes = await query(`SELECT COUNT(*)::int AS total ${from} ${clause}`, vals);
  const rows = await query(
    `SELECT a.*, c.display_name AS company_name, c.contact_name AS company_contact
       ${from} ${clause}
      ORDER BY a.created_at DESC
      LIMIT ${pageArgsResolved.limit} OFFSET ${pageArgsResolved.offset}`,
    vals,
  );
  return { rows: rows.rows, total: totalRes.rows[0].total };
}

/** Items + evidence for a set of agreements, keyed by agreement id. */
async function fetchItems(agreementIds) {
  if (!agreementIds.length) return new Map();
  const res = await query(
    `SELECT it.*, t.unit_number,
        EXISTS (SELECT 1 FROM trailer_inspections ins WHERE ins.rental_item_id=it.id
          AND ins.inspection_type='pickup' AND ins.completed) AS pickup_inspection_complete,
        EXISTS (SELECT 1 FROM trailer_inspections ins WHERE ins.rental_item_id=it.id
          AND ins.inspection_type='return') AS return_inspection_started,
        EXISTS (SELECT 1 FROM trailer_inspections ins WHERE ins.rental_item_id=it.id
          AND ins.inspection_type='return' AND ins.completed) AS return_inspection_complete,
        (SELECT COUNT(*) FROM trailer_media m WHERE m.rental_item_id=it.id
          AND m.media_type='pickup_condition_photo')::int AS pickup_photo_count,
        (SELECT COUNT(*) FROM trailer_media m WHERE m.rental_item_id=it.id
          AND m.media_type='return_condition_photo')::int AS return_photo_count,
        EXISTS (SELECT 1 FROM trailer_invoices inv WHERE inv.rental_item_id=it.id) AS item_invoiced
       FROM trailer_rental_items it
       JOIN trailers t ON t.id=it.trailer_id
      WHERE it.agreement_id = ANY($1)
      ORDER BY it.item_sequence, it.id`,
    [agreementIds],
  );
  const byAgreement = new Map();
  for (const row of res.rows) {
    const list = byAgreement.get(Number(row.agreement_id)) || [];
    list.push(row);
    byAgreement.set(Number(row.agreement_id), list);
  }
  return byAgreement;
}

/** Invoice money per agreement: total invoiced, paid (payments + credits). */
async function fetchMoney(agreementIds) {
  if (!agreementIds.length) return new Map();
  const res = await query(
    `SELECT i.agreement_id,
        SUM(i.total_amount) AS total_amount,
        SUM(p.total_paid) AS paid_amount,
        BOOL_OR(i.rental_item_id IS NULL) AS has_combined,
        MAX(i.created_at) AS last_invoice_at
       FROM trailer_invoices i
       LEFT JOIN LATERAL (
         SELECT COALESCE((SELECT SUM(amount) FROM trailer_payments
                  WHERE invoice_id=i.id AND verification_status IN ('recorded','verified')),0)
              + COALESCE((SELECT SUM(amount) FROM trailer_company_credit_applications
                  WHERE invoice_id=i.id),0) AS total_paid
       ) p ON TRUE
      WHERE i.agreement_id = ANY($1) AND i.status <> 'voided'
      GROUP BY i.agreement_id`,
    [agreementIds],
  );
  return new Map(res.rows.map((r) => [Number(r.agreement_id), r]));
}

function normalizeItem(row, now) {
  const evidence = {
    pickupInspectionComplete: row.pickup_inspection_complete,
    pickupPhotoCount: row.pickup_photo_count,
    returnInspectionStarted: row.return_inspection_started,
    returnInspectionComplete: row.return_inspection_complete,
    returnPhotoCount: row.return_photo_count,
  };
  return {
    entry: { item: row, evidence },
    shaped: {
      item_id: row.id,
      trailer_id: row.trailer_id,
      unit_number: row.unit_number,
      item_status: row.item_status,
      version: row.version,
      scheduled_pickup_at: row.scheduled_pickup_at,
      expected_return_at: row.expected_return_at,
      actual_pickup_at: row.actual_pickup_at,
      actual_return_at: row.actual_return_at,
      pickup_location: row.pickup_location,
      actual_pickup_location: row.actual_pickup_location,
      actual_pickup_lat: row.actual_pickup_lat,
      actual_pickup_lng: row.actual_pickup_lng,
      pickup_inspection_complete: row.pickup_inspection_complete,
      pickup_photo_count: row.pickup_photo_count,
      return_inspection_complete: row.return_inspection_complete,
      return_photo_count: row.return_photo_count,
      invoiced: row.item_invoiced,
      next_action: itemNextAction(row, evidence, now),
    },
  };
}

function shapeAgreement(agreement, itemRows, money, now) {
  const items = (itemRows || []).map((row) => normalizeItem(row, now));
  const uninvoicedReturn = (itemRows || []).some((row) => {
    if (row.item_status !== 'returned' || row.item_invoiced) return false;
    if (!money?.has_combined) return true;
    return row.actual_return_at && money.last_invoice_at
      && new Date(money.last_invoice_at) < new Date(row.actual_return_at);
  });
  const total = Number(money?.total_amount || 0);
  const paid = Number(money?.paid_amount || 0);
  const active = (itemRows || []).filter((r) => !['removed_before_pickup', 'replaced', 'cancelled'].includes(r.item_status));
  const pickups = active.map((r) => r.actual_pickup_at || r.scheduled_pickup_at).filter(Boolean).map((d) => new Date(d));
  const returns = active.map((r) => r.actual_return_at || r.expected_return_at).filter(Boolean).map((d) => new Date(d));
  return {
    id: `agreement:${agreement.id}`,
    agreement_id: agreement.id,
    display_number: agreement.agreement_number,
    version: agreement.version,
    company: { id: agreement.company_id, name: agreement.company_name, contact: agreement.company_contact },
    status: agreement.status,
    trailer_count: active.length,
    trailers: items.map((i) => i.shaped),
    pickup_at: pickups.length ? new Date(Math.min(...pickups)).toISOString() : null,
    expected_return_at: returns.length ? new Date(Math.max(...returns)).toISOString() : null,
    next_action: agreementNextAction(agreement, items.map((i) => i.entry), {
      hasUninvoicedReturns: uninvoicedReturn,
      outstanding: Math.max(total - paid, 0),
    }, now),
    total_amount: total,
    paid_amount: paid,
    outstanding_amount: Math.max(total - paid, 0),
    created_at: agreement.created_at,
  };
}

/**
 * The unified, paginated rental list.
 * @param {object} q  { bucket, companyId, status, q, page, page_size }
 */
async function listRentals(q = {}) {
  const args = pageArgs(q);
  const { rows, total } = await fetchAgreementPage(q, args);
  const ids = rows.map((r) => Number(r.id));
  const [itemsBy, moneyBy] = await Promise.all([fetchItems(ids), fetchMoney(ids)]);
  const now = new Date();
  const items = rows.map((a) => shapeAgreement(a, itemsBy.get(Number(a.id)), moneyBy.get(Number(a.id)), now));
  return paginated(items, args, total);
}

/** One rental in the same normalized shape (or null). */
async function getRental(agreementId) {
  const res = await query(
    `SELECT a.*, c.display_name AS company_name, c.contact_name AS company_contact
       FROM trailer_rental_agreements a JOIN trailer_renter_companies c ON c.id=a.company_id
      WHERE a.id=$1`,
    [Number(agreementId)],
  );
  if (!res.rows[0]) return null;
  const [itemsBy, moneyBy] = await Promise.all([
    fetchItems([Number(agreementId)]), fetchMoney([Number(agreementId)]),
  ]);
  return shapeAgreement(res.rows[0], itemsBy.get(Number(agreementId)), moneyBy.get(Number(agreementId)), new Date());
}

module.exports = { BUCKETS, listRentals, getRental };
