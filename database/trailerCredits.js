/**
 * Company credits — overpayment banking and application.
 *
 * A payment above an invoice's outstanding balance is rejected by default. With
 * the trailer_payments.record_overpayment permission and explicit confirmation,
 * the excess is banked as a company credit (trailer_company_credits) that can be
 * applied to a future invoice through an auditable ledger
 * (trailer_company_credit_applications). Credits never silently disappear.
 *
 * All mutations accept a transaction client so they compose with payment
 * recording; each keeps the credit's remaining_amount and status consistent.
 */
'use strict';

const { pool, query } = require('./pool');
const { insertTrailerAudit } = require('./trailerAudit');
const { refreshInvoiceStatus, getInvoicePaidTotals } = require('./trailerInvoiceStatus');

function error(message, status = 400, code) {
  return Object.assign(new Error(message), { status, code });
}

/** Create a credit for a company (e.g. the excess of an overpayment). */
async function createCompanyCredit(input, client = { query }) {
  const amount = Number(input.amount);
  if (!input.company_id || !(amount > 0)) throw error('A company and a positive amount are required.');
  const res = await client.query(
    `INSERT INTO trailer_company_credits
       (company_id, source_payment_id, source_invoice_id, original_amount, remaining_amount,
        reason, status, created_by_admin_id)
     VALUES ($1,$2,$3,$4,$4,$5,'active',$6) RETURNING *`,
    [Number(input.company_id), input.source_payment_id || null, input.source_invoice_id || null,
      amount, input.reason || null, input.created_by_admin_id || null],
  );
  return res.rows[0];
}

async function listCompanyCredits(companyId, { includeApplied = true } = {}) {
  const where = ['company_id = $1'];
  if (!includeApplied) where.push("status <> 'applied'");
  const res = await query(
    `SELECT * FROM trailer_company_credits WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
    [Number(companyId)],
  );
  return res.rows;
}

/**
 * Apply a credit to an invoice, recording a ledger entry and decrementing the
 * credit's remaining balance. Transactional and lock-safe. The invoice is
 * required and locked, the application is capped at the invoice's outstanding
 * balance (payments + prior credit applications), and the invoice status is
 * refreshed in the SAME transaction — so an applied credit visibly reduces the
 * balance everywhere immediately.
 */
async function applyCompanyCredit({ creditId, invoiceId, amount, actor = {} }) {
  if (!invoiceId) throw error('Choose the invoice this credit should be applied to.', 400, 'INVOICE_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const creditRes = await client.query(
      'SELECT * FROM trailer_company_credits WHERE id = $1 FOR UPDATE', [Number(creditId)],
    );
    const credit = creditRes.rows[0];
    if (!credit) throw error('Credit not found.', 404);
    if (credit.status === 'applied' || Number(credit.remaining_amount) <= 0) {
      throw error('This credit has no remaining balance.', 409, 'CREDIT_EXHAUSTED');
    }
    const invoiceRes = await client.query(
      'SELECT * FROM trailer_invoices WHERE id = $1 FOR UPDATE', [Number(invoiceId)],
    );
    const invoice = invoiceRes.rows[0];
    if (!invoice) throw error('Invoice not found.', 404);
    if (Number(invoice.company_id) !== Number(credit.company_id)) {
      throw error('This credit belongs to a different company.', 409, 'CREDIT_COMPANY_MISMATCH');
    }
    if (['voided', 'disputed'].includes(invoice.status)) {
      throw error('Credits cannot be applied to a voided or disputed invoice.', 409);
    }
    const totals = await getInvoicePaidTotals(client, invoice.id);
    const outstanding = Number(totals?.outstanding || 0);
    if (outstanding <= 0) throw error('This invoice has no outstanding balance.', 409, 'INVOICE_ALREADY_PAID');
    const requested = Number(amount) > 0 ? Number(amount) : Number(credit.remaining_amount);
    if (requested > Number(credit.remaining_amount)) {
      throw error('Cannot apply more than the credit balance.', 422, 'CREDIT_OVER_APPLY');
    }
    const apply = Math.min(requested, outstanding);
    await client.query(
      `INSERT INTO trailer_company_credit_applications (credit_id, invoice_id, amount, applied_by_admin_id)
       VALUES ($1,$2,$3,$4)`,
      [credit.id, invoice.id, apply, actor.id || null],
    );
    const remaining = Number(credit.remaining_amount) - apply;
    const status = remaining <= 0 ? 'applied' : 'partially_applied';
    const updated = await client.query(
      `UPDATE trailer_company_credits
          SET remaining_amount = $2, status = $3, applied_at = CASE WHEN $3 = 'applied' THEN NOW() ELSE applied_at END
        WHERE id = $1 RETURNING *`,
      [credit.id, remaining, status],
    );
    const refreshedInvoice = await refreshInvoiceStatus(client, invoice.id);
    await insertTrailerAudit({
      adminId: actor.id || null, roleKeys: actor.roleKeys, ipAddress: actor.ipAddress,
      action: 'credit.apply', entityType: 'company_credit', entityId: credit.id,
      oldValues: credit, newValues: { ...updated.rows[0], applied_to_invoice_id: invoice.id, applied_amount: apply },
    }, client);
    await client.query('COMMIT');
    return { ...updated.rows[0], invoice: refreshedInvoice, applied_amount: apply };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createCompanyCredit, listCompanyCredits, applyCompanyCredit };
