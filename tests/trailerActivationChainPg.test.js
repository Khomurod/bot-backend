/**
 * REPRODUCTION (PostgreSQL) — the reported "Confirm Pickup and Activate" failure.
 *
 * Proves the causal chain end-to-end through the real data layer, so the fix is
 * provable rather than asserted:
 *
 *   Supabase unconfigured -> photo upload throws 503 (tests/trailerStorageFallback.test.js)
 *     -> no pickup_condition_photo row exists
 *       -> validateInspectionMedia() rejects
 *         -> activateTrailerRental() fails, and the rental stays draft
 *
 * The final assertion is the one that must KEEP passing forever: activation is
 * transactional, so a rejected activation leaves no half-active rental behind.
 *
 * When database-backed storage lands, the photo exists and activation succeeds
 * with no Supabase configured — add that as the positive case; the
 * missing-photo rejection below stays valid either way.
 *
 * Requires TEST_DATABASE_URL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

/** Minimal fixture: an available trailer, an active company, a draft rental. */
async function seedRental(harness) {
  const admin = await harness.query(
    `INSERT INTO admins (username, password_hash) VALUES ('inspector', 'x') RETURNING id`,
  );
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active)
     VALUES ('T-500', 'available', FALSE, TRUE) RETURNING id`,
  );
  const company = await harness.query(
    `INSERT INTO trailer_renter_companies (legal_name, display_name, active)
     VALUES ('Acme LLC', 'Acme', TRUE) RETURNING id`,
  );
  const rental = await harness.query(
    `INSERT INTO trailer_rentals
       (agreement_number, trailer_id, company_id, status, start_at, expected_return_at,
        daily_rate, pickup_location, billing_method)
     VALUES ('RENT-2026-000500', $1, $2, 'draft', '2026-02-01T08:00:00Z', '2026-02-10T08:00:00Z',
             150, 'Dallas Yard', 'calendar_day')
     RETURNING *`,
    [trailer.rows[0].id, company.rows[0].id],
  );
  return {
    adminId: admin.rows[0].id,
    trailerId: trailer.rows[0].id,
    companyId: company.rows[0].id,
    rental: rental.rows[0],
  };
}

/** A completed pickup inspection with every required condition field filled in. */
async function seedCompletedPickupInspection(harness, { rentalId, trailerId, adminId }) {
  const res = await harness.query(
    `INSERT INTO trailer_inspections
       (rental_id, trailer_id, inspection_type, overall_condition, tires, lights, doors, roof,
        floor, exterior, interior, landing_gear, brakes, inspector_admin_id, completed)
     VALUES ($1, $2, 'pickup', 'good', 'good', 'good', 'good', 'good',
             'good', 'good', 'good', 'good', 'good', $3, TRUE)
     RETURNING *`,
    [rentalId, trailerId, adminId],
  );
  return res.rows[0];
}

test('REPRODUCTION: activation fails when the pickup photo upload never succeeded', {
  skip: skipWithoutPg(),
  timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerId, companyId, adminId, rental } = await seedRental(harness);
  const { trailerRentals } = harness.loadDataLayer(['trailerRentals']);

  await t.test('a completed inspection is not enough without the photo', async () => {
    await seedCompletedPickupInspection(harness, { rentalId: rental.id, trailerId, adminId });

    await assert.rejects(
      () => trailerRentals.activateTrailerRental(rental.id, { id: adminId, username: 'inspector' }),
      (error) => {
        assert.match(error.message, /photos are required/i, 'the missing photo is named as the cause');
        return true;
      },
    );
  });

  await t.test('the rejected activation leaves no half-activated state behind', async () => {
    const after = await harness.query('SELECT status FROM trailer_rentals WHERE id=$1', [rental.id]);
    assert.equal(after.rows[0].status, 'draft', 'rental must not advance');

    const trailer = await harness.query('SELECT physical_status FROM trailers WHERE id=$1', [trailerId]);
    assert.equal(trailer.rows[0].physical_status, 'available', 'trailer must not be marked rented');

    const movements = await harness.query(
      'SELECT COUNT(*)::int AS count FROM trailer_rental_movements WHERE rental_id=$1',
      [rental.id],
    );
    assert.equal(movements.rows[0].count, 0, 'no pickup movement is written');
  });

  await t.test('activation succeeds once the pickup photo exists', async () => {
    // The photo row is what the failed Supabase upload never got to write.
    const inspection = await harness.query(
      `SELECT id FROM trailer_inspections WHERE rental_id=$1 AND inspection_type='pickup'`,
      [rental.id],
    );
    await harness.query(
      `INSERT INTO trailer_media
         (media_type, trailer_id, rental_id, inspection_id, bucket, object_path,
          original_filename, mime_type, original_size_bytes, checksum_sha256, uploaded_by_admin_id)
       VALUES ('pickup_condition_photo', $1, $2, $3, 'trailer-private', 'condition-photos/x/original.jpg',
               'original.jpg', 'image/jpeg', 1024, 'deadbeef', $4)`,
      [trailerId, rental.id, inspection.rows[0].id, adminId],
    );

    const result = await trailerRentals.activateTrailerRental(rental.id, { id: adminId, username: 'inspector' });

    assert.equal(result.rental.status, 'active');
    assert.ok(result.movement, 'a pickup movement is recorded');
    assert.ok(result.event, 'an accepted trailer event is recorded');

    const trailer = await harness.query('SELECT physical_status FROM trailers WHERE id=$1', [trailerId]);
    assert.equal(trailer.rows[0].physical_status, 'rented');
  });

  assert.ok(companyId, 'company fixture was used');
});
