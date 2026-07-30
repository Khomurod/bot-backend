/**
 * Inspection completion atomicity, against a real PostgreSQL.
 *
 * The defect: the frontend could mark an inspection complete BEFORE its photo
 * upload succeeded. That produced a "completed" inspection with no photo, which
 * then failed activation with a confusing error and no obvious way back.
 *
 * The rule now: saving answers always yields a draft, and completion is a
 * separate transactional step that verifies the required photo's metadata AND
 * bytes really exist. A failed upload leaves the inspection incomplete and
 * retryable.
 *
 * Requires TEST_DATABASE_URL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const CONDITION = {
  overall_condition: 'good', tires: 'good', lights: 'good', doors: 'good', roof: 'good',
  floor: 'good', exterior: 'good', interior: 'good', landing_gear: 'good', brakes: 'good',
};

async function seedRental(harness) {
  const admin = await harness.query(`INSERT INTO admins (username, password_hash) VALUES ('inspector', 'x') RETURNING id`);
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, master_status)
     VALUES ('T-INSPECT', 'available', FALSE, 'active') RETURNING id`,
  );
  const company = await harness.query(
    `INSERT INTO trailer_renter_companies (legal_name, display_name) VALUES ('Acme', 'Acme') RETURNING id`,
  );
  const rental = await harness.query(
    `INSERT INTO trailer_rentals
       (agreement_number, trailer_id, company_id, status, start_at, expected_return_at,
        daily_rate, pickup_location, billing_method)
     VALUES ('RENT-2026-000700', $1, $2, 'draft', '2026-03-01T08:00:00Z', '2026-03-10T08:00:00Z',
             120, 'Dallas Yard', 'calendar_day') RETURNING *`,
    [trailer.rows[0].id, company.rows[0].id],
  );
  return { adminId: admin.rows[0].id, trailerId: trailer.rows[0].id, rental: rental.rows[0] };
}

test('an inspection cannot be completed without its photo', {
  skip: skipWithoutPg(), timeout: 60000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerRentals, trailerMedia } = harness.loadDataLayer(['trailerRentals', 'trailerMedia']);
  const storage = harness.loadStorage({ supabaseConfigured: false });
  const { adminId, trailerId, rental } = await seedRental(harness);
  const actor = { id: adminId, username: 'inspector' };

  await t.test('saving answers always produces a DRAFT, even asking for completed', async () => {
    // The frontend asking for completion is exactly the bug; the backend refuses
    // to take its word for it.
    const inspection = await trailerRentals.saveInspection({
      ...CONDITION, rental_id: rental.id, inspection_type: 'pickup', completed: true,
    }, actor);
    assert.equal(inspection.completed, false, 'completion is not the frontend’s to assert');
  });

  await t.test('completing without a photo is refused, and stays refused', async () => {
    await assert.rejects(
      () => trailerRentals.completeInspection(rental.id, 'pickup', actor),
      (error) => {
        assert.equal(error.status, 422);
        assert.match(error.message, /photo must be uploaded/i, 'the user is told exactly what is missing');
        return true;
      },
    );
    const after = await harness.query(
      `SELECT completed FROM trailer_inspections WHERE rental_id=$1 AND inspection_type='pickup'`,
      [rental.id],
    );
    assert.equal(after.rows[0].completed, false, 'the draft survives for a retry');
  });

  await t.test('the failed completion left the form data intact to retry with', async () => {
    const saved = await harness.query(
      `SELECT * FROM trailer_inspections WHERE rental_id=$1 AND inspection_type='pickup'`,
      [rental.id],
    );
    assert.equal(saved.rows[0].overall_condition, 'good', 'answers are not lost');
    assert.equal(saved.rows[0].tires, 'good');
  });

  await t.test('activation is still blocked while the inspection is incomplete', async () => {
    await assert.rejects(
      () => trailerRentals.activateTrailerRental(rental.id, actor),
      /completed pickup inspection is required/i,
    );
  });

  let inspectionId;
  await t.test('once the photo is uploaded, completion succeeds', async () => {
    const found = await harness.query(
      `SELECT id FROM trailer_inspections WHERE rental_id=$1 AND inspection_type='pickup'`,
      [rental.id],
    );
    inspectionId = found.rows[0].id;

    const bytes = Buffer.from('pickup-photo-bytes');
    const descriptor = await storage.putObject({
      bytes, contentType: 'image/jpeg', filename: 'pickup.jpg',
      checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
    }, { actor });
    await trailerMedia.createTrailerMedia({
      ...descriptor, mediaType: 'pickup_condition_photo', trailerId, rentalId: rental.id,
      inspectionId, originalFilename: 'pickup.jpg', mimeType: 'image/jpeg',
      originalSize: bytes.length, checksum: 'abc', uploadedByAdminId: adminId,
    });

    const completed = await trailerRentals.completeInspection(rental.id, 'pickup', actor);
    assert.equal(completed.completed, true);
  });

  await t.test('completion is audited', async () => {
    const audit = await harness.query(
      `SELECT * FROM trailer_audit_log WHERE action = 'inspection.complete' AND entity_id = $1`,
      [String(inspectionId)],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].admin_id, adminId);
  });

  await t.test('re-saving answers does not silently un-complete it', async () => {
    await trailerRentals.saveInspection({
      ...CONDITION, notes: 'added a note afterwards', rental_id: rental.id, inspection_type: 'pickup',
    }, actor);
    const after = await harness.query('SELECT completed, notes FROM trailer_inspections WHERE id=$1', [inspectionId]);
    assert.equal(after.rows[0].completed, true, 'editing a note must not undo completion');
    assert.equal(after.rows[0].notes, 'added a note afterwards');
  });

  await t.test('and activation now succeeds', async () => {
    const result = await trailerRentals.activateTrailerRental(rental.id, actor);
    assert.equal(result.rental.status, 'active');
  });
});

test('a photo record without bytes cannot exist in the first place', {
  skip: skipWithoutPg(), timeout: 60000,
}, async (t) => {
  // Metadata alone must never pass for a stored file — that mismatch is what
  // made the original failure so confusing (something looked present but was
  // not). Rather than only catching it at completion time, the schema makes the
  // state unreachable, and an empty upload is refused outright.
  const harness = await createTrailerPgHarness(t);
  const { trailerRentals, trailerMedia } = harness.loadDataLayer(['trailerRentals', 'trailerMedia']);
  const storage = harness.loadStorage({ supabaseConfigured: false });
  const { adminId, trailerId, rental } = await seedRental(harness);
  const actor = { id: adminId, username: 'inspector' };

  await trailerRentals.saveInspection({ ...CONDITION, rental_id: rental.id, inspection_type: 'pickup' }, actor);
  const inspection = await harness.query(
    `SELECT id FROM trailer_inspections WHERE rental_id=$1 AND inspection_type='pickup'`, [rental.id],
  );

  await t.test('metadata claiming the database backend but naming no blob is rejected', async () => {
    await assert.rejects(
      () => trailerMedia.createTrailerMedia({
        storageBackend: 'database', blobId: null,
        mediaType: 'pickup_condition_photo', trailerId, rentalId: rental.id,
        inspectionId: inspection.rows[0].id, originalFilename: 'p.jpg', mimeType: 'image/jpeg',
        originalSize: 9, checksum: 'abc', uploadedByAdminId: adminId,
      }),
      (error) => error.code === '23514',
    );
  });

  await t.test('an empty upload is refused before any row is written', async () => {
    await assert.rejects(
      () => storage.putObject({
        bytes: Buffer.alloc(0), contentType: 'image/jpeg', filename: 'empty.jpg', checksum: 'abc',
      }, { actor }),
      /empty file/i,
    );
  });

  await t.test('so the inspection is still incomplete and still retryable', async () => {
    await assert.rejects(
      () => trailerRentals.completeInspection(rental.id, 'pickup', actor),
      /photo must be uploaded/i,
    );
    const after = await harness.query('SELECT completed FROM trailer_inspections WHERE id=$1', [inspection.rows[0].id]);
    assert.equal(after.rows[0].completed, false);
  });

  await t.test('deleting a blob out from under live media is blocked by the FK', async () => {
    const bytes = Buffer.from('real-photo');
    const descriptor = await storage.putObject({
      bytes, contentType: 'image/jpeg', filename: 'p.jpg',
      checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
    }, { actor });
    await trailerMedia.createTrailerMedia({
      ...descriptor, mediaType: 'pickup_condition_photo', trailerId, rentalId: rental.id,
      inspectionId: inspection.rows[0].id, originalFilename: 'p.jpg', mimeType: 'image/jpeg',
      originalSize: bytes.length, checksum: 'abc', uploadedByAdminId: adminId,
    });

    // Assert on the SQLSTATE and the constraint NAME rather than on the error
    // prose: PostgreSQL words an ON DELETE RESTRICT violation as the generic
    // "violates foreign key constraint …" (verified on PG 16 and 17), and
    // matching the wording made this check fail on every supported server.
    // Checking 23503 + the constraint identity is both version-independent and
    // stricter than the previous message regex, which named no constraint.
    await assert.rejects(
      () => harness.query('DELETE FROM trailer_media_blobs WHERE id = $1', [descriptor.blobId]),
      (err) => {
        assert.equal(err.code, '23503', 'must be a foreign_key_violation');
        assert.equal(err.constraint, 'trailer_media_blob_id_fkey', 'blocked by the live-media FK');
        assert.match(err.message, /violates .*foreign key constraint/i);
        return true;
      },
      'a live photo can never be gutted, leaving metadata pointing at nothing',
    );

    // The RESTRICT actually protected the row: the bytes are still there.
    const stillThere = await harness.query(
      'SELECT COUNT(*)::int AS n FROM trailer_media_blobs WHERE id = $1',
      [descriptor.blobId],
    );
    assert.equal(stillThere.rows[0].n, 1, 'the blob survives the rejected delete');
  });
});
