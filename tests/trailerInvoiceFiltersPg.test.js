/**
 * PostgreSQL integration — invoice list filters + pagination (§4, §10). Proves
 * the company, due-date-range and outstanding-only filters narrow results and
 * that a paged request returns { items, page, page_size, total }. The
 * outstanding-only and count paths must agree (both queries self-contained).
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

function loadFinance(harness) {
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
  return require('../database/trailerFinance');
}

async function seedCompany(harness, name, unit, agr) {
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ($1,$1,TRUE) RETURNING id", [name]);
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, needs_review, active, master_status, master_source)
     VALUES ($1,'rented',FALSE,TRUE,'active','admin_manual') RETURNING id`, [unit]);
  const rental = await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate, billing_method)
     VALUES ($1,$2,$3,'active',NOW()-INTERVAL '3 days',NOW()+INTERVAL '5 days',100,'calendar_day') RETURNING id`,
    [agr, trailer.rows[0].id, company.rows[0].id]);
  return { company: company.rows[0].id, trailer: trailer.rows[0].id, rental: rental.rows[0].id };
}

async function seedInvoice(harness, ctx, { number, total, due, paid = 0, status = 'issued' }) {
  const inv = await harness.query(
    `INSERT INTO trailer_invoices
       (invoice_number, rental_id, trailer_id, company_id, billing_period_start, billing_period_end,
        billing_method, base_amount, total_amount, status, due_at)
     VALUES ($1,$2,$3,$4,NOW()-INTERVAL '5 days',NOW(),'calendar_day',$5,$5,$6,$7) RETURNING id`,
    [number, ctx.rental, ctx.trailer, ctx.company, total, status, due]);
  if (paid > 0) {
    await harness.query(
      `INSERT INTO trailer_payments (receipt_number, invoice_id, rental_id, trailer_id, company_id, amount, payment_at, payment_method, idempotency_key, verification_status, receipt_bypass_reason)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),'cash',$7,'recorded','test')`,
      [`RCPT-${number}`, inv.rows[0].id, ctx.rental, ctx.trailer, ctx.company, paid, `k-${number}`]);
  }
  return inv.rows[0].id;
}

async function seed(harness) {
  const acme = await seedCompany(harness, 'Acme', 'IF-ACME', 'RENT-IF-ACME');
  const globex = await seedCompany(harness, 'Globex', 'IF-GLOBEX', 'RENT-IF-GLOBEX');
  await seedInvoice(harness, acme, { number: 'INV-A1', total: 1000, due: '2026-06-01T00:00:00Z', paid: 1000, status: 'paid' });
  await seedInvoice(harness, acme, { number: 'INV-A2', total: 500, due: '2026-07-15T00:00:00Z', paid: 200 });
  await seedInvoice(harness, globex, { number: 'INV-G1', total: 800, due: '2026-08-20T00:00:00Z', paid: 0 });
  return { acme: acme.company, globex: globex.company };
}

test('paged invoice list returns the standard envelope with a correct total', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const finance = loadFinance(harness);
  await seed(harness);
  const res = await finance.listTrailerInvoices({ page: 1, page_size: 2 });
  assert.ok(Array.isArray(res.items));
  assert.equal(res.total, 3);
  assert.equal(res.page_size, 2);
  assert.equal(res.items.length, 2);
});

test('company filter narrows to that company', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const finance = loadFinance(harness);
  await seed(harness);
  const res = await finance.listTrailerInvoices({ page: 1, page_size: 25, company: 'Acme' });
  assert.equal(res.total, 2);
  assert.ok(res.items.every((r) => r.company_name === 'Acme'));
});

test('due-date range filter narrows by due_at', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const finance = loadFinance(harness);
  await seed(harness);
  const res = await finance.listTrailerInvoices({
    page: 1, page_size: 25, due_from: '2026-07-01T00:00:00Z', due_to: '2026-07-31T00:00:00Z',
  });
  assert.equal(res.total, 1);
  assert.equal(res.items[0].invoice_number, 'INV-A2');
});

test('outstanding-only excludes fully-paid invoices (list and count agree)', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const finance = loadFinance(harness);
  await seed(harness);
  const res = await finance.listTrailerInvoices({ page: 1, page_size: 25, outstanding_only: 'true' });
  // INV-A1 is fully paid → excluded; INV-A2 (partial) and INV-G1 (unpaid) remain.
  assert.equal(res.total, 2);
  const numbers = res.items.map((r) => r.invoice_number).sort();
  assert.deepEqual(numbers, ['INV-A2', 'INV-G1']);
});
