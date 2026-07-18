/**
 * PostgreSQL integration — overpayment control + company credits (Phase 6).
 *
 * A payment above the outstanding balance is rejected unless explicitly
 * authorized, in which case the excess is banked as a company credit that can be
 * applied to another invoice through an auditable ledger.
 *
 * Requires TEST_DATABASE_URL; SKIPs without it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

async function seed(harness, total = 500) {
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id",
  );
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, active, master_status, master_source)
     VALUES ('OP-1','available',TRUE,'active','admin_manual') RETURNING id`,
  );
  const rental = await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, daily_rate, billing_method)
     VALUES ('RENT-OP-1',$1,$2,'draft',100,'calendar_day') RETURNING id`,
    [trailer.rows[0].id, company.rows[0].id],
  );
  const inv = await harness.query(
    `INSERT INTO trailer_invoices
       (invoice_number, rental_id, trailer_id, company_id, billing_period_start, billing_period_end,
        billing_method, base_amount, total_amount, due_at, status)
     VALUES ('INV-OP-1',$1,$2,$3,NOW()-INTERVAL '5 days',NOW(),'calendar_day',$4,$4,NOW()+INTERVAL '5 days','issued')
     RETURNING *`,
    [rental.rows[0].id, trailer.rows[0].id, company.rows[0].id, total],
  );
  return { companyId: company.rows[0].id, invoice: inv.rows[0] };
}

function payment(invoiceId, amount, extra = {}) {
  return {
    invoice_id: invoiceId, amount, payment_at: new Date().toISOString(),
    payment_method: 'cash', idempotency_key: `k-${amount}-${Math.round(amount * 7)}`,
    receipt_bypass_reason: 'cash on delivery', ...extra,
  };
}

test('exact payment marks the invoice paid', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerFinance } = harness.loadDataLayer(['trailerFinance']);
  const { invoice } = await seed(harness, 500);
  const res = await trailerFinance.recordTrailerPayment(payment(invoice.id, 500), { id: null });
  assert.equal(res.invoice.status, 'paid');
  assert.equal(res.credit, null);
});

test('partial payment marks the invoice partially_paid', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerFinance } = harness.loadDataLayer(['trailerFinance']);
  const { invoice } = await seed(harness, 500);
  const res = await trailerFinance.recordTrailerPayment(payment(invoice.id, 200), { id: null });
  assert.equal(res.invoice.status, 'partially_paid');
});

test('unauthorized overpayment is rejected', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerFinance } = harness.loadDataLayer(['trailerFinance']);
  const { invoice } = await seed(harness, 500);
  await assert.rejects(
    () => trailerFinance.recordTrailerPayment(payment(invoice.id, 600), { id: null }),
    (e) => e.status === 409,
  );
});

test('authorized overpayment banks the excess as a company credit', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerFinance, trailerCredits } = harness.loadDataLayer(['trailerFinance', 'trailerCredits']);
  const { companyId, invoice } = await seed(harness, 500);
  const res = await trailerFinance.recordTrailerPayment(
    payment(invoice.id, 600, { allow_overpayment: true }), { id: null },
  );
  assert.equal(res.invoice.status, 'paid');
  assert.ok(res.credit, 'a credit was created');
  assert.equal(Number(res.credit.original_amount), 100);
  assert.equal(Number(res.credit.remaining_amount), 100);

  const credits = await trailerCredits.listCompanyCredits(companyId);
  assert.equal(credits.length, 1);

  // A credit must name the invoice it reduces.
  await assert.rejects(
    () => trailerCredits.applyCompanyCredit({ creditId: res.credit.id, amount: 60, actor: { id: null } }),
    (e) => e.code === 'INVOICE_REQUIRED',
  );

  // A second open invoice for the same company to apply the credit against.
  const second = await harness.query(
    `INSERT INTO trailer_invoices
       (invoice_number, rental_id, trailer_id, company_id, billing_period_start, billing_period_end,
        billing_method, base_amount, total_amount, due_at, status)
     SELECT 'INV-OP-2', i.rental_id, i.trailer_id, i.company_id, NOW()-INTERVAL '2 days', NOW(),
        'calendar_day', 300, 300, NOW()+INTERVAL '5 days', 'issued'
       FROM trailer_invoices i WHERE i.id=$1 RETURNING *`,
    [invoice.id],
  );
  const target = second.rows[0];

  // Apply 60 of the 100 credit → partially_applied with 40 remaining, and the
  // invoice's outstanding drops by the applied amount in the same transaction.
  const applied = await trailerCredits.applyCompanyCredit({ creditId: res.credit.id, invoiceId: target.id, amount: 60, actor: { id: null } });
  assert.equal(applied.status, 'partially_applied');
  assert.equal(Number(applied.remaining_amount), 40);
  assert.equal(Number(applied.invoice.outstanding_balance), 240);
  assert.equal(applied.invoice.status, 'partially_paid');

  // Applying more than remaining is rejected.
  await assert.rejects(
    () => trailerCredits.applyCompanyCredit({ creditId: res.credit.id, invoiceId: target.id, amount: 100, actor: { id: null } }),
    (e) => e.code === 'CREDIT_OVER_APPLY',
  );

  // Apply the rest → fully applied, outstanding down to 200.
  const done = await trailerCredits.applyCompanyCredit({ creditId: res.credit.id, invoiceId: target.id, amount: 40, actor: { id: null } });
  assert.equal(done.status, 'applied');
  assert.equal(Number(done.remaining_amount), 0);
  assert.equal(Number(done.invoice.outstanding_balance), 200);

  // The credited amounts count as paid everywhere invoices are read.
  const listed = await trailerFinance.getTrailerInvoice(target.id);
  assert.equal(Number(listed.total_paid), 100);
  assert.equal(Number(listed.outstanding_balance), 200);
});

test('duplicate payment (same idempotency key) does not double-charge', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerFinance } = harness.loadDataLayer(['trailerFinance']);
  const { invoice } = await seed(harness, 500);
  const p = payment(invoice.id, 200, { idempotency_key: 'dup-1' });
  await trailerFinance.recordTrailerPayment(p, { id: null });
  const again = await trailerFinance.recordTrailerPayment(p, { id: null });
  assert.equal(again.duplicate, true);
});
