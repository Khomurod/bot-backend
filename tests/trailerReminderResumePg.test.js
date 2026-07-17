/**
 * PostgreSQL integration — expired snoozes auto-resume (Phase 6).
 *
 * A snoozed invoice carries reminder_state='snoozed'. The reminder enqueue only
 * looks at reminder_state='active', so an expired snooze must be restored to
 * active before reminders are decided — otherwise it stays snoozed forever.
 *
 * Requires TEST_DATABASE_URL; SKIPs without it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

async function seedInvoice(harness, { reminderState, snoozedUntil }) {
  const company = await harness.query(
    "INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ('Acme','Acme',TRUE) RETURNING id",
  );
  const agreement = await harness.query(
    `INSERT INTO trailer_rental_agreements (agreement_number, company_id, status)
     VALUES ('AGR-TEST-1', $1, 'active') RETURNING id`, [company.rows[0].id],
  );
  const inv = await harness.query(
    `INSERT INTO trailer_invoices
       (invoice_number, company_id, agreement_id, billing_period_start, billing_period_end,
        billing_method, base_amount, total_amount, due_at, status, reminder_state, snoozed_until)
     VALUES ('INV-TEST-1', $1, $2, NOW()-INTERVAL '20 days', NOW()-INTERVAL '10 days',
             'calendar_day', 500, 500, NOW()-INTERVAL '10 days', 'issued', $3, $4)
     RETURNING id, reminder_state`,
    [company.rows[0].id, agreement.rows[0].id, reminderState, snoozedUntil],
  );
  return inv.rows[0];
}

test('an expired snooze is restored to active', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerNotifications } = harness.loadDataLayer(['trailerNotifications']);
  const inv = await seedInvoice(harness, { reminderState: 'snoozed', snoozedUntil: null });
  await harness.query("UPDATE trailer_invoices SET snoozed_until = NOW() - INTERVAL '1 day' WHERE id=$1", [inv.id]);

  const restored = await trailerNotifications.resumeExpiredSnoozes();
  assert.equal(restored, 1);
  const after = await harness.query('SELECT reminder_state, snoozed_until FROM trailer_invoices WHERE id=$1', [inv.id]);
  assert.equal(after.rows[0].reminder_state, 'active');
  assert.equal(after.rows[0].snoozed_until, null);
});

test('a snooze that has not expired stays snoozed', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerNotifications } = harness.loadDataLayer(['trailerNotifications']);
  const inv = await seedInvoice(harness, { reminderState: 'snoozed', snoozedUntil: null });
  await harness.query("UPDATE trailer_invoices SET snoozed_until = NOW() + INTERVAL '3 days' WHERE id=$1", [inv.id]);

  const restored = await trailerNotifications.resumeExpiredSnoozes();
  assert.equal(restored, 0);
  const after = await harness.query('SELECT reminder_state FROM trailer_invoices WHERE id=$1', [inv.id]);
  assert.equal(after.rows[0].reminder_state, 'snoozed');
});

test('an active invoice is untouched by the resume step', async (t) => {
  if (skipWithoutPg()) { t.skip('set TEST_DATABASE_URL'); return; }
  const harness = await createTrailerPgHarness(t);
  const { trailerNotifications } = harness.loadDataLayer(['trailerNotifications']);
  await seedInvoice(harness, { reminderState: 'active', snoozedUntil: null });
  const restored = await trailerNotifications.resumeExpiredSnoozes();
  assert.equal(restored, 0);
});
