/**
 * PostgreSQL integration — the trailer detail overview: one response with the
 * trailer, rentals from BOTH systems (backfilled legacy mirrors deduplicated),
 * movements, media metadata (never bytes), invoices with outstanding, aliases
 * and the audit trail.
 *
 * Requires TEST_DATABASE_URL; SKIPs without it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

test('getTrailerOverview stitches the full story of one trailer', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerOverview } = harness.loadDataLayer(['trailerOverview']);

  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id",
  );
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, active, master_status, master_source, make)
     VALUES ('OV-1','rented',TRUE,'active','admin_manual','Wabash') RETURNING id`,
  );
  const trailerId = trailer.rows[0].id;
  const companyId = company.rows[0].id;

  // A legacy rental… which the boot backfill mirrors into an agreement + item;
  // simulate that mirror so the dedupe rule is exercised.
  const rental = await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate, billing_method)
     VALUES ('RENT-OV-1',$1,$2,'active',NOW()-INTERVAL '3 days',NOW()+INTERVAL '4 days',100,'calendar_day') RETURNING id`,
    [trailerId, companyId],
  );
  const agreement = await harness.query(
    `INSERT INTO trailer_rental_agreements (agreement_number, company_id, status, legacy_rental_id)
     VALUES ('RENT-OV-1',$1,'active',$2) RETURNING id`,
    [companyId, rental.rows[0].id],
  );
  await harness.query(
    `INSERT INTO trailer_rental_items (agreement_id, trailer_id, item_sequence, item_status,
       scheduled_pickup_at, actual_pickup_at, expected_return_at, pricing_mode, daily_rate, legacy_rental_id)
     VALUES ($1,$2,1,'active',NOW()-INTERVAL '3 days',NOW()-INTERVAL '3 days',NOW()+INTERVAL '4 days','daily',100,$3)`,
    [agreement.rows[0].id, trailerId, rental.rows[0].id],
  );
  await harness.query(
    `INSERT INTO trailer_rental_movements (trailer_id, rental_id, movement_type, to_location, event_at)
     VALUES ($1,$2,'rental_pickup','Yard 4',NOW()-INTERVAL '3 days')`,
    [trailerId, rental.rows[0].id],
  );
  const blob = await harness.query(
    `INSERT INTO trailer_media_blobs (mime_type, original_filename, byte_size, checksum_sha256, file_data)
     VALUES ('image/jpeg','p.jpg',3,'abc','\\x010203') RETURNING id`,
  );
  await harness.query(
    `INSERT INTO trailer_media (media_type, trailer_id, rental_id, storage_backend, blob_id,
       original_filename, mime_type, original_size_bytes, checksum_sha256, bucket, object_path)
     VALUES ('pickup_condition_photo',$1,$2,'database',$3,'p.jpg','image/jpeg',3,'abc',NULL,NULL)`,
    [trailerId, rental.rows[0].id, blob.rows[0].id],
  );
  await harness.query(
    `INSERT INTO trailer_invoices (invoice_number, rental_id, trailer_id, company_id,
       billing_period_start, billing_period_end, billing_method, base_amount, total_amount, due_at, status)
     VALUES ('INV-OV-1',$1,$2,$3,NOW()-INTERVAL '3 days',NOW(),'calendar_day',300,300,NOW()+INTERVAL '5 days','issued')`,
    [rental.rows[0].id, trailerId, companyId],
  );
  await harness.query(
    `INSERT INTO trailer_aliases (trailer_id, alias_unit_number, active, alias_type) VALUES ($1,'OV-1A',TRUE,'historical')`,
    [trailerId],
  );

  const overview = await trailerOverview.getTrailerOverview(trailerId);
  assert.equal(overview.trailer.unit_number, 'OV-1');
  // The backfilled legacy rental appears ONCE, through its agreement item.
  assert.equal(overview.rentals.length, 1);
  assert.equal(overview.rentals[0].kind, 'agreement');
  assert.equal(overview.rentals[0].company_name, 'Acme');
  assert.equal(overview.movements.length, 1);
  assert.equal(overview.media.length, 1);
  assert.ok(!('file_data' in overview.media[0]), 'media stays metadata-only');
  assert.equal(overview.invoices.length, 1);
  assert.equal(Number(overview.invoices[0].outstanding_balance), 300);
  assert.equal(overview.aliases.length, 1);
  assert.equal(await trailerOverview.getTrailerOverview(999999), null);
});
