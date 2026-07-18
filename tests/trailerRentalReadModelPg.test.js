/**
 * PostgreSQL integration — unified rental read model + Home aggregates.
 *
 * The redesigned UI reads ONE paginated list over agreements (legacy rentals
 * are mirrored in by the boot backfill). Proves: pagination envelope, tab
 * buckets, search, normalized shape with per-item evidence and next actions,
 * and the Home endpoint's attention/summary counts.
 *
 * Requires TEST_DATABASE_URL; SKIPs without it.
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
  ];
  const purge = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) purge(full);
      else if (entry.name.endsWith('.js')) delete require.cache[full];
    }
  };
  dirs.forEach(purge);
  for (const f of ['../services/trailerRentalReadModel.js', '../services/trailerHomeService.js',
    '../services/trailerNextAction.js', '../services/trailerPagination.js']) {
    delete require.cache[require.resolve(f)];
  }
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: (t, v) => harness.pool.query(t, v), ping: async () => true },
  };
  return {
    service: require('../services/trailerAgreements'),
    readModel: require('../services/trailerRentalReadModel'),
    home: require('../services/trailerHomeService'),
  };
}

async function seed(harness, units) {
  const admin = await harness.query("INSERT INTO admins (username, password_hash) VALUES ('mgr','x') RETURNING id");
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, contact_name, active) VALUES ('Acme','Acme','Pat',TRUE) RETURNING id",
  );
  const trailers = [];
  for (const u of units) {
    const r = await harness.query(
      `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
       VALUES ($1,'available',FALSE,TRUE,'active','admin_manual') RETURNING id`,
      [u],
    );
    trailers.push(r.rows[0].id);
  }
  return { adminId: admin.rows[0].id, companyId: company.rows[0].id, trailers };
}

const win = (startOffsetDays, days) => {
  const s = new Date(Date.now() + startOffsetDays * 86400000);
  return {
    scheduled_pickup_at: s.toISOString(),
    expected_return_at: new Date(s.getTime() + days * 86400000).toISOString(),
  };
};

test('unified list: pagination envelope, buckets, search and next actions', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { service, readModel } = loadStack(harness);
  const { adminId, companyId, trailers } = await seed(harness, ['RM-1', 'RM-2', 'RM-3']);

  // One upcoming rental, one overdue-active rental (needs attention).
  const upcoming = await service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(2, 5) }],
  }, { id: adminId });
  const overdue = await service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[1], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(-10, 5) }],
  }, { id: adminId });
  await service.activateItem(overdue.agreement.id, overdue.items[0].id, { id: adminId }, { requireInspection: false });

  const all = await readModel.listRentals({});
  assert.equal(all.total, 2);
  assert.equal(all.page, 1);
  assert.ok(Array.isArray(all.items));
  const row = all.items.find((r) => r.agreement_id === overdue.agreement.id);
  assert.equal(row.company.name, 'Acme');
  assert.equal(row.trailer_count, 1);
  assert.equal(row.trailers[0].unit_number, 'RM-2');
  assert.equal(row.next_action.type, 'return_trailer');
  assert.equal(row.next_action.urgent, true);

  const upRow = all.items.find((r) => r.agreement_id === upcoming.agreement.id);
  assert.equal(upRow.next_action.type, 'complete_pickup_inspection');

  // Buckets.
  const attention = await readModel.listRentals({ bucket: 'needs_attention' });
  assert.deepEqual(attention.items.map((r) => r.agreement_id), [overdue.agreement.id]);
  const pickups = await readModel.listRentals({ bucket: 'upcoming_pickups' });
  assert.deepEqual(pickups.items.map((r) => r.agreement_id), [upcoming.agreement.id]);
  const rented = await readModel.listRentals({ bucket: 'currently_rented' });
  assert.deepEqual(rented.items.map((r) => r.agreement_id), [overdue.agreement.id]);

  // Search by unit number and by company.
  const byUnit = await readModel.listRentals({ q: 'RM-2' });
  assert.equal(byUnit.total, 1);
  const byCompany = await readModel.listRentals({ q: 'acme' });
  assert.equal(byCompany.total, 2);

  // Page size honored.
  const paged = await readModel.listRentals({ page: 1, page_size: 1 });
  assert.equal(paged.items.length, 1);
  assert.equal(paged.total, 2);

  // Single-rental fetch matches the list shape.
  const one = await readModel.getRental(overdue.agreement.id);
  assert.equal(one.display_number, overdue.agreement.agreement_number);
  assert.equal(one.trailers.length, 1);
});

test('home aggregates: attention, today, summary and activity', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { service, home } = loadStack(harness);
  const { adminId, companyId, trailers } = await seed(harness, ['HM-1', 'HM-2']);

  const a = await service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(-7, 3) }],
  }, { id: adminId });
  await service.activateItem(a.agreement.id, a.items[0].id, { id: adminId }, { requireInspection: false });

  const data = await home.getTrailerHome();
  const overdueReturns = data.attention.find((r) => r.type === 'overdue_returns');
  assert.equal(overdueReturns.count, 1);
  assert.ok(overdueReturns.link.includes('/admin/trailers/rentals'));
  assert.equal(data.summary.rented, 1);
  assert.equal(data.summary.available, 1);
  assert.equal(data.summary.overdue_returns, 1);
  assert.ok(Array.isArray(data.activity));
  assert.ok(data.activity.some((row) => /confirmed a trailer pickup/.test(row.text)));
});
