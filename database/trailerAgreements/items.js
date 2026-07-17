/**
 * Multi-trailer rental agreement items — per-trailer data access.
 *
 * Each item is one trailer's lifecycle inside an agreement: schedule → pickup →
 * active → return, with its own pricing. Availability is enforced by the
 * database (an EXCLUDE overlap constraint + a partial unique "one active per
 * trailer" index) plus explicit official-trailer checks here.
 *
 * Depends only on ./pool — no cycles.
 */
'use strict';

const { query } = require('../pool');

const OFFICIAL = "active = TRUE AND master_status = 'active'";

async function getItemById(id, client = { query }) {
  const res = await client.query('SELECT * FROM trailer_rental_items WHERE id = $1', [Number(id)]);
  return res.rows[0] || null;
}

async function listItems(agreementId, client = { query }) {
  const res = await client.query(
    'SELECT * FROM trailer_rental_items WHERE agreement_id = $1 ORDER BY item_sequence, id',
    [Number(agreementId)],
  );
  return res.rows;
}

/** Assert a trailer is official and selectable (locks the row FOR UPDATE). */
async function assertSelectableTrailer(trailerId, client) {
  const res = await client.query(
    `SELECT id, unit_number, ${OFFICIAL} AS official, physical_status, master_status
       FROM trailers WHERE id = $1 FOR UPDATE`,
    [Number(trailerId)],
  );
  const t = res.rows[0];
  if (!t) throw Object.assign(new Error('Trailer not found.'), { status: 404, code: 'TRAILER_NOT_FOUND' });
  if (!t.official) {
    throw Object.assign(
      new Error(`Trailer ${t.unit_number} is not on the official master list (${t.master_status}).`),
      { status: 409, code: 'TRAILER_NOT_OFFICIAL' },
    );
  }
  return t;
}

/**
 * Add an item to an agreement. Validates the trailer is official; the DB overlap
 * constraint rejects a double-booking with error code 23P01 (mapped to 409).
 */
async function addItem(agreementId, input = {}, client = { query }) {
  if (!input.trailer_id) {
    throw Object.assign(new Error('trailer_id is required.'), { status: 400, code: 'TRAILER_REQUIRED' });
  }
  await assertSelectableTrailer(input.trailer_id, client);

  const seqRes = await client.query(
    'SELECT COALESCE(MAX(item_sequence), 0) + 1 AS n FROM trailer_rental_items WHERE agreement_id = $1',
    [Number(agreementId)],
  );
  const cols = {
    agreement_id: Number(agreementId),
    trailer_id: Number(input.trailer_id),
    item_sequence: input.item_sequence || seqRes.rows[0].n,
    item_status: input.item_status || 'draft',
    scheduled_pickup_at: input.scheduled_pickup_at || null,
    expected_return_at: input.expected_return_at || null,
    pickup_location: input.pickup_location || null,
    pickup_lat: input.pickup_lat ?? null,
    pickup_lng: input.pickup_lng ?? null,
    pricing_mode: input.pricing_mode || 'daily',
    daily_rate: input.daily_rate ?? null,
    weekly_rate: input.weekly_rate ?? null,
    monthly_rate: input.monthly_rate ?? null,
    flat_amount: input.flat_amount ?? null,
    included_in_bundle: input.included_in_bundle === true,
    additional_amount: input.additional_amount ?? 0,
    discount_amount: input.discount_amount ?? 0,
    deposit_allocation: input.deposit_allocation ?? 0,
    grace_period_override: input.grace_period_override ?? null,
    billing_timezone_override: input.billing_timezone_override || null,
    notes: input.notes || null,
    added_amendment_id: input.added_amendment_id || null,
    created_by_admin_id: input.created_by_admin_id || null,
    updated_by_admin_id: input.created_by_admin_id || null,
  };
  const keys = Object.keys(cols);
  try {
    const res = await client.query(
      `INSERT INTO trailer_rental_items (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => cols[k]),
    );
    return res.rows[0];
  } catch (err) {
    if (err.code === '23P01' || err.code === '23505') {
      throw Object.assign(
        new Error('That trailer is already booked for an overlapping period.'),
        { status: 409, code: 'TRAILER_OVERLAP' },
      );
    }
    throw err;
  }
}

/** Set an item's status with optimistic locking and return the updated row. */
async function setItemStatus(id, nextStatus, patch = {}, client = { query }) {
  const fields = { item_status: nextStatus, ...patch };
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const vals = keys.map((k) => fields[k]);
  sets.push('updated_at = NOW()', 'version = version + 1');
  vals.push(Number(id));
  const res = await client.query(
    `UPDATE trailer_rental_items SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
    vals,
  );
  return res.rows[0] || null;
}

module.exports = {
  getItemById,
  listItems,
  assertSelectableTrailer,
  addItem,
  setItemStatus,
};
