/**
 * PostgreSQL integration — cross-system trailer status protection (blocker 3.5).
 *
 * Making a trailer Available or archiving it must be refused while it is out on
 * an active rental in EITHER the legacy trailer_rentals OR the new
 * trailer_rental_items. Historically only the legacy table was checked, so an
 * agreement-held trailer could be wrongly freed.
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
    exports: { pool: harness.pool, query: (t, v) => harness.pool.query(t, v), ping: async () => true },
  };
  return {
    service: require('../services/trailerAgreements'),
    trailerAssets: require('../database/trailerAssets'),
  };
}

const win = (offsetDays, days) => {
  const s = new Date(Date.UTC(2026, 2, 1 + offsetDays, 8));
  const e = new Date(s.getTime() + days * 86400000);
  return { scheduled_pickup_at: s.toISOString(), expected_return_at: e.toISOString() };
};

async function base(harness) {
  const admin = await harness.query("INSERT INTO admins (username, password_hash) VALUES ('mgr','x') RETURNING id");
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id",
  );
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source, version)
     VALUES ('SG-1','rented',FALSE,TRUE,'active','admin_manual',1) RETURNING *`,
  );
  return { adminId: admin.rows[0].id, companyId: company.rows[0].id, trailer: trailer.rows[0] };
}

test('an active AGREEMENT item blocks making the trailer available and archiving it', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service, trailerAssets } = loadStack(harness);
  const { adminId, companyId, trailer } = await base(harness);

  const { agreement, items } = await service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailer.id, item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(0, 5) }],
  }, { id: adminId });
  await service.activateItem(agreement.id, items[0].id, { id: adminId }, { requireInspection: false });

  const actor = { id: adminId, role_keys: [] };
  await assert.rejects(
    () => trailerAssets.updateDepartmentTrailer(trailer.id, { physical_status: 'available' }, actor),
    (e) => e.code === 'TRAILER_IN_USE' && e.status === 409 && /still out on an active rental/i.test(e.message),
  );
  await assert.rejects(
    () => trailerAssets.updateDepartmentTrailer(trailer.id, { active: false }, actor),
    (e) => e.code === 'TRAILER_IN_USE' && /archived/i.test(e.message),
  );
  // Nothing changed.
  const row = await harness.query('SELECT physical_status, active FROM trailers WHERE id=$1', [trailer.id]);
  assert.equal(row.rows[0].physical_status, 'rented');
  assert.equal(row.rows[0].active, true);
});

test('an active LEGACY rental still blocks making the trailer available', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerAssets } = loadStack(harness);
  const { adminId, companyId, trailer } = await base(harness);

  await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate, billing_method)
     VALUES ('RENT-2026-000900',$1,$2,'active','2026-02-01T08:00:00Z','2026-02-10T08:00:00Z',150,'calendar_day')`,
    [trailer.id, companyId],
  );
  await assert.rejects(
    () => trailerAssets.updateDepartmentTrailer(trailer.id, { physical_status: 'available' }, { id: adminId, role_keys: [] }),
    (e) => e.code === 'TRAILER_IN_USE',
  );
});

test('once the agreement item is returned, the trailer can be made available', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service, trailerAssets } = loadStack(harness);
  const { adminId, companyId, trailer } = await base(harness);

  const { agreement, items } = await service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailer.id, item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(0, 5) }],
  }, { id: adminId });
  await service.activateItem(agreement.id, items[0].id, { id: adminId }, { requireInspection: false });
  await service.returnItem(agreement.id, items[0].id, {
    actual_return_at: '2026-03-06T08:00:00Z', trailer_status: 'under_inspection',
  }, { id: adminId }, { requireInspection: false });

  const fresh = await harness.query('SELECT version FROM trailers WHERE id=$1', [trailer.id]);
  const updated = await trailerAssets.updateDepartmentTrailer(
    trailer.id, { physical_status: 'available', version: fresh.rows[0].version }, { id: adminId, role_keys: [] },
  );
  assert.equal(updated.physical_status, 'available');
});
