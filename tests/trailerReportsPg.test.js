/**
 * PostgreSQL integration — reporting (Phase 6).
 *
 * Proves Current Occupancy (point-in-time) and Period Utilization (time-weighted
 * over the window) compute, and that every named report query is valid SQL
 * against the real schema (including the new agreement/credit/mention reports).
 *
 * Requires TEST_DATABASE_URL; SKIPs without it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const NAMED = [
  'active_rentals', 'overdue_returns', 'missing_inspections', 'missing_receipts',
  'partial_payments', 'aging', 'company_credits', 'overpayments', 'amendments',
  'unmatched_mentions', 'pending_master_review', 'archived_trailers',
  'active_agreements', 'missing_pickup_photos',
  'upcoming_pickups', 'missing_return_inspections', 'missing_return_photos',
  'damage_holds', 'failed_notifications', 'missing_trailer_locations', 'storage_usage',
];

test('dashboard returns current occupancy and period utilization', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerReports } = harness.loadDataLayer(['trailerReports']);

  // One official trailer, rented for the whole current month.
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, active, master_status, master_source)
     VALUES ('RP-1','rented',TRUE,'active','admin_manual') RETURNING id`,
  );
  // The trailer existed before the reporting window (created "now" in a test).
  await harness.query("UPDATE trailers SET created_at = NOW() - INTERVAL '60 days' WHERE id=$1", [trailer.rows[0].id]);
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id",
  );
  await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at,
       daily_rate, pickup_location, billing_method)
     VALUES ('RENT-RP-1',$1,$2,'active',NOW()-INTERVAL '10 days',NOW()+INTERVAL '10 days',100,'Yard','calendar_day')`,
    [trailer.rows[0].id, company.rows[0].id],
  );

  const dash = await trailerReports.getTrailerDashboard({
    start: new Date(Date.now() - 20 * 86400000).toISOString(),
    end: new Date().toISOString(),
  });
  assert.equal(typeof dash.current_occupancy, 'number');
  assert.equal(dash.current_occupancy, 100, 'the only official trailer is rented → 100% occupancy');
  assert.ok(dash.period_utilization > 0, 'the trailer was rented across the window');
  assert.ok(dash.period_utilization <= 100);
});

test('every named report is valid SQL against the real schema', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerReports } = harness.loadDataLayer(['trailerReports']);
  for (const name of NAMED) {
    const rows = await trailerReports.getTrailerReport(name);
    assert.ok(Array.isArray(rows), `${name} returns rows`);
  }
  await assert.rejects(() => trailerReports.getTrailerReport('nope'), (e) => e.status === 404);
});
