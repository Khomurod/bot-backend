/**
 * PostgreSQL integration — company detail completion (§5): documents reachable
 * via the company's invoices/payments/rentals (metadata only, receipts
 * permission-filtered) and the reminder history across its invoices.
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

function loadDb(harness, names) {
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
  const out = {};
  for (const n of names) out[n] = require(path.join(dbDir, n));
  return out;
}

async function seed(harness) {
  const admin = await harness.query("INSERT INTO admins (username, password_hash) VALUES ('cd-admin','x') RETURNING id");
  const company = await harness.query("INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id");
  const other = await harness.query("INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Globex','Globex',TRUE) RETURNING id");
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
     VALUES ('CD-1','rented',FALSE,TRUE,'active','admin_manual') RETURNING id`);
  const rental = await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate, billing_method)
     VALUES ('RENT-CD-1',$1,$2,'active',NOW()-INTERVAL '3 days',NOW()+INTERVAL '5 days',100,'calendar_day') RETURNING id`,
    [trailer.rows[0].id, company.rows[0].id]);
  const invoice = await harness.query(
    `INSERT INTO trailer_invoices (invoice_number, rental_id, trailer_id, company_id, billing_period_start, billing_period_end,
       billing_method, base_amount, total_amount, status, due_at)
     VALUES ('INV-CD-1',$1,$2,$3,NOW()-INTERVAL '3 days',NOW(),'calendar_day',300,300,'issued',NOW()) RETURNING id`,
    [rental.rows[0].id, trailer.rows[0].id, company.rows[0].id]);
  const payment = await harness.query(
    `INSERT INTO trailer_payments (receipt_number, invoice_id, rental_id, trailer_id, company_id, amount, payment_at, payment_method, idempotency_key, receipt_bypass_reason)
     VALUES ('RCPT-CD-1',$1,$2,$3,$4,100,NOW(),'cash','k-cd-1','test') RETURNING id`,
    [invoice.rows[0].id, rental.rows[0].id, trailer.rows[0].id, company.rows[0].id]);

  // One receipt via the payment, one rental photo via the rental.
  await harness.query(
    `INSERT INTO trailer_media (media_type, payment_id, bucket, object_path, original_filename, mime_type, original_size_bytes, checksum_sha256, uploaded_by_admin_id)
     VALUES ('payment_receipt',$1,'b','r/cd1','receipt.pdf','application/pdf',10,'c1',$2)`,
    [payment.rows[0].id, admin.rows[0].id]);
  await harness.query(
    `INSERT INTO trailer_media (media_type, rental_id, bucket, object_path, original_filename, mime_type, original_size_bytes, checksum_sha256)
     VALUES ('pickup_condition_photo',$1,'b','p/cd1','photo.webp','image/webp',20,'c2')`,
    [rental.rows[0].id]);
  // Reminder history rows: one for Acme's invoice, none for Globex.
  await harness.query(
    "INSERT INTO trailer_reminder_history (invoice_id, action, note, action_by_admin_id) VALUES ($1,'snooze','called them',$2)",
    [invoice.rows[0].id, admin.rows[0].id]);
  return { acme: company.rows[0].id, globex: other.rows[0].id };
}

test('company media lists documents from all attachment paths, receipts filterable', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerMedia } = loadDb(harness, ['trailerMedia']);
  const { acme, globex } = await seed(harness);

  const all = await trailerMedia.listCompanyMedia(acme);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((r) => r.media_type).sort(), ['payment_receipt', 'pickup_condition_photo']);
  assert.ok(all.every((r) => !('file_data' in r)), 'metadata only, never bytes');

  const noReceipts = await trailerMedia.listCompanyMedia(acme, { includeReceipts: false });
  assert.equal(noReceipts.length, 1);
  assert.equal(noReceipts[0].media_type, 'pickup_condition_photo');

  assert.equal((await trailerMedia.listCompanyMedia(globex)).length, 0, 'scoped to the company');
});

test('company reminder history carries invoice number and acting admin', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerNotifications } = loadDb(harness, ['trailerNotifications']);
  const { acme, globex } = await seed(harness);

  const history = await trailerNotifications.listCompanyReminderHistory(acme);
  assert.equal(history.length, 1);
  assert.equal(history[0].invoice_number, 'INV-CD-1');
  assert.equal(history[0].action, 'snooze');
  assert.equal(history[0].action_by, 'cd-admin');
  assert.equal(history[0].note, 'called them');

  assert.equal((await trailerNotifications.listCompanyReminderHistory(globex)).length, 0);
});
