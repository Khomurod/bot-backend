/**
 * PostgreSQL integration — invoice detail enrichment (§4). The detail payload
 * must carry the notification job id (so a failed Telegram confirmation can be
 * retried from the invoice), and each payment must carry who recorded it and
 * the reversal reason when reversed.
 *
 * Requires TEST_DATABASE_URL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const POOL_PATH = require.resolve('../database/pool');

function loadFinance(harness) {
  const dbDir = path.resolve(__dirname, '../database');
  const purge = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) purge(full);
      else if (entry.name.endsWith('.js')) delete require.cache[full];
    }
  };
  purge(dbDir);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: (t, v) => harness.pool.query(t, v), ping: async () => true },
  };
  return require('../database/trailerFinance');
}

async function seed(harness) {
  const admin = await harness.query("INSERT INTO admins (username, password_hash) VALUES ('recorder','x') RETURNING id");
  const company = await harness.query("INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id");
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
     VALUES ('ID-1','rented',FALSE,TRUE,'active','admin_manual') RETURNING id`);
  const rental = await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate, billing_method)
     VALUES ('RENT-ID-1',$1,$2,'active',NOW()-INTERVAL '3 days',NOW()+INTERVAL '5 days',100,'calendar_day') RETURNING id`,
    [trailer.rows[0].id, company.rows[0].id]);
  const invoice = await harness.query(
    `INSERT INTO trailer_invoices (invoice_number, rental_id, trailer_id, company_id, billing_period_start, billing_period_end,
       billing_method, base_amount, total_amount, status, due_at)
     VALUES ('INV-ID-1',$1,$2,$3,NOW()-INTERVAL '3 days',NOW(),'calendar_day',500,500,'issued',NOW()+INTERVAL '7 days') RETURNING id`,
    [rental.rows[0].id, trailer.rows[0].id, company.rows[0].id]);
  const payment = await harness.query(
    `INSERT INTO trailer_payments (receipt_number, invoice_id, rental_id, trailer_id, company_id, amount, payment_at,
       payment_method, idempotency_key, receipt_bypass_reason, recorded_by_admin_id, verification_status)
     VALUES ('RCPT-ID-1',$1,$2,$3,$4,200,NOW(),'cash','k-id-1','test',$5,'reversed') RETURNING id`,
    [invoice.rows[0].id, rental.rows[0].id, trailer.rows[0].id, company.rows[0].id, admin.rows[0].id]);
  await harness.query(
    "INSERT INTO trailer_payment_reversals (payment_id, reason, reversed_by_admin_id) VALUES ($1,'duplicate entry',$2)",
    [payment.rows[0].id, admin.rows[0].id]);
  // A failed payment-confirmation notification job for the payment.
  const job = await harness.query(
    `INSERT INTO trailer_notification_jobs (job_type, entity_type, entity_id, idempotency_key, status, last_error)
     VALUES ('payment_confirmation','payment',$1,'n-id-1','failed','chat unreachable') RETURNING id`,
    [payment.rows[0].id]);
  return { invoiceId: invoice.rows[0].id, jobId: job.rows[0].id };
}

test('invoice detail carries the notification job id, status and error', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const finance = loadFinance(harness);
  const { invoiceId, jobId } = await seed(harness);
  const inv = await finance.getTrailerInvoice(invoiceId);
  assert.equal(Number(inv.notification_job_id), Number(jobId));
  assert.equal(inv.notification_status, 'failed');
  assert.match(inv.notification_error, /chat unreachable/);
});

test('payments carry recorded-by and the reversal reason', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const finance = loadFinance(harness);
  const { invoiceId } = await seed(harness);
  const inv = await finance.getTrailerInvoice(invoiceId);
  assert.equal(inv.payments.length, 1);
  assert.equal(inv.payments[0].recorded_by, 'recorder');
  assert.equal(inv.payments[0].reversal_reason, 'duplicate entry');
  assert.ok(inv.payments[0].reversed_at);
});
