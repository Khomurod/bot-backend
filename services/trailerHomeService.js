'use strict';

/**
 * Home page data: what needs attention, today's work, summary counts, and
 * recent activity in plain sentences. Read-only aggregate queries.
 */

const { query } = require('../database/pool');

/** Attention rows: {type, count, oldest_at, link}. Empty groups are omitted. */
async function fetchAttention() {
  const res = await query(`
    SELECT 'pickups_due' AS type, COUNT(*)::int AS count, MIN(it.scheduled_pickup_at) AS oldest_at
      FROM trailer_rental_items it
     WHERE it.item_status IN ('scheduled','ready_for_pickup') AND it.scheduled_pickup_at <= NOW() + INTERVAL '1 day'
    UNION ALL
    SELECT 'overdue_returns', COUNT(*)::int, MIN(it.expected_return_at)
      FROM trailer_rental_items it
     WHERE it.item_status='active' AND it.expected_return_at < NOW()
    UNION ALL
    SELECT 'overdue_invoices', COUNT(*)::int, MIN(i.due_at)
      FROM trailer_invoices i
      LEFT JOIN LATERAL (
        SELECT COALESCE((SELECT SUM(amount) FROM trailer_payments
                 WHERE invoice_id=i.id AND verification_status IN ('recorded','verified')),0)
             + COALESCE((SELECT SUM(amount) FROM trailer_company_credit_applications
                 WHERE invoice_id=i.id),0) AS total_paid
      ) p ON TRUE
     WHERE i.status NOT IN ('paid','voided','disputed') AND i.due_at < NOW() AND i.total_amount > p.total_paid
    UNION ALL
    SELECT 'unknown_messages', COUNT(*)::int, MIN(m.detected_at)
      FROM trailer_unmatched_mentions m WHERE m.review_status='pending'
    UNION ALL
    SELECT 'failed_notifications', COUNT(*)::int, MIN(j.updated_at)
      FROM trailer_notification_jobs j WHERE j.status='failed'
    UNION ALL
    SELECT 'trailers_needing_review', COUNT(*)::int, MIN(t.updated_at)
      FROM trailers t WHERE t.needs_review = TRUE AND t.active = TRUE
  `);
  // /trailers is the department's public-facing slug. The admin panel parses
  // these through the shared navigation catalog, which still accepts the old
  // /admin/trailers form — so an old client reading a new link keeps working.
  const LINKS = {
    pickups_due: '/trailers/rentals?tab=upcoming_pickups',
    overdue_returns: '/trailers/rentals?tab=needs_attention',
    overdue_invoices: '/trailers/money?tab=overdue',
    unknown_messages: '/trailers/trailers?tab=updates&view=unknown',
    failed_notifications: '/trailers/money?tab=needs_attention',
    trailers_needing_review: '/trailers/trailers?tab=needs_attention',
  };
  return res.rows
    .filter((r) => r.count > 0)
    .map((r) => ({ type: r.type, count: r.count, oldest_at: r.oldest_at, link: LINKS[r.type] }));
}

async function fetchTodayAndSummary() {
  const res = await query(`
    SELECT
      (SELECT COUNT(*) FROM trailer_rental_items it
        WHERE it.item_status IN ('scheduled','ready_for_pickup')
          AND it.scheduled_pickup_at::date = NOW()::date)::int AS pickups_today,
      (SELECT COUNT(*) FROM trailer_rental_items it
        WHERE it.item_status='active' AND it.expected_return_at::date = NOW()::date)::int AS returns_today,
      (SELECT COUNT(*) FROM trailer_rental_items it
        WHERE it.item_status='active' AND it.expected_return_at < NOW())::int AS overdue_returns,
      (SELECT COUNT(*) FROM trailer_payments p WHERE p.payment_at::date = NOW()::date
        AND p.verification_status IN ('recorded','verified'))::int AS payments_today,
      (SELECT COUNT(*) FROM trailers t WHERE t.active AND t.master_status='active'
        AND t.physical_status='available')::int AS available,
      (SELECT COUNT(*) FROM trailers t WHERE t.active AND t.master_status='active'
        AND t.physical_status='rented')::int AS rented
  `);
  const r = res.rows[0];
  return {
    today: {
      pickups: r.pickups_today, returns: r.returns_today,
      overdue: r.overdue_returns, payments: r.payments_today,
    },
    summary: {
      available: r.available, rented: r.rented,
      pickups_today: r.pickups_today, overdue_returns: r.overdue_returns,
    },
  };
}

/** Recent audit rows rendered as plain sentences. */
const ACTIVITY_TEMPLATES = {
  'rental.create': 'started a rental',
  'agreement.item.activate': 'confirmed a trailer pickup',
  'agreement.item.return': 'returned a trailer',
  'rental.activate': 'confirmed a trailer pickup',
  'rental.return': 'returned a trailer',
  'payment.create': 'recorded a payment',
  'payment.reverse': 'reversed a payment',
  'payment.overpayment_credit': 'saved an extra payment as company credit',
  'credit.apply': 'applied company credit to an invoice',
  'invoice.finalize': 'created an invoice',
  'agreement.invoice.combined': 'created one invoice for all trailers',
  'agreement.invoice.separate': 'created a separate trailer invoice',
  'agreement.close': 'completed a rental',
  'inspection.complete': 'completed an inspection',
  'trailer.create': 'added a trailer',
  'trailer.update': 'updated a trailer',
  'company.create': 'added a company',
  'company.update': 'updated a company',
};

async function fetchActivity(limit = 12) {
  const res = await query(
    `SELECT au.action, au.entity_type, au.entity_id, au.created_at, ad.username
       FROM trailer_audit_log au LEFT JOIN admins ad ON ad.id=au.admin_id
      WHERE au.action = ANY($1)
      ORDER BY au.created_at DESC LIMIT $2`,
    [Object.keys(ACTIVITY_TEMPLATES), limit],
  );
  return res.rows.map((r) => ({
    at: r.created_at,
    text: `${r.username || 'Someone'} ${ACTIVITY_TEMPLATES[r.action] || r.action}`,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
  }));
}

async function getTrailerHome() {
  const [attention, todaySummary, activity] = await Promise.all([
    fetchAttention(), fetchTodayAndSummary(), fetchActivity(),
  ]);
  return { attention, ...todaySummary, activity };
}

module.exports = { getTrailerHome };
