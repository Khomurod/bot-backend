/**
 * PostgreSQL integration — the wizard's "One total price for all trailers"
 * choice, end to end (§1). The exact agreement/item shape the Price step sends
 * must create cleanly, and the combined invoice must bill the bundle amount
 * ONCE (never per item and never zero).
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
  const s = new Date(Date.UTC(2026, 6, 20 + offsetDays, 8));
  const e = new Date(s.getTime() + days * 86400000);
  return { scheduled_pickup_at: s.toISOString(), expected_return_at: e.toISOString() };
};

test('one-total-price agreement creates, activates, returns and bills the bundle once', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { service } = loadStack(harness);
  const admin = await harness.query("INSERT INTO admins (username, password_hash) VALUES ('mgr','x') RETURNING id");
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id");
  const trailers = [];
  for (const u of ['BP-1', 'BP-2', 'BP-3']) {
    const r = await harness.query(
      `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
       VALUES ($1,'available',FALSE,TRUE,'active','admin_manual') RETURNING id`, [u]);
    trailers.push(r.rows[0].id);
  }

  // The exact shape the wizard's Price step produces for "One total price".
  const { agreement, items } = await service.createAgreementWithItems({
    company_id: company.rows[0].id,
    pricing_mode: 'bundle_flat',
    original_agreed_amount: 9000,
    current_agreed_amount: 9000,
    deposit_amount: 1500,
    agreement_discount: 0,
    items: trailers.map((tid, i) => ({
      trailer_id: tid, item_status: 'scheduled',
      pricing_mode: 'included_in_bundle', included_in_bundle: true, ...win(0, 30),
    })),
  }, { id: admin.rows[0].id });
  assert.equal(agreement.pricing_mode, 'bundle_flat');
  assert.equal(Number(agreement.current_agreed_amount), 9000);
  assert.equal(items.length, 3);

  // The server-side estimate matches what invoicing will bill.
  const estimate = service.estimateAgreement({
    pricing_mode: 'bundle_flat', current_agreed_amount: 9000, deposit_amount: 1500,
    items: items.map((it) => ({ ...it, included_in_bundle: true })),
  });
  assert.equal(estimate.total, 9000);
  assert.equal(estimate.estimated_due, 7500);

  // Activate + return every trailer, then bill a combined invoice.
  for (const it of items) {
    await service.activateItem(agreement.id, it.id, { id: admin.rows[0].id }, { requireInspection: false });
  }
  for (const it of items) {
    await service.returnItem(agreement.id, it.id, {
      actual_return_at: win(0, 30).expected_return_at, trailer_status: 'available',
    }, { id: admin.rows[0].id }, { requireInspection: false });
  }
  const { invoice } = await service.generateCombinedInvoice(agreement.id, { id: admin.rows[0].id });
  // The bundle amount bills exactly once — not tripled, not zero.
  assert.equal(Number(invoice.total_amount), 9000 - 1500, 'bundle minus the deposit credit');
});
