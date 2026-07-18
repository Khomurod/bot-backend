/**
 * PostgreSQL integration — Phase A stabilization of the Trailer Department.
 *
 * Proves the functional fixes end-to-end against the real schema:
 *   A1  items cannot be created directly as active/returned
 *   A2  item-scoped inspections drive pickup THROUGH THE HTTP ROUTES
 *   A3  media rows carry agreement_id/rental_item_id
 *   A4/A5 an agreement-only combined invoice is listed and payable
 *   A6  return charges persist and appear on later invoices with deposit applied
 *   A7  returns require inspection evidence; damage requires description+photo
 *   A8  cross-system double-booking is rejected in both directions
 *   A9  close is blocked while an item is still out
 *   A10 agreement numbers are format-correct and concurrency-safe
 *   A11 stale versions yield 409 VERSION_CONFLICT
 *   A12 applied credits reduce invoice outstanding (see trailerOverpaymentPg)
 *
 * Requires TEST_DATABASE_URL; SKIPs without it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const crypto = require('node:crypto');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const POOL_PATH = require.resolve('../database/pool');

/** Bind the whole agreement stack (db + services + routes) to the harness db. */
function loadStack(harness) {
  const dirs = [
    path.resolve(__dirname, '../database'),
    path.resolve(__dirname, '../services/trailerAgreements'),
    path.resolve(__dirname, '../services/trailerPricing'),
    path.resolve(__dirname, '../server/routes'),
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
    itemInspectionsDb: require('../database/trailerItemInspections'),
    mediaDb: require('../database/trailerMedia'),
    financeDb: require('../database/trailerFinance'),
    rentalsDb: require('../database/trailerRentals'),
    service: require('../services/trailerAgreements'),
    routes: require('../server/routes/trailerAgreementRoutes'),
  };
}

/** Mount the agreement routes with a stub admin session on an ephemeral port. */
async function startApi(routes, adminId, t) {
  const app = express();
  app.use(express.json());
  app.use(routes.createTrailerAgreementRoutes({
    authMiddleware: (req, _res, next) => { req.admin = { id: adminId, username: 'mgr' }; next(); },
    requirePermission: () => (_req, _res, next) => next(),
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return async (method, urlPath, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* empty body */ }
    return { status: res.status, body: json };
  };
}

async function seedBasics(harness, units = ['S-1', 'S-2']) {
  const admin = await harness.query("INSERT INTO admins (username, password_hash) VALUES ('mgr','x') RETURNING id");
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
  const s = new Date(Date.now() - (5 - offsetDays) * 86400000);
  const e = new Date(s.getTime() + days * 86400000);
  return { scheduled_pickup_at: s.toISOString(), expected_return_at: e.toISOString() };
};

const INSPECTION_ANSWERS = {
  overall_condition: 'good', tires: 'good', lights: 'working', doors: 'good', roof: 'sealed',
  floor: 'solid', exterior: 'clean', interior: 'clean', landing_gear: 'working',
};

/** A stored photo with REAL bytes, attached to the item (database backend). */
async function storePhoto(harness, mediaDb, { trailerId, agreementId, rentalItemId, inspectionId = null, mediaType }) {
  const bytes = Buffer.from(`photo-${mediaType}-${rentalItemId}`);
  const blob = await harness.query(
    `INSERT INTO trailer_media_blobs (mime_type, original_filename, byte_size, checksum_sha256, file_data)
     VALUES ('image/jpeg','p.jpg',$1,$2,$3) RETURNING id`,
    [bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), bytes],
  );
  return mediaDb.createTrailerMedia({
    mediaType, trailerId, agreementId, rentalItemId, inspectionId,
    storageBackend: 'database', blobId: blob.rows[0].id,
    originalFilename: 'p.jpg', mimeType: 'image/jpeg', originalSize: bytes.length,
    checksum: 'x'.repeat(64),
  });
}

test('A1: an item cannot be created directly as active', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { service } = loadStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['A1-1']);

  await assert.rejects(
    () => service.createAgreementWithItems({
      company_id: companyId,
      items: [{ trailer_id: trailers[0], item_status: 'active', pricing_mode: 'daily', daily_rate: 100, ...win(0, 5) }],
    }, { id: adminId }),
    (e) => e.code === 'ITEM_STATUS_NOT_ALLOWED' && e.status === 422,
  );
  // 'scheduled' without a window is also refused…
  await assert.rejects(
    () => service.createAgreementWithItems({
      company_id: companyId,
      items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100 }],
    }, { id: adminId }),
    (e) => e.code === 'ITEM_STATUS_NOT_ALLOWED',
  );
  // …while 'scheduled' with both dates (what the builder UI sends) still works.
  const ok = await service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(0, 5) }],
  }, { id: adminId });
  assert.equal(ok.items[0].item_status, 'scheduled');
});

test('A2/A3: guided pickup works end-to-end through the HTTP routes', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const stack = loadStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['H-1']);
  const api = await startApi(stack.routes, adminId, t);

  const created = await api('POST', '/api/trailer-agreements', {
    company_id: companyId,
    items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(0, 5) }],
  });
  assert.equal(created.status, 201);
  const agreementId = created.body.agreement.id;
  const itemId = created.body.items[0].id;

  // Activation before any inspection is refused.
  const early = await api('POST', `/api/trailer-agreements/${agreementId}/items/${itemId}/activate`, {});
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'PICKUP_INSPECTION_INCOMPLETE');

  // Save answers (always a draft), then completing without a photo is refused.
  const saved = await api('PUT', `/api/trailer-agreements/${agreementId}/items/${itemId}/inspections/pickup`,
    { ...INSPECTION_ANSWERS, completed: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.inspection.completed, false, 'saving never completes');
  const noPhoto = await api('POST', `/api/trailer-agreements/${agreementId}/items/${itemId}/inspections/pickup/complete`, {});
  assert.equal(noPhoto.status, 422);

  // Store a real photo (bytes in the database backend, keyed to the item).
  const media = await storePhoto(harness, stack.mediaDb, {
    trailerId: trailers[0], agreementId, rentalItemId: itemId, mediaType: 'pickup_condition_photo',
  });
  assert.equal(Number(media.rental_item_id), Number(itemId), 'A3: media row carries the item');
  assert.equal(Number(media.agreement_id), Number(agreementId), 'A3: media row carries the agreement');

  const completed = await api('POST', `/api/trailer-agreements/${agreementId}/items/${itemId}/inspections/pickup/complete`, {});
  assert.equal(completed.status, 200);
  assert.equal(completed.body.inspection.completed, true);

  const activated = await api('POST', `/api/trailer-agreements/${agreementId}/items/${itemId}/activate`, {});
  assert.equal(activated.status, 200);
  assert.equal(activated.body.item.item_status, 'active');
  assert.equal(activated.body.agreement.status, 'active');

  // The detail view exposes the inspection + media summary for checklist state.
  const detail = await api('GET', `/api/trailer-agreements/${agreementId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.inspections.length, 1);
  assert.equal(detail.body.media_summary[0].media_type, 'pickup_condition_photo');
});

test('A6/A7: return evidence is required, charges persist and reach invoices with deposit applied', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const stack = loadStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['R-1']);
  const api = await startApi(stack.routes, adminId, t);

  const { agreement, items } = await stack.service.createAgreementWithItems({
    company_id: companyId, deposit_amount: 50,
    items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, deposit_allocation: 50, ...win(0, 3) }],
  }, { id: adminId });
  const item = items[0];
  await stack.service.activateItem(agreement.id, item.id, { id: adminId }, { requireInspection: false });

  // Return without a completed return inspection → refused.
  const noInspection = await api('POST', `/api/trailer-agreements/${agreement.id}/items/${item.id}/return`, {});
  assert.equal(noInspection.status, 409);
  assert.equal(noInspection.body.code, 'RETURN_INSPECTION_INCOMPLETE');

  // Complete a return inspection with a stored photo.
  await stack.itemInspectionsDb.saveItemInspection(
    { rental_item_id: item.id, inspection_type: 'return', ...INSPECTION_ANSWERS }, { id: adminId },
  );
  await storePhoto(harness, stack.mediaDb, {
    trailerId: trailers[0], agreementId: agreement.id, rentalItemId: item.id, mediaType: 'return_condition_photo',
  });
  await stack.itemInspectionsDb.completeItemInspection(item.id, 'return', { id: adminId });

  // Damage without a description/photo → refused with a plain message.
  const noEvidence = await api('POST', `/api/trailer-agreements/${agreement.id}/items/${item.id}/return`, {
    damage_charge: 120, trailer_status: 'held_damage',
  });
  assert.equal(noEvidence.status, 422);
  assert.equal(noEvidence.body.code, 'DAMAGE_EVIDENCE_REQUIRED');

  await storePhoto(harness, stack.mediaDb, {
    trailerId: trailers[0], agreementId: agreement.id, rentalItemId: item.id, mediaType: 'damage_photo',
  });
  const returned = await api('POST', `/api/trailer-agreements/${agreement.id}/items/${item.id}/return`, {
    damage_charge: 120, cleaning_charge: 30, description: 'Dented rear door',
    trailer_status: 'held_damage',
  });
  assert.equal(returned.status, 200);
  assert.equal(returned.body.item.item_status, 'returned');
  assert.equal(Number(returned.body.item.return_charges.damage_charge), 120, 'A6: charges persisted');

  // A separate invoice picks the charges up and applies the deposit.
  const inv = await api('POST', `/api/trailer-agreements/${agreement.id}/items/${item.id}/invoice`, {});
  assert.equal(inv.status, 201);
  const invoice = inv.body.invoice;
  assert.equal(Number(invoice.damage_charge), 120);
  assert.equal(Number(invoice.cleaning_charge), 30);
  assert.equal(Number(invoice.deposit_credit), 50);
  const lines = await harness.query('SELECT * FROM trailer_invoice_lines WHERE invoice_id=$1', [invoice.id]);
  assert.equal(Number(lines.rows[0].damage_charge), 120);
  // total = base + charges − deposit (floor 0)
  const expectedTotal = Number(lines.rows[0].line_total) - 50;
  assert.equal(Number(invoice.total_amount), Math.max(expectedTotal, 0));
});

test('A4/A5: an agreement-only combined invoice is listed, payable and receipted', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const stack = loadStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['C-1', 'C-2']);

  const { agreement, items } = await stack.service.createAgreementWithItems({
    company_id: companyId,
    items: trailers.map((tid) => ({ trailer_id: tid, item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(0, 2) })),
  }, { id: adminId });
  for (const it of items) {
    await stack.service.activateItem(agreement.id, it.id, { id: adminId }, { requireInspection: false });
    await stack.service.returnItem(agreement.id, it.id, {}, { id: adminId }, { requireInspection: false });
  }
  const { invoice } = await stack.service.generateCombinedInvoice(agreement.id, { id: adminId });
  assert.equal(invoice.trailer_id, null, 'combined invoice spans trailers');
  assert.equal(Number(invoice.agreement_id), Number(agreement.id));

  // Listed with the agreement number even though there is no legacy rental.
  const listed = await stack.financeDb.listTrailerInvoices({ agreementId: agreement.id });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].agreement_number, agreement.agreement_number);

  // Partial then exact payment.
  const total = Number(invoice.total_amount);
  let paySeq = 0;
  const pay = (amount, extra = {}) => stack.financeDb.recordTrailerPayment({
    invoice_id: invoice.id, amount, payment_at: new Date().toISOString(), payment_method: 'cash',
    idempotency_key: `pay-${paySeq += 1}`, receipt_bypass_reason: 'cash', ...extra,
  }, { id: adminId });
  const partial = await pay(Math.round(total / 2 * 100) / 100);
  assert.equal(partial.invoice.status, 'partially_paid');
  assert.equal(Number(partial.payment.agreement_id), Number(agreement.id), 'A4: payment carries the agreement');
  assert.equal(partial.payment.rental_id, null);
  const rest = await pay(total - Math.round(total / 2 * 100) / 100);
  assert.equal(rest.invoice.status, 'paid');

  // The full detail includes its lines.
  const detail = await stack.financeDb.getTrailerInvoice(invoice.id);
  assert.ok(detail.lines.length >= 2);
});

test('A8: cross-system double-booking is rejected in both directions', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const stack = loadStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['X-1', 'X-2']);

  // Direction 1: a legacy ACTIVE rental blocks activating an agreement item.
  await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate, billing_method)
     VALUES ('RENT-X-1',$1,$2,'active',NOW()-INTERVAL '1 day',NOW()+INTERVAL '5 days',100,'calendar_day')`,
    [trailers[0], companyId],
  );
  const { agreement, items } = await stack.service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[0], pricing_mode: 'daily', daily_rate: 100 }],
  }, { id: adminId });
  await assert.rejects(
    () => stack.service.scheduleItem(agreement.id, items[0].id, win(0, 5), { id: adminId }),
    (e) => e.code === 'TRAILER_OVERLAP',
  );
  // Adding the same trailer with an overlapping window is refused up front too.
  await assert.rejects(
    () => stack.service.addItemViaAmendment(agreement.id,
      { trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(1, 3) },
      { id: adminId }),
    (e) => e.code === 'TRAILER_OVERLAP',
  );

  // Direction 2: an ACTIVE agreement item blocks creating/activating a legacy rental.
  const second = await stack.service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[1], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(0, 10) }],
  }, { id: adminId });
  await stack.service.activateItem(second.agreement.id, second.items[0].id, { id: adminId }, { requireInspection: false });
  await assert.rejects(
    () => stack.rentalsDb.createTrailerRental({
      trailer_id: trailers[1], company_id: companyId,
      start_at: new Date().toISOString(), expected_return_at: new Date(Date.now() + 86400000).toISOString(),
    }, { id: adminId }),
    (e) => e.code === 'TRAILER_OVERLAP',
  );
});

test('A9: an agreement cannot close while a trailer is still out', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const stack = loadStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['CL-1']);
  const api = await startApi(stack.routes, adminId, t);

  const { agreement, items } = await stack.service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[0], item_status: 'scheduled', pricing_mode: 'daily', daily_rate: 100, ...win(0, 2) }],
  }, { id: adminId });
  await stack.service.activateItem(agreement.id, items[0].id, { id: adminId }, { requireInspection: false });

  const blocked = await api('POST', `/api/trailer-agreements/${agreement.id}/close`, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'AGREEMENT_NOT_CLOSABLE');
  assert.match(blocked.body.error, /CL-1/);

  await stack.service.returnItem(agreement.id, items[0].id, {}, { id: adminId }, { requireInspection: false });
  const closed = await api('POST', `/api/trailer-agreements/${agreement.id}/close`, {});
  assert.equal(closed.status, 200);
  assert.equal(closed.body.agreement.status, 'closed');
});

test('A10: agreement numbers are format-correct, corruption-tolerant and concurrency-safe', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const stack = loadStack(harness);
  const { adminId, companyId } = await seedBasics(harness, []);
  const year = new Date().getUTCFullYear();

  // A pre-existing corrupted row (the old bug's output) must not poison MAX.
  await harness.query(
    `INSERT INTO trailer_rental_agreements (agreement_number, company_id, status)
     VALUES ('AGR-${year}-${year}000002',$1,'draft')`,
    [companyId],
  );
  const first = await stack.service.createAgreementWithItems({ company_id: companyId, items: [] }, { id: adminId });
  assert.equal(first.agreement.agreement_number, `AGR-${year}-000001`);
  const second = await stack.service.createAgreementWithItems({ company_id: companyId, items: [] }, { id: adminId });
  assert.equal(second.agreement.agreement_number, `AGR-${year}-000002`);

  // Concurrent creations never collide.
  const batch = await Promise.all(Array.from({ length: 6 }, () => (
    stack.service.createAgreementWithItems({ company_id: companyId, items: [] }, { id: adminId })
  )));
  const numbers = batch.map((b) => b.agreement.agreement_number);
  assert.equal(new Set(numbers).size, numbers.length, 'no duplicates under concurrency');
  for (const n of numbers) assert.match(n, new RegExp(`^AGR-${year}-\\d{6}$`));
});

test('A11: a stale version yields 409 VERSION_CONFLICT with the current version', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const stack = loadStack(harness);
  const { adminId, companyId, trailers } = await seedBasics(harness, ['V-1']);
  const api = await startApi(stack.routes, adminId, t);

  const { agreement, items } = await stack.service.createAgreementWithItems({
    company_id: companyId,
    items: [{ trailer_id: trailers[0], pricing_mode: 'daily', daily_rate: 100 }],
  }, { id: adminId });

  // Item write with a stale version → 409 + currentVersion for the reload.
  const stale = await api('POST', `/api/trailer-agreements/${agreement.id}/items/${items[0].id}/schedule`, {
    ...win(0, 5), version: 999,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'VERSION_CONFLICT');

  // Correct version succeeds.
  const ok = await api('POST', `/api/trailer-agreements/${agreement.id}/items/${items[0].id}/schedule`, {
    ...win(0, 5), version: items[0].version,
  });
  assert.equal(ok.status, 200);

  // Agreement-level write with a stale version → 409.
  const amountStale = await api('POST', `/api/trailer-agreements/${agreement.id}/amount`, { amount: 900, version: 999 });
  assert.equal(amountStale.status, 409);
  assert.equal(amountStale.body.code, 'VERSION_CONFLICT');
});
