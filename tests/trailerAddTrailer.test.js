/**
 * Pure add-trailer helpers (admin AddTrailerDialog) — blocker 3.4. Proves the
 * ADD workflow (distinct from Replace) excludes the right trailers, prevents
 * picking one already on the rental, gates submission, and shapes the payload.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.resolve(__dirname, '../admin/src/pages/trailer/rentals/addTrailer.js');
let m;
test.before(async () => { m = await import(pathToFileURL(MODULE).href); });

const TRAILERS = [
  { id: 1, unit_number: '1045', physical_status: 'available', master_status: 'active', active: true },
  { id: 2, unit_number: '1088', physical_status: 'available', master_status: 'active', active: true },
  { id: 3, unit_number: '2044', physical_status: 'rented', master_status: 'active', active: true },
  { id: 4, unit_number: '9000', physical_status: 'available', master_status: 'pending_review', active: true },
  { id: 5, unit_number: '9001', physical_status: 'available', master_status: 'active', active: false },
];

test('selectable trailers exclude rented, pending-review, archived and already-on-rental', () => {
  const selectable = m.selectableTrailersForAdd(TRAILERS, [{ trailer_id: 2 }]);
  const ids = selectable.map((t) => t.id);
  assert.deepEqual(ids, [1]); // 2 taken, 3 rented, 4 pending, 5 archived
});

test('a trailer already on the rental cannot be picked twice', () => {
  const selectable = m.selectableTrailersForAdd(TRAILERS, [{ trailer_id: 1 }]);
  assert.ok(!selectable.some((t) => t.id === 1));
});

test('text filter matches unit number', () => {
  assert.equal(m.filterTrailersByText(TRAILERS, '104').length, 1);
  assert.equal(m.filterTrailersByText(TRAILERS, '10').length, 2); // 1045, 1088
  assert.equal(m.filterTrailersByText(TRAILERS, '').length, TRAILERS.length);
});

test('blockers require trailer, dates, ordered window and a positive rate', () => {
  assert.deepEqual(
    m.addTrailerBlockers({ pricing_mode: 'daily' }).length > 0, true,
  );
  const good = {
    trailer_id: '1', scheduled_pickup_at: '2026-07-20T08:00', expected_return_at: '2026-07-25T08:00',
    pricing_mode: 'daily', daily_rate: '100',
  };
  assert.deepEqual(m.addTrailerBlockers(good), []);
  const backwards = { ...good, expected_return_at: '2026-07-19T08:00' };
  assert.ok(m.addTrailerBlockers(backwards).some((s) => /after the pickup/i.test(s)));
  const noRate = { ...good, daily_rate: '0' };
  assert.ok(m.addTrailerBlockers(noRate).some((s) => /rate or amount/i.test(s)));
});

test('weekly pricing gates on the weekly rate field', () => {
  const form = {
    trailer_id: '1', scheduled_pickup_at: '2026-07-20T08:00', expected_return_at: '2026-07-25T08:00',
    pricing_mode: 'weekly', weekly_rate: '500',
  };
  assert.deepEqual(m.addTrailerBlockers(form), []);
});

test('payload is a scheduled item with the right rate field, no replace terminology', () => {
  const payload = m.buildAddItemPayload({
    trailer_id: '7', scheduled_pickup_at: '2026-07-20T08:00', expected_return_at: '2026-07-25T08:00',
    pickup_location: 'Chicago Yard', pricing_mode: 'flat', flat_amount: '900', notes: 'n',
  });
  assert.equal(payload.trailer_id, 7);
  assert.equal(payload.item_status, 'scheduled');
  assert.equal(payload.flat_amount, 900);
  assert.equal(payload.pickup_location, 'Chicago Yard');
  assert.ok(payload.scheduled_pickup_at.endsWith('Z'));
});
