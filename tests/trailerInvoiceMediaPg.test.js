/**
 * PostgreSQL integration — invoice documents listing (§4, §9). Metadata only
 * (never BYTEA), receipts hidden from callers without the receipt permission,
 * and media reachable both directly (invoice_id) and via a payment.
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

function loadMedia(harness) {
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
  return require('../database/trailerMedia');
}

async function seed(harness) {
  const admin = await harness.query("INSERT INTO admins (username, password_hash) VALUES ('uploader','x') RETURNING id");
  const company = await harness.query("INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id");
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
     VALUES ('IM-1','rented',FALSE,TRUE,'active','admin_manual') RETURNING id`);
  const rental = await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate, billing_method)
     VALUES ('RENT-IM-1',$1,$2,'active',NOW()-INTERVAL '3 days',NOW()+INTERVAL '5 days',100,'calendar_day') RETURNING id`,
    [trailer.rows[0].id, company.rows[0].id]);
  const invoice = await harness.query(
    `INSERT INTO trailer_invoices (invoice_number, rental_id, trailer_id, company_id, billing_period_start, billing_period_end,
       billing_method, base_amount, total_amount, status, due_at)
     VALUES ('INV-IM-1',$1,$2,$3,NOW()-INTERVAL '3 days',NOW(),'calendar_day',300,300,'issued',NOW()+INTERVAL '7 days') RETURNING id`,
    [rental.rows[0].id, trailer.rows[0].id, company.rows[0].id]);
  const payment = await harness.query(
    `INSERT INTO trailer_payments (receipt_number, invoice_id, rental_id, trailer_id, company_id, amount, payment_at, payment_method, idempotency_key, receipt_bypass_reason)
     VALUES ('RCPT-IM-1',$1,$2,$3,$4,100,NOW(),'cash','k-im-1','test') RETURNING id`,
    [invoice.rows[0].id, rental.rows[0].id, trailer.rows[0].id, company.rows[0].id]);

  // A receipt attached to the payment, and an invoice document attached directly.
  await harness.query(
    `INSERT INTO trailer_media (media_type, payment_id, bucket, object_path, original_filename, mime_type, original_size_bytes, checksum_sha256, uploaded_by_admin_id)
     VALUES ('payment_receipt',$1,'b','receipts/r1','receipt.pdf','application/pdf',10,'c1',$2)`,
    [payment.rows[0].id, admin.rows[0].id]);
  await harness.query(
    `INSERT INTO trailer_media (media_type, invoice_id, bucket, object_path, original_filename, mime_type, original_size_bytes, checksum_sha256, uploaded_by_admin_id)
     VALUES ('invoice_document',$1,'b','invoices/i1','invoice.pdf','application/pdf',20,'c2',$2)`,
    [invoice.rows[0].id, admin.rows[0].id]);
  return { invoiceId: invoice.rows[0].id };
}

test('invoice media lists documents attached directly AND via payments, with uploader', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const media = loadMedia(harness);
  const { invoiceId } = await seed(harness);
  const rows = await media.listInvoiceMedia(invoiceId);
  assert.equal(rows.length, 2);
  const types = rows.map((r) => r.media_type).sort();
  assert.deepEqual(types, ['invoice_document', 'payment_receipt']);
  assert.ok(rows.every((r) => r.uploaded_by === 'uploader'));
  // Metadata only — no bytes column in the projection.
  assert.ok(rows.every((r) => !('file_data' in r)));
});

test('receipts are hidden from callers without the receipt permission', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const media = loadMedia(harness);
  const { invoiceId } = await seed(harness);
  const rows = await media.listInvoiceMedia(invoiceId, { includeReceipts: false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].media_type, 'invoice_document');
});
