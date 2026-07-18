'use strict';

/**
 * Cross-system trailer availability.
 *
 * The legacy single-trailer rentals (trailer_rentals) and the multi-trailer
 * agreement items (trailer_rental_items) each carry their own per-table overlap
 * constraints, but nothing stopped one trailer being booked in BOTH systems at
 * once. This is the one shared gate: every booking/scheduling/activation path
 * in either system calls assertTrailerAvailable before committing.
 *
 * Rules:
 *   - an ACTIVE legacy rental or agreement item blocks the trailer outright
 *     (the trailer is physically out, whatever the paper dates say);
 *   - a scheduled legacy rental / scheduled or ready-for-pickup item blocks any
 *     overlapping window.
 *
 * Depends only on the caller's client — no cycles.
 */

function formatDate(value) {
  if (!value) return 'an open date';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'an open date';
  return d.toISOString().slice(0, 10);
}

function overlapError(unitNumber, from, to) {
  return Object.assign(
    new Error(
      `Trailer ${unitNumber} is already booked from ${formatDate(from)} to ${formatDate(to)}. `
      + 'Choose another trailer or change the dates.',
    ),
    { status: 409, code: 'TRAILER_OVERLAP' },
  );
}

/**
 * Throw 409 TRAILER_OVERLAP when the trailer is already held — by EITHER system
 * — during [startAt, endAt). Pass excludeRentalId / excludeItemId so a row can
 * be re-validated against everything except itself.
 */
async function assertTrailerAvailable(client, {
  trailerId, startAt, endAt, excludeRentalId = null, excludeItemId = null,
} = {}) {
  // No window yet (a draft with no dates) conflicts with nothing — the check
  // re-runs with real dates at scheduling and again at activation.
  if (!trailerId || !startAt) return;
  const start = startAt;
  const end = endAt || null;

  const unitRes = await client.query('SELECT unit_number FROM trailers WHERE id=$1', [Number(trailerId)]);
  const unit = unitRes.rows[0]?.unit_number || `#${trailerId}`;

  const rental = await client.query(
    `SELECT id, status, start_at, expected_return_at FROM trailer_rentals
      WHERE trailer_id = $1 AND id IS DISTINCT FROM $2
        AND status IN ('scheduled','active')
        AND tstzrange(start_at, COALESCE(expected_return_at, 'infinity'::timestamptz))
         && tstzrange($3::timestamptz, COALESCE($4::timestamptz, 'infinity'::timestamptz))
      LIMIT 1`,
    [Number(trailerId), excludeRentalId == null ? null : Number(excludeRentalId), start, end],
  );
  if (rental.rows[0]) {
    const r = rental.rows[0];
    throw overlapError(unit, r.start_at, r.expected_return_at);
  }

  const item = await client.query(
    `SELECT id, item_status, scheduled_pickup_at, expected_return_at FROM trailer_rental_items
      WHERE trailer_id = $1 AND id IS DISTINCT FROM $2
        AND item_status IN ('scheduled','ready_for_pickup','active')
        AND tstzrange(scheduled_pickup_at, COALESCE(expected_return_at, 'infinity'::timestamptz))
         && tstzrange($3::timestamptz, COALESCE($4::timestamptz, 'infinity'::timestamptz))
      LIMIT 1`,
    [Number(trailerId), excludeItemId == null ? null : Number(excludeItemId), start, end],
  );
  if (item.rows[0]) {
    const i = item.rows[0];
    throw overlapError(unit, i.scheduled_pickup_at, i.expected_return_at);
  }
}

/**
 * Is this trailer physically committed RIGHT NOW — by either system? Returns the
 * blocking hold ({ system, unit, from, to }) or null. "Committed" means an
 * ACTIVE legacy rental or an ACTIVE agreement item: the trailer is out on the
 * road whatever the paperwork says.
 */
async function findActiveHold(client, trailerId) {
  const unitRes = await client.query('SELECT unit_number FROM trailers WHERE id=$1', [Number(trailerId)]);
  const unit = unitRes.rows[0]?.unit_number || `#${trailerId}`;

  const rental = await client.query(
    `SELECT start_at, expected_return_at FROM trailer_rentals
      WHERE trailer_id = $1 AND status = 'active' LIMIT 1`,
    [Number(trailerId)],
  );
  if (rental.rows[0]) {
    return { system: 'legacy', unit, from: rental.rows[0].start_at, to: rental.rows[0].expected_return_at };
  }

  const item = await client.query(
    `SELECT scheduled_pickup_at, expected_return_at FROM trailer_rental_items
      WHERE trailer_id = $1 AND item_status = 'active' LIMIT 1`,
    [Number(trailerId)],
  );
  if (item.rows[0]) {
    return { system: 'agreement', unit, from: item.rows[0].scheduled_pickup_at, to: item.rows[0].expected_return_at };
  }
  return null;
}

/**
 * Guard a manual trailer status change. Making a trailer Available, or archiving
 * it (active → false), must be refused while it is out on an active rental in
 * EITHER system — otherwise the map, the pickers and the rental disagree about
 * where the trailer is. The check lives here, once, instead of being re-derived
 * (legacy-only, historically) inside every update function.
 *
 * @param {object} client   a pg client already inside the update transaction
 * @param {object} change   { trailerId, targetPhysicalStatus, archiving }
 */
async function assertTrailerStatusChangeAllowed(client, { trailerId, targetPhysicalStatus, archiving = false } = {}) {
  const makingAvailable = targetPhysicalStatus === 'available';
  if (!makingAvailable && !archiving) return;

  const hold = await findActiveHold(client, trailerId);
  if (!hold) return;

  const action = archiving ? 'archived' : 'made available';
  throw Object.assign(
    new Error(
      `Trailer ${hold.unit} is still out on an active rental and cannot be ${action}. `
      + 'Return the trailer first, then change its status.',
    ),
    { status: 409, code: 'TRAILER_IN_USE' },
  );
}

module.exports = { assertTrailerAvailable, findActiveHold, assertTrailerStatusChangeAllowed };
