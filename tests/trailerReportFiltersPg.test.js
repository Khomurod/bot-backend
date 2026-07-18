/**
 * PostgreSQL integration — report filters are honored (§10). The route forwards
 * req.query to getTrailerReport, which applies date-range and company filters to
 * the reports that expose them, parameterized. Proves filters actually narrow
 * results and that an unfiltered call is unchanged.
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

function loadReports(harness) {
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
  return require('../database/trailerReports');
}

async function seedTwoCompaniesWithRentals(harness) {
  const t1 = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
     VALUES ('RF-1','rented',FALSE,TRUE,'active','admin_manual') RETURNING id`);
  const t2 = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
     VALUES ('RF-2','rented',FALSE,TRUE,'active','admin_manual') RETURNING id`);
  const acme = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id");
  const globex = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Globex','Globex',TRUE) RETURNING id");
  // Acme rental starts 40 days ago, Globex 5 days ago — both active.
  await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate, billing_method)
     VALUES ('RENT-RF-ACME',$1,$2,'active',NOW()-INTERVAL '40 days',NOW()+INTERVAL '10 days',100,'calendar_day')`,
    [t1.rows[0].id, acme.rows[0].id]);
  await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate, billing_method)
     VALUES ('RENT-RF-GLOBEX',$1,$2,'active',NOW()-INTERVAL '5 days',NOW()+INTERVAL '25 days',100,'calendar_day')`,
    [t2.rows[0].id, globex.rows[0].id]);
}

test('unfiltered active_rentals returns both rentals', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const reports = loadReports(harness);
  await seedTwoCompaniesWithRentals(harness);
  const rows = await reports.getTrailerReport('active_rentals');
  assert.equal(rows.length, 2);
});

test('company filter narrows active_rentals to one company', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const reports = loadReports(harness);
  await seedTwoCompaniesWithRentals(harness);
  const rows = await reports.getTrailerReport('active_rentals', { company: 'Acme' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, 'Acme');
});

test('date-range filter narrows active_rentals by start_at', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const reports = loadReports(harness);
  await seedTwoCompaniesWithRentals(harness);
  // Only rentals started within the last 10 days → just Globex.
  const start = new Date(Date.now() - 10 * 86400000).toISOString();
  const rows = await reports.getTrailerReport('active_rentals', { start });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, 'Globex');
});

test('an unknown report still 404s and filters do not change that', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const reports = loadReports(harness);
  await assert.rejects(() => reports.getTrailerReport('nope', { company: 'Acme' }), (e) => e.status === 404);
});
