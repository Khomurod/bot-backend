/**
 * Real-PostgreSQL integration for the review workflow + multi-event unique index.
 * SKIPPED unless TEST_DATABASE_URL is set (so CI without a database still passes).
 * Locally:  TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/trailerfresh \
 *           node --test tests/trailerReviewPg.test.js
 *
 * Validates against a live schema (not a fake): the 3-column dedupe unique index
 * supports multiple events per Telegram message, and accept/decline/edit drive
 * current status correctly with a full audit trail.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test('trailer review PG integration (skipped: set TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  const { Pool } = require('pg');
  const crypto = require('node:crypto');
  // Own schema, pinned on the connection — see trailerCargoPg for why public
  // must stay clean.
  const PG_DB = `rev_${crypto.randomBytes(4).toString('hex')}`;
  const dbUrl = new URL(TEST_DB); dbUrl.pathname = `/${PG_DB}`;
  const pool = new Pool({ connectionString: dbUrl.toString() });
  const query = (text, params) => pool.query(text, params);

  // Point database/trailers.js at THIS pool via the module-cache seam.
  const poolPath = path.resolve(__dirname, '../database/pool.js');
  require.cache[poolPath] = { exports: { pool, query, ping: async () => true } };
  const db = require(path.resolve(__dirname, '../database/trailers.js'));

  /**
   * A detection can no longer conjure a trailer (master-list authority), so
   * fixtures create it explicitly, the way an authorized employee would.
   */
  const seedTrailer = (unit) => db.upsertTrailerByUnitNumber({ unit_number: unit, source: 'admin_manual' });

  const base = `PGIT${Date.now().toString().slice(-6)}`;
  const gid = 900000 + (Date.now() % 90000);
  // Each test gets its OWN trailer so cross-test events never interfere with
  // status recompute (which orders by COALESCE(event_time, created_at)).
  const U1 = `${base}A`;
  const U2 = `${base}B`;
  const U3 = `${base}C`;
  const U4 = `${base}D`;

  test('setup: apply schema (idempotent)', async () => {
    // Own database, using its own public schema — the shape production runs
    // in. schema.sql's guards check constraints by NAME without a schema
    // filter, so several schemas in one database make them misfire.
    const admin = new Pool({ connectionString: TEST_DB });
    await admin.query(`CREATE DATABASE ${PG_DB} WITH ENCODING 'UTF8' TEMPLATE template0`);
    await admin.end();
    const schema = fs.readFileSync(path.resolve(__dirname, '../database/schema.sql'), 'utf8');
    await pool.query(schema);
  });

  test('unique index supports multiple events per Telegram message', async () => {
    const t = await seedTrailer(U1);
    const a = await db.insertTrailerEvent({ trailer_id: t.id, trailer_unit_number: U1, event_type: 'pickup', telegram_group_id: gid, telegram_message_id: 1, event_index: 0, review_status: 'pending' });
    const b = await db.insertTrailerEvent({ trailer_id: t.id, trailer_unit_number: U1, event_type: 'dropoff', telegram_group_id: gid, telegram_message_id: 1, event_index: 1, review_status: 'pending' });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, false);
    // Same (group, message, index) again → deduped.
    const dupe = await db.insertTrailerEvent({ trailer_id: t.id, trailer_unit_number: U1, event_type: 'pickup', telegram_group_id: gid, telegram_message_id: 1, event_index: 0 });
    assert.equal(dupe.duplicate, true);
  });

  test('accept keeps status; decline restores previous; declined excluded; audit saved', async () => {
    const t = await seedTrailer(U2);
    const { event: pick } = await db.insertTrailerEvent({ trailer_id: t.id, trailer_unit_number: U2, event_type: 'pickup', telegram_group_id: gid, telegram_message_id: 2, event_index: 0, review_status: 'pending', event_time: '2026-07-01T10:00:00Z' });
    await db.applyEventToCurrentStatus(t, pick);
    let cs = await db.getTrailerCurrentStatus(t.id);
    assert.equal(cs.current_status, 'with_driver');
    assert.equal(cs.needs_review, true);

    // Accept → keeps status, clears review, records reviewer.
    await db.acceptTrailerEvent(pick.id, { reviewedBy: 'admin', reviewNote: 'ok' });
    cs = await db.getTrailerCurrentStatus(t.id);
    const pickRow = await db.getTrailerEventById(pick.id);
    assert.equal(cs.current_status, 'with_driver');
    assert.equal(cs.needs_review, false);
    assert.equal(pickRow.review_status, 'accepted');
    assert.equal(pickRow.reviewed_by, 'admin');
    assert.ok(pickRow.reviewed_at);

    // Newer pending dropoff → status advances.
    const { event: drop } = await db.insertTrailerEvent({ trailer_id: t.id, trailer_unit_number: U2, event_type: 'dropoff', telegram_group_id: gid, telegram_message_id: 3, event_index: 0, review_status: 'pending', event_time: '2026-07-02T10:00:00Z' });
    await db.applyEventToCurrentStatus(t, drop);
    cs = await db.getTrailerCurrentStatus(t.id);
    assert.equal(cs.current_status, 'dropped');

    // Decline the dropoff → restores the previous (accepted) pickup status.
    await db.declineTrailerEvent(drop.id, { reviewedBy: 'admin' });
    cs = await db.getTrailerCurrentStatus(t.id);
    const dropRow = await db.getTrailerEventById(drop.id);
    assert.equal(cs.current_status, 'with_driver', 'declined dropoff must not drive status');
    assert.equal(dropRow.review_status, 'declined', 'declined event kept in history');
  });

  test('edit changes fields, recomputes status, snapshots original + records corrector', async () => {
    const t = await seedTrailer(U3);
    const { event } = await db.insertTrailerEvent({ trailer_id: t.id, trailer_unit_number: U3, event_type: 'pickup', telegram_group_id: gid, telegram_message_id: 4, event_index: 0, review_status: 'pending', event_time: '2026-07-03T10:00:00Z' });
    await db.applyEventToCurrentStatus(t, event);
    await db.updateTrailerEvent(event.id, { event_type: 'dropoff', location_text: 'Miami FL' }, { correctedBy: 'admin', correctionNote: 'fix' });
    await db.recomputeTrailerCurrentStatus(t.id);
    const cs = await db.getTrailerCurrentStatus(t.id);
    const row = await db.getTrailerEventById(event.id);
    assert.equal(cs.current_status, 'dropped');
    assert.equal(row.review_status, 'edited');
    assert.equal(row.corrected_by, 'admin');
    assert.ok(row.original_event_snapshot, 'original snapshot saved');
  });

  test('geocode fields persist on an event', async () => {
    const t = await seedTrailer(U4);
    const { event } = await db.insertTrailerEvent({ trailer_id: t.id, trailer_unit_number: U4, event_type: 'pickup', telegram_group_id: gid, telegram_message_id: 5, event_index: 0, location_text: 'PA', location_lat: 40.59, location_lng: -77.2, location_source: 'approximate_state', location_confidence: 25, geocoded_at: new Date().toISOString() });
    const row = await db.getTrailerEventById(event.id);
    assert.equal(row.location_source, 'approximate_state');
    assert.equal(Number(row.location_confidence), 25);
    assert.ok(row.geocoded_at);
    await pool.end();
  });
}
