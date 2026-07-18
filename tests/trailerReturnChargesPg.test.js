/**
 * PostgreSQL integration — return charges persist and reach the invoice
 * (blocker 3.3, backend half). The frontend now sums duplicate-type amounts;
 * this proves the server stores every charge type and both invoice modes bill
 * them, so nothing is lost between return and invoicing.
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
  return { service: require('../services/trailerAgreements') };
}

const win = (offsetDays, days) => {
  const s = new Date(Date.UTC(2026, 2, 1 + offsetDays, 8));
  const e = new Date(s.getTime() + days * 86400000);
  return { scheduled_pickup_at: s.toISOString(), expected_return_at: e.toISOString() };
};

async function seed(harness, service, units) {
  const admin = await harness.query("INSERT INTO admins (username, password_hash) VALUES ('mgr','x') RETURNING id");
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id",
  );
  const trailers = [];
  for (const u of units) {
    const r = await harness.query(
      `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
       VALUES ($1,'available',FALSE,TRUE,'active','admin_manual') RETURNING id`, [u],
    );
    trailers.push(r.rows[0].id);
  }
  const { agreement, items } = await service.createAgreementWithItems({
    company_id: company.rows[0].id,
    items: trailers.map((tid, i) => ({
      trailer_id: tid, item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(i * 20, 5),
    })),
  }, { id: admin.rows[0].id });
  for (const it of items) {
    await service.activateItem(agreement.id, it.id, { id: admin.rows[0].id }, { requireInspection: false });
  }
  return { adminId: admin.rows[0].id, agreement, items };
}

test('all return charge types persist and reach a combined invoice', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service } = loadStack(harness);
  const { adminId, agreement, items } = await seed(harness, service, ['RC-1', 'RC-2']);

  // Item 1 returns with damage + cleaning + late; item 2 with cleaning only.
  await service.returnItem(agreement.id, items[0].id, {
    actual_return_at: '2026-03-08T08:00:00Z', trailer_status: 'held_damage', new_damage: 'dent',
    damage_charge: 200, cleaning_charge: 150, late_fee: 30, description: 'dent + wash',
  }, { id: adminId }, { requireInspection: false });
  await service.returnItem(agreement.id, items[1].id, {
    actual_return_at: '2026-03-28T08:00:00Z', trailer_status: 'available',
    cleaning_charge: 75,
  }, { id: adminId }, { requireInspection: false });

  // Charges are persisted on each item.
  const c1 = await harness.query('SELECT return_charges FROM trailer_rental_items WHERE id=$1', [items[0].id]);
  assert.equal(Number(c1.rows[0].return_charges.damage_charge), 200);
  assert.equal(Number(c1.rows[0].return_charges.cleaning_charge), 150);
  assert.equal(Number(c1.rows[0].return_charges.late_fee), 30);

  const { invoice } = await service.generateCombinedInvoice(agreement.id, { id: adminId });
  const inv = await harness.query(
    'SELECT damage_charge, cleaning_charge, late_fee FROM trailer_invoices WHERE id=$1', [invoice.id],
  );
  // Combined invoice sums every charge across both items — none dropped.
  assert.equal(Number(inv.rows[0].damage_charge), 200);
  assert.equal(Number(inv.rows[0].cleaning_charge), 225); // 150 + 75
  assert.equal(Number(inv.rows[0].late_fee), 30);
});

test('a separate item invoice includes that item\'s charges', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service } = loadStack(harness);
  const { adminId, agreement, items } = await seed(harness, service, ['RC-3']);

  await service.returnItem(agreement.id, items[0].id, {
    actual_return_at: '2026-03-08T08:00:00Z', trailer_status: 'available',
    cleaning_charge: 120, other_charge: 45, description: 'wash + fee',
  }, { id: adminId }, { requireInspection: false });

  const { invoice } = await service.generateItemInvoice(agreement.id, items[0].id, { id: adminId });
  const inv = await harness.query(
    'SELECT cleaning_charge, other_charges FROM trailer_invoices WHERE id=$1', [invoice.id],
  );
  assert.equal(Number(inv.rows[0].cleaning_charge), 120);
  assert.equal(Number(inv.rows[0].other_charges), 45);
});
