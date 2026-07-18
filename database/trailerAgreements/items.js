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
const { assertTrailerAvailable } = require('../trailerAvailability');

const OFFICIAL = "active = TRUE AND master_status = 'active'";

/**
 * A caller may create an item only as 'draft', or as 'scheduled' when both a
 * pickup and an expected-return time are provided. Internal flows (replacing a
 * not-yet-picked-up trailer) pass an explicit allow-list; the backend never
 * trusts an active/returned/cancelled/disputed creation status.
 */
function assertCreatableStatus(input, allowStatuses) {
  const requested = input.item_status || 'draft';
  const allowed = new Set(allowStatuses
    || ['draft', ...(input.scheduled_pickup_at && input.expected_return_at ? ['scheduled'] : [])]);
  if (!allowed.has(requested)) {
    throw Object.assign(
      new Error('A new trailer on a rental starts as draft (or scheduled when its dates are set).'),
      { status: 422, code: 'ITEM_STATUS_NOT_ALLOWED' },
    );
  }
  return requested;
}

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
async function addItem(agreementId, input = {}, client = { query }, { allowStatuses } = {}) {
  if (!input.trailer_id) {
    throw Object.assign(new Error('trailer_id is required.'), { status: 400, code: 'TRAILER_REQUIRED' });
  }
  const itemStatus = assertCreatableStatus(input, allowStatuses);
  await assertSelectableTrailer(input.trailer_id, client);
  await assertTrailerAvailable(client, {
    trailerId: input.trailer_id,
    startAt: input.scheduled_pickup_at || null,
    endAt: input.expected_return_at || null,
  });

  const seqRes = await client.query(
    'SELECT COALESCE(MAX(item_sequence), 0) + 1 AS n FROM trailer_rental_items WHERE agreement_id = $1',
    [Number(agreementId)],
  );
  const cols = {
    agreement_id: Number(agreementId),
    trailer_id: Number(input.trailer_id),
    item_sequence: input.item_sequence || seqRes.rows[0].n,
    item_status: itemStatus,
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

/**
 * Set an item's status and return the updated row. When `expectedVersion` is
 * provided (the UI always sends it) a stale version yields 409 VERSION_CONFLICT
 * instead of a silent overwrite.
 */
async function setItemStatus(id, nextStatus, patch = {}, client = { query }, expectedVersion) {
  const fields = { item_status: nextStatus, ...patch };
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const vals = keys.map((k) => fields[k]);
  sets.push('updated_at = NOW()', 'version = version + 1');
  vals.push(Number(id));
  let where = `id = $${vals.length}`;
  if (expectedVersion !== undefined && expectedVersion !== null) {
    vals.push(Number(expectedVersion));
    where += ` AND version = $${vals.length}`;
  }
  const res = await client.query(
    `UPDATE trailer_rental_items SET ${sets.join(', ')} WHERE ${where} RETURNING *`,
    vals,
  );
  if (!res.rows[0] && expectedVersion !== undefined && expectedVersion !== null) {
    const current = await getItemById(id, client);
    if (current) {
      throw Object.assign(
        new Error('This record changed while you were editing. Reload and try again.'),
        { status: 409, code: 'VERSION_CONFLICT', currentVersion: current.version },
      );
    }
  }
  return res.rows[0] || null;
}

module.exports = {
  getItemById,
  listItems,
  assertSelectableTrailer,
  addItem,
  setItemStatus,
};
