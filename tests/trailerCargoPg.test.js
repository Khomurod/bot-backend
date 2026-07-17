/**
 * Real-PostgreSQL integration for the unified trailer state model: cargo +
 * possession persistence, derived display_status, getUnifiedTrailerStates, and
 * that the additive schema applies twice cleanly. SKIPPED unless
 * TEST_DATABASE_URL is set.
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/trailerfresh \
 *     node --test tests/trailerCargoPg.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test('trailer cargo PG integration (skipped: set TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  const { Pool } = require('pg');
  const crypto = require('node:crypto');
  // Own schema, pinned on the connection: applying schema.sql into `public`
  // would leak these tables into every other PG suite, and CREATE TABLE IF NOT
  // EXISTS resolves across the whole search_path — so a shared public schema
  // silently stops other suites from creating their own isolated copies.
  const PG_DB = `cgo_${crypto.randomBytes(4).toString('hex')}`;
  const dbUrl = new URL(TEST_DB); dbUrl.pathname = `/${PG_DB}`;
  const pool = new Pool({ connectionString: dbUrl.toString() });
  const query = (text, params) => pool.query(text, params);
  const poolPath = path.resolve(__dirname, '../database/pool.js');
  require.cache[poolPath] = { exports: { pool, query, ping: async () => true } };
  const db = require(path.resolve(__dirname, '../database/trailers.js'));

  const base = `CGO${Date.now().toString().slice(-6)}`;
  const gid = 910000 + (Date.now() % 80000);

  test('setup: apply schema TWICE (idempotent)', async () => {
    // Own database, using its own public schema — the shape production runs
    // in. schema.sql's guards check constraints by NAME without a schema
    // filter, so several schemas in one database make them misfire.
    const admin = new Pool({ connectionString: TEST_DB });
    await admin.query(`CREATE DATABASE ${PG_DB} WITH ENCODING 'UTF8' TEMPLATE template0`);
    await admin.end();
    const schema = fs.readFileSync(path.resolve(__dirname, '../database/schema.sql'), 'utf8');
    await query(schema);
    await query(schema); // second apply must not fail
  });

  async function insertPickupDropoff(unit, eventType, possession, cargo, msgId) {
    // A detection can no longer conjure a trailer (master-list authority), so
    // the fixture creates it explicitly, the way an employee would.
    const trailer = await db.upsertTrailerByUnitNumber({ unit_number: unit, source: 'admin_manual' });
    const { event } = await db.insertTrailerEvent({
      trailer_id: trailer.id, trailer_unit_number: unit, event_type: eventType,
      possession_status: possession, cargo_status: cargo, confidence: 90,
      telegram_group_id: gid, telegram_message_id: msgId, event_index: 0,
      location_text: 'Lancaster PA', review_status: 'accepted', source: 'telegram',
    });
    await db.applyEventToCurrentStatus(trailer, event, { force: true });
    return { trailer, event };
  }

  test('dropoff persists possession=dropped, cargo=empty; display derived', async () => {
    const unit = `${base}A`;
    await insertPickupDropoff(unit, 'dropoff', 'dropped', 'empty', 1001);
    const state = await db.getUnifiedTrailerStateById((await db.getTrailerByUnitNumber(unit)).id);
    assert.equal(state.possession_status, 'dropped');
    assert.equal(state.cargo_status, 'empty');
    assert.equal(state.display_status, 'Dropped / Empty');
  });

  test('dropoff loaded persists possession=dropped, cargo=loaded', async () => {
    const unit = `${base}B`;
    await insertPickupDropoff(unit, 'dropoff', 'dropped', 'loaded', 1002);
    const state = await db.getUnifiedTrailerStateById((await db.getTrailerByUnitNumber(unit)).id);
    assert.equal(state.possession_status, 'dropped');
    assert.equal(state.cargo_status, 'loaded');
    assert.equal(state.display_status, 'Dropped / Loaded');
  });

  test('pickup persists with_driver / unknown cargo', async () => {
    const unit = `${base}C`;
    await insertPickupDropoff(unit, 'pickup', 'with_driver', 'unknown', 1003);
    const state = await db.getUnifiedTrailerStateById((await db.getTrailerByUnitNumber(unit)).id);
    assert.equal(state.possession_status, 'with_driver');
    assert.equal(state.cargo_status, 'unknown');
  });

  test('getUnifiedTrailerStates returns the cargo/possession columns', async () => {
    const rows = await db.getUnifiedTrailerStates({ limit: 5000 });
    const mine = rows.filter((r) => String(r.unit_number).startsWith(base));
    assert.ok(mine.length >= 3);
    for (const r of mine) {
      assert.ok(['with_driver', 'dropped', 'unknown'].includes(r.possession_status));
      assert.ok(['empty', 'loaded', 'unknown'].includes(r.cargo_status));
    }
  });

  test('recompute after decline resets possession/cargo/display to unknown', async () => {
    const unit = `${base}D`;
    const { trailer, event } = await insertPickupDropoff(unit, 'dropoff', 'dropped', 'loaded', 1004);
    await db.declineTrailerEvent(event.id, { reviewedBy: 'admin' });
    await db.recomputeTrailerCurrentStatus(trailer.id);
    const state = await db.getUnifiedTrailerStateById(trailer.id);
    assert.equal(state.possession_status, 'unknown');
    assert.equal(state.cargo_status, 'unknown');
  });

  test('teardown', async () => { await pool.end(); });
}
