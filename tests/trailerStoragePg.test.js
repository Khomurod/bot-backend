/**
 * THE FIX, proved against a real PostgreSQL: Trailer Department files store and
 * read back with NO Supabase bucket configured, and pickup activation therefore
 * succeeds.
 *
 * The failure this closes:
 *   Supabase unconfigured -> upload threw 503
 *     -> no pickup_condition_photo row
 *       -> validateInspectionMedia rejected
 *         -> "Confirm Pickup and Activate" failed
 *
 * Requires TEST_DATABASE_URL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const bytesOf = (text) => Buffer.from(text, 'utf8');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

test('files store and read back with no Supabase configured', {
  skip: skipWithoutPg(), timeout: 60000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerMedia } = harness.loadDataLayer(['trailerMedia']);
  const storage = harness.loadStorage({ supabaseConfigured: false });

  const admin = await harness.query(`INSERT INTO admins (username, password_hash) VALUES ('u', 'x') RETURNING id`);
  const adminId = admin.rows[0].id;

  await t.test('the database backend is selected automatically', () => {
    assert.equal(storage.activeBackend(), 'database');
    assert.equal(storage.isSupabaseConfigured(), false);
    assert.equal(storage.isConfigured(), true, 'storage always works — no bucket needed');
  });

  let mediaId;
  await t.test('an upload stores bytes instead of throwing 503', async () => {
    const bytes = bytesOf('pretend-jpeg-bytes');
    const descriptor = await storage.putObject({
      bytes, contentType: 'image/jpeg', filename: 'pickup.jpg', checksum: sha256(bytes),
    }, { actor: { id: adminId } });

    assert.equal(descriptor.storageBackend, 'database');
    assert.ok(descriptor.blobId, 'the bytes landed in trailer_media_blobs');
    assert.equal(descriptor.byteSize, bytes.length);

    const media = await trailerMedia.createTrailerMedia({
      ...descriptor, mediaType: 'pickup_condition_photo',
      originalFilename: 'pickup.jpg', mimeType: 'image/jpeg',
      originalSize: bytes.length, checksum: sha256(bytes), uploadedByAdminId: adminId,
    });
    mediaId = media.id;
    assert.equal(media.storage_backend, 'database');
    assert.equal(media.bucket, null, 'no bucket is involved');
    assert.equal(media.object_path, null);
  });

  await t.test('the bytes read back byte-for-byte', async () => {
    const media = await trailerMedia.getTrailerMedia(mediaId);
    const stored = await storage.getObject(media);
    assert.equal(stored.bytes.toString('utf8'), 'pretend-jpeg-bytes');
    assert.equal(stored.mimeType, 'image/jpeg');
  });

  await t.test('list queries never drag the bytes along', async () => {
    // BYTEA in a list endpoint would be a memory problem on a small instance.
    const rows = await trailerMedia.listInspectionMedia(null, 'pickup_condition_photo');
    for (const row of rows) {
      assert.equal(row.file_data, undefined, 'metadata queries must not select BYTEA');
    }
  });

  await t.test('storage usage is reportable', async () => {
    const usage = await storage.storageUsage();
    assert.ok(usage.blob_count >= 1);
    assert.ok(usage.total_bytes > 0);
  });

  await t.test('a media row must be able to find its own bytes', async () => {
    // The CHECK constraint is the backstop against a row that claims a backend
    // it has no pointer for.
    await assert.rejects(
      () => harness.query(
        `INSERT INTO trailer_media
           (media_type, storage_backend, original_filename, mime_type, original_size_bytes, checksum_sha256)
         VALUES ('damage_photo', 'database', 'x.jpg', 'image/jpeg', 10, 'abc')`,
      ),
      (error) => error.code === '23514',
      'database-backed media without a blob_id is rejected',
    );
    await assert.rejects(
      () => harness.query(
        `INSERT INTO trailer_media
           (media_type, storage_backend, original_filename, mime_type, original_size_bytes, checksum_sha256)
         VALUES ('damage_photo', 'supabase', 'x.jpg', 'image/jpeg', 10, 'abc')`,
      ),
      (error) => error.code === '23514',
      'supabase-backed media without an object_path is rejected',
    );
  });

  await t.test('orphaned bytes are cleaned up when metadata fails', async () => {
    const bytes = bytesOf('orphan');
    const descriptor = await storage.putObject({
      bytes, contentType: 'image/jpeg', filename: 'orphan.jpg', checksum: sha256(bytes),
    }, { actor: { id: adminId } });

    await storage.removeObjects([descriptor]);

    const blob = await harness.query('SELECT id FROM trailer_media_blobs WHERE id = $1', [descriptor.blobId]);
    assert.equal(blob.rows.length, 0, 'no bytes are left behind');
  });

  await t.test('a blob still referenced by media cannot be deleted', async () => {
    // The FK is RESTRICT: cleanup must never be able to gut a live file.
    const media = await trailerMedia.getTrailerMedia(mediaId);
    await storage.removeObjects([{ blobId: media.blob_id }]);
    const still = await harness.query('SELECT id FROM trailer_media_blobs WHERE id = $1', [media.blob_id]);
    assert.equal(still.rows.length, 1, 'the live file survives');
  });
});

test('a Supabase-backed file keeps working after Supabase is configured later', {
  skip: skipWithoutPg(), timeout: 60000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerMedia } = harness.loadDataLayer(['trailerMedia']);

  // Written while unconfigured...
  const unconfigured = harness.loadStorage({ supabaseConfigured: false });
  const bytes = bytesOf('older-database-file');
  const descriptor = await unconfigured.putObject({
    bytes, contentType: 'image/jpeg', filename: 'old.jpg', checksum: sha256(bytes),
  });
  const media = await trailerMedia.createTrailerMedia({
    ...descriptor, mediaType: 'pickup_condition_photo', originalFilename: 'old.jpg',
    mimeType: 'image/jpeg', originalSize: bytes.length, checksum: sha256(bytes),
  });

  // ...and read back once Supabase IS configured. Reads must follow the backend
  // recorded ON THE ROW, never today's configuration, or every pre-existing
  // file would 404 the moment a bucket is added.
  const configured = harness.loadStorage({ supabaseConfigured: true });
  assert.equal(configured.activeBackend(), 'supabase', 'new uploads would go to Supabase');

  const stored = await configured.getObject(await trailerMedia.getTrailerMedia(media.id));
  assert.equal(stored.bytes.toString('utf8'), 'older-database-file', 'the old file still reads');
});

test('activation succeeds with no Supabase configured', { skip: skipWithoutPg(), timeout: 60000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerRentals, trailerMedia } = harness.loadDataLayer(['trailerRentals', 'trailerMedia']);
  const storage = harness.loadStorage({ supabaseConfigured: false });

  const admin = await harness.query(`INSERT INTO admins (username, password_hash) VALUES ('inspector', 'x') RETURNING id`);
  const adminId = admin.rows[0].id;
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, master_status)
     VALUES ('T-ACTIVATE', 'available', FALSE, 'active') RETURNING id`,
  );
  const company = await harness.query(
    `INSERT INTO trailer_renter_companies (legal_name, display_name) VALUES ('Acme', 'Acme') RETURNING id`,
  );
  const rental = await harness.query(
    `INSERT INTO trailer_rentals
       (agreement_number, trailer_id, company_id, status, start_at, expected_return_at,
        daily_rate, pickup_location, billing_method)
     VALUES ('RENT-2026-000900', $1, $2, 'draft', '2026-02-01T08:00:00Z', '2026-02-10T08:00:00Z',
             150, 'Dallas Yard', 'calendar_day') RETURNING *`,
    [trailer.rows[0].id, company.rows[0].id],
  );
  const inspection = await harness.query(
    `INSERT INTO trailer_inspections
       (rental_id, trailer_id, inspection_type, overall_condition, tires, lights, doors, roof,
        floor, exterior, interior, landing_gear, brakes, inspector_admin_id, completed)
     VALUES ($1, $2, 'pickup', 'good','good','good','good','good','good','good','good','good','good', $3, TRUE)
     RETURNING id`,
    [rental.rows[0].id, trailer.rows[0].id, adminId],
  );

  // The upload that used to throw 503 — the whole reason activation failed.
  const bytes = bytesOf('pickup-photo');
  const descriptor = await storage.putObject({
    bytes, contentType: 'image/jpeg', filename: 'pickup.jpg', checksum: sha256(bytes),
  }, { actor: { id: adminId } });
  await trailerMedia.createTrailerMedia({
    ...descriptor, mediaType: 'pickup_condition_photo', trailerId: trailer.rows[0].id,
    rentalId: rental.rows[0].id, inspectionId: inspection.rows[0].id,
    originalFilename: 'pickup.jpg', mimeType: 'image/jpeg',
    originalSize: bytes.length, checksum: sha256(bytes), uploadedByAdminId: adminId,
  });

  const result = await trailerRentals.activateTrailerRental(rental.rows[0].id, { id: adminId, username: 'inspector' });

  assert.equal(result.rental.status, 'active', 'Confirm Pickup and Activate now succeeds');
  assert.ok(result.movement, 'the pickup movement is recorded');
  const after = await harness.query('SELECT physical_status FROM trailers WHERE id = $1', [trailer.rows[0].id]);
  assert.equal(after.rows[0].physical_status, 'rented');
});
