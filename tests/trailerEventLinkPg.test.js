/**
 * PostgreSQL integration — safe AI-event → movement linking (Phase 6).
 *
 * Linking must target a SPECIFIC movement, never "the newest one", and must
 * refuse to relink an already-linked event or steal a movement already linked
 * to another event.
 *
 * Requires TEST_DATABASE_URL; SKIPs without it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

async function seed(harness) {
  const trailer = await harness.query(
    `INSERT INTO trailers (unit_number, physical_status, active, master_status, master_source)
     VALUES ('EV-1','available',TRUE,'active','admin_manual') RETURNING id`,
  );
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id",
  );
  const rental = await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, daily_rate, billing_method)
     VALUES ('RENT-EV-1',$1,$2,'draft',100,'calendar_day') RETURNING id`,
    [trailer.rows[0].id, company.rows[0].id],
  );
  const mv = async (loc) => (await harness.query(
    `INSERT INTO trailer_rental_movements (trailer_id, rental_id, movement_type, to_location, event_at)
     VALUES ($1,$2,'rental_pickup',$3,NOW()) RETURNING id`,
    [trailer.rows[0].id, rental.rows[0].id, loc],
  )).rows[0].id;
  const ev = async () => (await harness.query(
    `INSERT INTO trailer_events (trailer_id, event_type) VALUES ($1,'pickup') RETURNING id`,
    [trailer.rows[0].id],
  )).rows[0].id;
  return { trailerId: trailer.rows[0].id, rentalId: rental.rows[0].id, mv, ev };
}

test('an explicit movement links; a second event cannot steal it', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerRentals } = harness.loadDataLayer(['trailerRentals']);
  const s = await seed(harness);
  const m1 = await s.mv('Dallas');
  const e1 = await s.ev();
  const e2 = await s.ev();

  const linked = await trailerRentals.linkTrailerEventToRental(e1, s.rentalId, { username: 'a' }, { movementId: m1 });
  assert.equal(Number(linked.rental_movement_id), Number(m1));

  await assert.rejects(
    () => trailerRentals.linkTrailerEventToRental(e2, s.rentalId, { username: 'a' }, { movementId: m1 }),
    (err) => err.status === 409,
  );
});

test('an already-linked event cannot be relinked', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerRentals } = harness.loadDataLayer(['trailerRentals']);
  const s = await seed(harness);
  const m1 = await s.mv('Dallas');
  const m2 = await s.mv('Houston');
  const e1 = await s.ev();
  await trailerRentals.linkTrailerEventToRental(e1, s.rentalId, { username: 'a' }, { movementId: m1 });
  await assert.rejects(
    () => trailerRentals.linkTrailerEventToRental(e1, s.rentalId, { username: 'a' }, { movementId: m2 }),
    (err) => err.status === 409,
  );
});

test('with multiple movements and no movementId, the caller must choose', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerRentals } = harness.loadDataLayer(['trailerRentals']);
  const s = await seed(harness);
  await s.mv('Dallas');
  await s.mv('Houston');
  const e1 = await s.ev();
  await assert.rejects(
    () => trailerRentals.linkTrailerEventToRental(e1, s.rentalId, { username: 'a' }),
    (err) => err.status === 422,
  );
});
