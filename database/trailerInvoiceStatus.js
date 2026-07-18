'use strict';

/**
 * Invoice paid/outstanding math — the ONE place that defines what counts as
 * "paid" on a trailer invoice: recorded/verified payments PLUS applied company
 * credits (trailer_company_credit_applications). Split out of trailerFinance so
 * trailerCredits can refresh an invoice inside its own transaction without a
 * require cycle.
 */

/**
 * SQL fragment (correlated on `i` = trailer_invoices) returning the total paid
 * toward an invoice: payments + credit applications.
 */
const PAID_TOTAL_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COALESCE((SELECT SUM(amount) FROM trailer_payments
             WHERE invoice_id=i.id AND verification_status IN ('recorded','verified')),0)
         + COALESCE((SELECT SUM(amount) FROM trailer_company_credit_applications
             WHERE invoice_id=i.id),0) AS total_paid
  ) p ON TRUE`;

/**
 * Recompute an invoice's status from its payments and applied credits.
 * Runs inside the caller's transaction client.
 */
async function refreshInvoiceStatus(client, invoiceId) {
  const res = await client.query(
    `WITH paid AS (
       SELECT COALESCE((SELECT SUM(amount) FROM trailer_payments
                WHERE invoice_id=$1 AND verification_status IN ('recorded','verified')),0)
            + COALESCE((SELECT SUM(amount) FROM trailer_company_credit_applications
                WHERE invoice_id=$1),0) AS total
     )
     UPDATE trailer_invoices i SET status = CASE
       WHEN i.status IN ('disputed','voided') THEN i.status
       WHEN paid.total >= i.total_amount THEN 'paid'
       WHEN paid.total > 0 THEN 'partially_paid'
       WHEN i.due_at < NOW() THEN 'overdue'
       ELSE 'issued' END, updated_at=NOW()
     FROM paid WHERE i.id=$1 RETURNING i.*, paid.total AS total_paid,
       GREATEST(i.total_amount-paid.total,0) AS outstanding_balance`,
    [invoiceId],
  );
  return res.rows[0] || null;
}

/** Total paid (payments + credits) and outstanding for one invoice. */
async function getInvoicePaidTotals(client, invoiceId) {
  const res = await client.query(
    `SELECT i.total_amount, p.total_paid,
            GREATEST(i.total_amount - p.total_paid, 0) AS outstanding
       FROM trailer_invoices i ${PAID_TOTAL_LATERAL}
      WHERE i.id = $1`,
    [invoiceId],
  );
  return res.rows[0] || null;
}

module.exports = { refreshInvoiceStatus, getInvoicePaidTotals, PAID_TOTAL_LATERAL };
