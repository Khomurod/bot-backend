/**
 * PostgreSQL integration — multi-trailer rental agreements (Phase 4).
 *
 * Drives the real data layer + services against a throwaway database with the
 * complete schema.sql applied, proving: create-with-items, add/remove/replace
 * via amendment, availability overlap rejection, status derivation in the same
 * transaction as item changes, activation requiring a stored pickup photo,
 * independent per-trailer return, combined + separate invoicing, and the
 * legacy-rental backfill (idempotent, non-destructive).
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

/**
 * Bind the agreement data layer + services to the throwaway database by stubbing
 * database/pool. node's test runner isolates each file in its own process, so
 * the stub is safe for the whole file and uses the harness's pool (which the
 * harness's own t.after tears down).
 */
function loadAgreementStack(harness) {
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
    exports: {
      pool: harness.pool,
      query: (t, v) => harness.pool.query(t, v),
      ping: async () => true,
    },
  };
  return {
    agreementsDb: require('../database/trailerAgreements'),
    service: require('../services/trailerAgreements'),
  };
}

async function seedBasics(harness, units = ['A-1', 'A-2', 'A-3']) {
  const admin = await harness.query(
    "INSERT INTO admins (username, password_hash) VALUES ('mgr','x') RETURNING id",
  );
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id",
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

const win = (offsetDays, days) => {
  const s = new Date(Date.UTC(2026, 2, 1 + offsetDays, 8));
  const e = new Date(s.getTime() + days * 86400000);
  return { scheduled_pickup_at: s.toISOString(), expected_return_at: e.toISOString() };
};

test('create agreement with three items derives scheduled and rejects non-draft creation', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { service } = loadAgreementStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness);

  const { agreement, items } = await service.createAgreementWithItems({
    company_id: companyId,
    items: trailers.map((tid, i) => ({
      trailer_id: tid, item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(i * 20, 5),
    })),
  }, { id: adminId });

  assert.equal(items.length, 3);
  assert.equal(agreement.status, 'scheduled');

  await assert.rejects(
    () => service.createAgreementWithItems({ company_id: companyId, status: 'active', items: [] }, { id: adminId }),
    (e) => e.code === 'AGREEMENT_STATUS_NOT_ALLOWED',
  );
});

test('overlapping booking of the same trailer is rejected', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { service } = loadAgreementStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['X-1']);

  await service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(0, 10) }],
  }, { id: adminId });

  await assert.rejects(
    () => service.createAgreementWithItems({
      company_id: companyId,
      items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(3, 5) }],
    }, { id: adminId }),
    (e) => e.code === 'TRAILER_OVERLAP',
  );
});

test('partial pickup and independent return drive partially_active then partially_returned', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { service } = loadAgreementStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness);

  const { agreement, items } = await service.createAgreementWithItems({
    company_id: companyId,
    items: trailers.map((tid, i) => ({
      trailer_id: tid, item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(i * 20, 5),
    })),
  }, { id: adminId });

  // Activate the first two without an inspection (test-only bypass) — the third
  // stays scheduled.
  const a1 = await service.activateItem(agreement.id, items[0].id, { id: adminId }, { requireInspection: false });
  assert.equal(a1.agreement.status, 'partially_active');
  const a2 = await service.activateItem(agreement.id, items[1].id, { id: adminId }, { requireInspection: false });
  assert.equal(a2.agreement.status, 'partially_active');

  // Return the first — others stay active → partially_returned. The return
  // inspection is bypassed here (test-only) like the pickup above; the evidence
  // requirement has its own dedicated tests.
  const r1 = await service.returnItem(agreement.id, items[0].id, { actual_return_at: new Date().toISOString() }, { id: adminId }, { requireInspection: false });
  assert.equal(r1.item.item_status, 'returned');
  assert.equal(r1.agreement.status, 'partially_returned');
  assert.ok(Number(r1.invoiceLine.line_total) >= 0);
});

test('activation requires a completed pickup inspection with stored photo bytes', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { service } = loadAgreementStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['P-1']);

  const { agreement, items } = await service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(0, 5) }],
  }, { id: adminId });
  const item = items[0];

  // No inspection yet → rejected, and the item stays scheduled (transactional).
  await assert.rejects(
    () => service.activateItem(agreement.id, item.id, { id: adminId }),
    (e) => e.code === 'PICKUP_INSPECTION_INCOMPLETE',
  );
  const still = await harness.query('SELECT item_status FROM trailer_rental_items WHERE id=$1', [item.id]);
  assert.equal(still.rows[0].item_status, 'scheduled');

  // Add a completed pickup inspection + a photo with real bytes, then activate.
  const ins = await harness.query(
    `INSERT INTO trailer_inspections (rental_item_id, trailer_id, inspection_type, completed, inspected_at)
     VALUES ($1,$2,'pickup',TRUE,NOW()) RETURNING id`, [item.id, trailers[0]],
  );
  const blob = await harness.query(
    `INSERT INTO trailer_media_blobs (mime_type, original_filename, byte_size, checksum_sha256, file_data)
     VALUES ('image/webp','p.webp',3,'abc',decode('001122','hex')) RETURNING id`,
  );
  await harness.query(
    `INSERT INTO trailer_media (media_type, trailer_id, rental_item_id, inspection_id, storage_backend, blob_id,
       original_filename, mime_type, original_size_bytes, checksum_sha256)
     VALUES ('pickup_condition_photo',$1,$2,$3,'database',$4,'p.webp','image/webp',3,'abc')`,
    [trailers[0], item.id, ins.rows[0].id, blob.rows[0].id],
  );
  const ok = await service.activateItem(agreement.id, item.id, { id: adminId });
  assert.equal(ok.item.item_status, 'active');
  assert.equal(ok.agreement.status, 'active');
});

test('add / remove / replace via amendments, immutably recorded', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { service, agreementsDb } = loadAgreementStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['M-1', 'M-2', 'M-3', 'M-4']);

  const { agreement, items } = await service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(0, 5) }],
  }, { id: adminId });

  const added = await service.addItemViaAmendment(agreement.id,
    { trailer_id: trailers[1], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(20, 5) },
    { id: adminId }, 'add second trailer');
  assert.equal(added.amendment.amendment_type, 'add_trailer');

  const removed = await service.removeItemViaAmendment(agreement.id, items[0].id, { id: adminId }, 'not needed');
  assert.equal(removed.item.item_status, 'removed_before_pickup');
  assert.equal(removed.amendment.amendment_type, 'remove_trailer');

  const replaced = await service.replaceItemViaAmendment(agreement.id, added.item.id,
    { trailer_id: trailers[2], ...win(20, 5) }, { id: adminId }, 'swap');
  assert.equal(replaced.replacedItem.item_status, 'replaced');
  assert.equal(replaced.replacementItem.item_status, 'scheduled');

  const amendments = await agreementsDb.listAmendments(agreement.id);
  assert.equal(amendments.length, 3, 'three amendments recorded, append-only');
  assert.deepEqual(amendments.map((a) => a.amendment_number), [1, 2, 3]);
});

test('combined and separate invoices produce correct line totals', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { service } = loadAgreementStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['I-1', 'I-2']);

  const { agreement, items } = await service.createAgreementWithItems({
    company_id: companyId,
    items: trailers.map((tid, i) => ({
      trailer_id: tid, item_status: 'scheduled', pricing_mode: 'flat', flat_amount: 300, ...win(i * 20, 5),
    })),
  }, { id: adminId });
  for (const it of items) await service.activateItem(agreement.id, it.id, { id: adminId }, { requireInspection: false });

  const combined = await service.generateCombinedInvoice(agreement.id, { id: adminId });
  assert.equal(Number(combined.invoice.total_amount), 600);
  assert.equal(combined.lineCount, 2);
  const lines = await harness.query('SELECT COUNT(*)::int c FROM trailer_invoice_lines WHERE invoice_id=$1', [combined.invoice.id]);
  assert.equal(lines.rows[0].c, 2);

  const separate = await service.generateItemInvoice(agreement.id, items[0].id, { id: adminId });
  assert.equal(Number(separate.invoice.total_amount), 300);
});

test('legacy single-trailer rentals backfill into agreements+items, idempotently', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { agreementsDb } = loadAgreementStack(harness);
  const { companyId, trailers } = await seedBasics(harness, ['L-1', 'L-2']);

  // Two legacy rentals created directly (as production has them).
  for (let i = 0; i < 2; i += 1) {
    await harness.query(
      `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at,
         expected_return_at, daily_rate, pickup_location, billing_method)
       VALUES ($1,$2,$3,'active','2026-03-01T08:00:00Z','2026-03-10T08:00:00Z',150,'Yard','calendar_day')`,
      [`RENT-2026-00010${i}`, trailers[i], companyId],
    );
  }

  // These legacy rentals were inserted AFTER schema.sql applied, so run the
  // (idempotent) backfill now — exactly as a boot would after new legacy data.
  await agreementsDb.runBackfill(harness.pool);
  let report = await agreementsDb.verifyBackfill(harness.pool);
  assert.equal(report.complete, true);
  assert.equal(report.duplicateAgreements.length, 0);

  const before = await harness.query('SELECT COUNT(*)::int c FROM trailer_rental_agreements');
  // Re-run the backfill explicitly — must be a strict no-op (no duplicates).
  await agreementsDb.runBackfill(harness.pool);
  const after = await harness.query('SELECT COUNT(*)::int c FROM trailer_rental_agreements');
  assert.equal(after.rows[0].c, before.rows[0].c, 'rerun creates no duplicate agreements');

  report = await agreementsDb.verifyBackfill(harness.pool);
  assert.equal(report.complete, true);
  assert.equal(report.duplicateItems.length, 0);

  // Historical linkage preserved: each legacy rental maps to exactly one item.
  const link = await harness.query(
    `SELECT r.id rid, it.id iid FROM trailer_rentals r
       JOIN trailer_rental_items it ON it.legacy_rental_id = r.id`,
  );
  assert.equal(link.rows.length, 2);
});
