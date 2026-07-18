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

module.exports = { assertTrailerAvailable };
