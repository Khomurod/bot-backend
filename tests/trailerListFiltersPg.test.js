/**
 * PostgreSQL integration — server-side trailer list filters + pagination
 * envelope (§2, §10). Proves the new filters (rental state, company, missing
 * location, needs-attention) narrow results using BOTH rental systems, and that
 * paged responses return { items, page, page_size, total } with a correct count.
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

function loadAssets(harness) {
  const dbDir = path.resolve(__dirname, '../database');
  const purge = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) purge(full);
      else if (entry.name.endsWith('.js')) delete require.cache[full];
    }
  };
  purge(dbDir);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: (t, v) => harness.pool.query(t, v), ping: async () => true },
  };
  return require('../database/trailerAssets');
}

async function seed(harness) {
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id");
  // Available, no location.
  const t1 = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
     VALUES ('LF-AVAIL','available',FALSE,TRUE,'active','admin_manual') RETURNING id`);
  // Rented via legacy rental, needs review.
  const t2 = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
     VALUES ('LF-RENTED','rented',TRUE,TRUE,'active','admin_manual') RETURNING id`);
  await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate, billing_method)
     VALUES ('RENT-LF-1',$1,$2,'active',NOW()-INTERVAL '2 days',NOW()+INTERVAL '5 days',100,'calendar_day')`,
    [t2.rows[0].id, company.rows[0].id]);
  return { company: company.rows[0].id, t1: t1.rows[0].id, t2: t2.rows[0].id };
}

test('paged response returns the standard envelope with a correct total', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const assets = loadAssets(harness);
  await seed(harness);
  const res = await assets.listDepartmentTrailers({ page: 1, page_size: 1 });
  assert.ok(Array.isArray(res.items));
  assert.equal(res.page, 1);
  assert.equal(res.page_size, 1);
  assert.equal(res.total, 2, 'two official trailers seeded');
  assert.equal(res.items.length, 1, 'page size respected');
});

test('rental_state filter separates available from rented (both systems)', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const assets = loadAssets(harness);
  await seed(harness);
  const avail = await assets.listDepartmentTrailers({ page: 1, page_size: 25, rental_state: 'available' });
  assert.equal(avail.total, 1);
  assert.equal(avail.items[0].unit_number, 'LF-AVAIL');
  const rented = await assets.listDepartmentTrailers({ page: 1, page_size: 25, rental_state: 'rented' });
  assert.equal(rented.total, 1);
  assert.equal(rented.items[0].unit_number, 'LF-RENTED');
});

test('needs_attention, company and search filters narrow correctly', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const assets = loadAssets(harness);
  await seed(harness);
  const attn = await assets.listDepartmentTrailers({ page: 1, page_size: 25, needs_attention: 'true' });
  assert.equal(attn.total, 1);
  assert.equal(attn.items[0].unit_number, 'LF-RENTED');

  const byCompany = await assets.listDepartmentTrailers({ page: 1, page_size: 25, company: 'Acme' });
  assert.equal(byCompany.total, 1, 'only the trailer currently rented to Acme');

  const search = await assets.listDepartmentTrailers({ page: 1, page_size: 25, q: 'AVAIL' });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].unit_number, 'LF-AVAIL');
});

test('missing_location filter finds trailers with no known location', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const assets = loadAssets(harness);
  await seed(harness);
  const res = await assets.listDepartmentTrailers({ page: 1, page_size: 25, missing_location: 'true' });
  // Neither seeded trailer has a trailer_current_status location row → both missing.
  assert.equal(res.total, 2);
});
