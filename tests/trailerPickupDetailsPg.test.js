/**
 * PostgreSQL integration — actual pickup details are persisted at activation
 * (task blocker 3.1). Historically activateItem billed from the scheduled plan
 * and silently dropped whatever the employee entered at "Confirm pickup". These
 * tests prove the real values now flow into the item, the movement, and the
 * read model, that coordinates are validated, and that a rejected activation
 * writes nothing.
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

/** Bind the real service + read model to the throwaway database. */
function loadStack(harness) {
  const dirs = [
    path.resolve(__dirname, '../database'),
    path.resolve(__dirname, '../services/trailerAgreements'),
    path.resolve(__dirname, '../services/trailerPricing'),
    path.resolve(__dirname, '../services'),
  ];
  const purge = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) purge(full);
      else if (entry.name.endsWith('.js')) delete require.cache[full];
    }
  };
  dirs.forEach(purge);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: {
      pool: harness.pool,
      query: (t, v) => harness.pool.query(t, v),
      ping: async () => true,
    },
  };
  return {
    service: require('../services/trailerAgreements'),
    readModel: require('../services/trailerRentalReadModel'),
  };
}

async function seedBasics(harness, unit = 'PK-1') {
  const admin = await harness.query(
    "INSERT INTO admins (username, password_hash) VALUES ('mgr','x') RETURNING id",
  );
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id",
  );
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
     VALUES ($1,'available',FALSE,TRUE,'active','admin_manual') RETURNING id`,
    [unit],
  );
  return { adminId: admin.rows[0].id, companyId: company.rows[0].id, trailerId: trailer.rows[0].id };
}

const win = (offsetDays, days) => {
  const s = new Date(Date.UTC(2026, 2, 1 + offsetDays, 8));
  const e = new Date(s.getTime() + days * 86400000);
  return { scheduled_pickup_at: s.toISOString(), expected_return_at: e.toISOString() };
};

/** Agreement + one scheduled item + completed pickup inspection with real photo bytes. */
async function seedActivatableItem(harness, service, { adminId, companyId, trailerId }) {
  const { agreement, items } = await service.createAgreementWithItems({
    company_id: companyId,
    items: [{
      trailer_id: trailerId, item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100,
      pickup_location: 'Planned Yard', ...win(0, 5),
    }],
  }, { id: adminId });
  const item = items[0];
  const ins = await harness.query(
    `INSERT INTO trailer_inspections (rental_item_id, trailer_id, inspection_type, completed, inspected_at)
     VALUES ($1,$2,'pickup',TRUE,NOW()) RETURNING id`, [item.id, trailerId],
  );
  const blob = await harness.query(
    `INSERT INTO trailer_media_blobs (mime_type, original_filename, byte_size, checksum_sha256, file_data)
     VALUES ('image/webp','p.webp',3,'abc',decode('001122','hex')) RETURNING id`,
  );
  await harness.query(
    `INSERT INTO trailer_media (media_type, trailer_id, rental_item_id, inspection_id, storage_backend, blob_id,
       original_filename, mime_type, original_size_bytes, checksum_sha256)
     VALUES ('pickup_condition_photo',$1,$2,$3,'database',$4,'p.webp','image/webp',3,'abc')`,
    [trailerId, item.id, ins.rows[0].id, blob.rows[0].id],
  );
  return { agreement, item };
}

test('actual pickup time overrides the planned time and is stored', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service } = loadStack(harness);
  const basics = await seedBasics(harness);
  const { agreement, item } = await seedActivatableItem(harness, service, basics);

  const actualAt = '2026-03-01T13:45:00.000Z';
  const ok = await service.activateItem(agreement.id, item.id, { id: basics.adminId }, {
    pickup: { actual_pickup_at: actualAt, pickup_location: 'Chicago Yard', pickup_lat: '41.85', pickup_lng: '-87.65' },
  });
  assert.equal(ok.item.item_status, 'active');

  const row = await harness.query(
    `SELECT scheduled_pickup_at, actual_pickup_at, pickup_location, actual_pickup_location,
            actual_pickup_lat, actual_pickup_lng FROM trailer_rental_items WHERE id=$1`, [item.id],
  );
  const r = row.rows[0];
  // Scheduled preserved separately from actual.
  assert.equal(new Date(r.scheduled_pickup_at).toISOString(), win(0, 5).scheduled_pickup_at);
  assert.equal(new Date(r.actual_pickup_at).toISOString(), actualAt);
  assert.notEqual(new Date(r.actual_pickup_at).getTime(), new Date(r.scheduled_pickup_at).getTime());
  // Actual location + coordinates stored, planned location untouched.
  assert.equal(r.pickup_location, 'Planned Yard');
  assert.equal(r.actual_pickup_location, 'Chicago Yard');
  assert.equal(Number(r.actual_pickup_lat), 41.85);
  assert.equal(Number(r.actual_pickup_lng), -87.65);
});

test('the pickup movement records the ACTUAL location, coordinates and time', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service } = loadStack(harness);
  const basics = await seedBasics(harness);
  const { agreement, item } = await seedActivatableItem(harness, service, basics);

  await service.activateItem(agreement.id, item.id, { id: basics.adminId }, {
    pickup: { actual_pickup_at: '2026-03-02T09:00:00Z', pickup_location: 'Detroit Yard', pickup_lat: '42.33', pickup_lng: '-83.05' },
  });
  const mv = await harness.query(
    `SELECT to_location, to_lat, to_lng, event_at FROM trailer_rental_movements
      WHERE rental_item_id=$1 AND movement_type='rental_pickup'`, [item.id],
  );
  assert.equal(mv.rows[0].to_location, 'Detroit Yard');
  assert.equal(Number(mv.rows[0].to_lat), 42.33);
  assert.equal(Number(mv.rows[0].to_lng), -83.05);
  assert.equal(new Date(mv.rows[0].event_at).toISOString(), '2026-03-02T09:00:00.000Z');
});

test('missing optional coordinates activate fine and keep the planned location', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service } = loadStack(harness);
  const basics = await seedBasics(harness);
  const { agreement, item } = await seedActivatableItem(harness, service, basics);

  const ok = await service.activateItem(agreement.id, item.id, { id: basics.adminId }, { pickup: {} });
  assert.equal(ok.item.item_status, 'active');
  const row = await harness.query(
    'SELECT actual_pickup_at, actual_pickup_location, actual_pickup_lat, actual_pickup_lng FROM trailer_rental_items WHERE id=$1',
    [item.id],
  );
  // With nothing supplied, actual time falls back to the scheduled time and the
  // location falls back to the planned one — never blanked.
  assert.equal(new Date(row.rows[0].actual_pickup_at).toISOString(), win(0, 5).scheduled_pickup_at);
  assert.equal(row.rows[0].actual_pickup_location, 'Planned Yard');
  assert.equal(row.rows[0].actual_pickup_lat, null);
});

test('invalid coordinates are rejected (422) and nothing is saved', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service } = loadStack(harness);
  const basics = await seedBasics(harness);
  const { agreement, item } = await seedActivatableItem(harness, service, basics);

  await assert.rejects(
    () => service.activateItem(agreement.id, item.id, { id: basics.adminId }, {
      pickup: { pickup_lat: '120', pickup_lng: '-87.65' },
    }),
    (e) => e.code === 'INVALID_COORDINATES' && e.status === 422,
  );
  // Only-one-coordinate is also rejected.
  await assert.rejects(
    () => service.activateItem(agreement.id, item.id, { id: basics.adminId }, {
      pickup: { pickup_lat: '41.85' },
    }),
    (e) => e.code === 'INVALID_COORDINATES',
  );
  // The item never left the scheduled state — the reject happens before any write.
  const still = await harness.query('SELECT item_status, actual_pickup_location FROM trailer_rental_items WHERE id=$1', [item.id]);
  assert.equal(still.rows[0].item_status, 'scheduled');
  assert.equal(still.rows[0].actual_pickup_location, null);
});

test('a stale version returns 409 and does not activate', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service } = loadStack(harness);
  const basics = await seedBasics(harness);
  const { agreement, item } = await seedActivatableItem(harness, service, basics);

  await assert.rejects(
    () => service.activateItem(agreement.id, item.id, { id: basics.adminId }, {
      version: Number(item.version) + 5,
      pickup: { pickup_location: 'Somewhere' },
    }),
    (e) => e.code === 'VERSION_CONFLICT' && e.status === 409,
  );
  const still = await harness.query('SELECT item_status FROM trailer_rental_items WHERE id=$1', [item.id]);
  assert.equal(still.rows[0].item_status, 'scheduled');
});

test('a failed activation (missing photo) saves no pickup details', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service } = loadStack(harness);
  const basics = await seedBasics(harness, 'PK-NOPHOTO');
  // Activatable window + completed inspection but NO photo bytes.
  const { agreement, items } = await service.createAgreementWithItems({
    company_id: basics.companyId,
    items: [{ trailer_id: basics.trailerId, item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100,
      pickup_location: 'Planned Yard', ...win(0, 5) }],
  }, { id: basics.adminId });
  const item = items[0];
  await harness.query(
    `INSERT INTO trailer_inspections (rental_item_id, trailer_id, inspection_type, completed, inspected_at)
     VALUES ($1,$2,'pickup',TRUE,NOW())`, [item.id, basics.trailerId],
  );

  await assert.rejects(
    () => service.activateItem(agreement.id, item.id, { id: basics.adminId }, {
      pickup: { actual_pickup_at: '2026-03-05T10:00:00Z', pickup_location: 'Should Not Persist' },
    }),
    (e) => e.code === 'PICKUP_INSPECTION_INCOMPLETE',
  );
  const row = await harness.query(
    'SELECT item_status, actual_pickup_at, actual_pickup_location FROM trailer_rental_items WHERE id=$1', [item.id],
  );
  assert.equal(row.rows[0].item_status, 'scheduled');
  assert.equal(row.rows[0].actual_pickup_at, null);
  assert.equal(row.rows[0].actual_pickup_location, null);
  const mv = await harness.query('SELECT COUNT(*)::int AS n FROM trailer_rental_movements WHERE rental_item_id=$1', [item.id]);
  assert.equal(mv.rows[0].n, 0);
});
