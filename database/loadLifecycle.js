/**
 * Where each load actually is — one row per Datatruck order.
 *
 * The table exists for exactly two facts a snapshot cannot supply: whether the
 * truck was ever WITNESSED at the shipper, and whether it was ever witnessed at
 * the receiver. Everything else here is the latest sighting, overwritten each
 * pass, because this is deliberately not a position history.
 */
const { query } = require('./pool');
const { toTimestampValue } = require('../lib/database/timestampValue');

function mapRow(row) {
  if (!row) return null;
  return {
    orderId: row.order_id,
    loadIdentifier: row.load_identifier,
    groupId: row.group_id,
    personId: row.person_id,
    unitNumber: row.unit_number,
    phase: row.phase,
    phaseSince: row.phase_since,
    confidence: row.confidence,
    wasAtPickup: row.was_at_pickup === true,
    wasAtDelivery: row.was_at_delivery === true,
    firstAtPickupAt: row.first_at_pickup_at,
    firstAtDeliveryAt: row.first_at_delivery_at,
    last: row.last_lat == null ? null : {
      lat: row.last_lat, lng: row.last_lng, speedMph: row.last_speed_mph, at: row.last_seen_at,
    },
    milesToPickup: row.miles_to_pickup,
    milesToDelivery: row.miles_to_delivery,
    boardStatus: row.board_status,
    signals: row.signals || [],
    conflicts: row.conflicts || [],
    lastCheckedAt: row.last_checked_at,
  };
}

/** Everything currently tracked, oldest check first. */
async function listTrackedLoads({ limit = 500 } = {}) {
  const res = await query(
    `SELECT * FROM load_lifecycle ORDER BY last_checked_at ASC NULLS FIRST LIMIT $1`,
    [limit]
  );
  return res.rows.map(mapRow);
}

async function getLoadState(orderId) {
  const res = await query('SELECT * FROM load_lifecycle WHERE order_id = $1', [String(orderId)]);
  return mapRow(res.rows[0]);
}

/**
 * Write what this pass saw.
 *
 * `was_at_pickup` and `was_at_delivery` are OR-ed, never overwritten: an arrival
 * that happened happened, and a later position outside the radius is the
 * departure those columns exist to make readable — not evidence the arrival was
 * imagined. `phase_since` moves only when the phase actually changes, so "how
 * long has it been at the receiver" stays answerable.
 */
async function recordLoadObservation(orderId, {
  loadIdentifier = null, groupId = null, personId = null, unitNumber = null,
  phase, confidence = null, atPickup = false, atDelivery = false,
  lat = null, lng = null, speedMph = null, seenAt = null,
  milesToPickup = null, milesToDelivery = null,
  boardStatus = null, signals = [], conflicts = [], checkedAt = null,
} = {}) {
  const res = await query(
    `INSERT INTO load_lifecycle
       (order_id, load_identifier, group_id, person_id, unit_number,
        phase, phase_since, confidence, was_at_pickup, was_at_delivery,
        first_at_pickup_at, first_at_delivery_at,
        last_lat, last_lng, last_speed_mph, last_seen_at,
        miles_to_pickup, miles_to_delivery, board_status, signals, conflicts, last_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($19::timestamptz, NOW()),$7,$8,$9,
             CASE WHEN $8 THEN COALESCE($19::timestamptz, NOW()) END,
             CASE WHEN $9 THEN COALESCE($19::timestamptz, NOW()) END,
             $10,$11,$12,$13::timestamptz,$14,$15,$16,$17::jsonb,$18::jsonb,
             COALESCE($19::timestamptz, NOW()))
     ON CONFLICT (order_id) DO UPDATE SET
       load_identifier = COALESCE($2, load_lifecycle.load_identifier),
       group_id = COALESCE($3, load_lifecycle.group_id),
       person_id = COALESCE($4, load_lifecycle.person_id),
       unit_number = COALESCE($5, load_lifecycle.unit_number),
       phase = $6,
       phase_since = CASE
         WHEN load_lifecycle.phase IS DISTINCT FROM $6
           THEN COALESCE($19::timestamptz, NOW())
         ELSE load_lifecycle.phase_since END,
       confidence = $7,
       was_at_pickup = load_lifecycle.was_at_pickup OR $8,
       was_at_delivery = load_lifecycle.was_at_delivery OR $9,
       first_at_pickup_at = COALESCE(load_lifecycle.first_at_pickup_at,
         CASE WHEN $8 THEN COALESCE($19::timestamptz, NOW()) END),
       first_at_delivery_at = COALESCE(load_lifecycle.first_at_delivery_at,
         CASE WHEN $9 THEN COALESCE($19::timestamptz, NOW()) END),
       last_lat = COALESCE($10, load_lifecycle.last_lat),
       last_lng = COALESCE($11, load_lifecycle.last_lng),
       last_speed_mph = COALESCE($12, load_lifecycle.last_speed_mph),
       last_seen_at = COALESCE($13::timestamptz, load_lifecycle.last_seen_at),
       miles_to_pickup = $14,
       miles_to_delivery = $15,
       board_status = COALESCE($16, load_lifecycle.board_status),
       signals = $17::jsonb,
       conflicts = $18::jsonb,
       last_checked_at = COALESCE($19::timestamptz, NOW()),
       updated_at = NOW()
     RETURNING *`,
    [
      String(orderId), loadIdentifier, groupId, personId, unitNumber,
      phase, confidence, atPickup === true, atDelivery === true,
      // `seenAt` is the provider's own sighting time, passed through from
      // telemetry. It reaches a `::timestamptz` cast, where a string
      // Postgres cannot read is an ERROR rather than a null.
      lat, lng, speedMph, toTimestampValue(seenAt), milesToPickup, milesToDelivery, boardStatus,
      JSON.stringify(signals || []), JSON.stringify(conflicts || []), checkedAt,
    ]
  );
  return mapRow(res.rows[0]);
}

/**
 * Forget loads that fell off the board.
 *
 * Delivered rows are kept for a week so "what did this driver run last week?"
 * still answers; anything not seen in a month is gone whatever its phase,
 * because an order the board stopped returning is finished one way or another.
 */
async function pruneFinishedLoads({ deliveredAfterDays = 7, staleAfterDays = 30 } = {}) {
  const res = await query(
    `DELETE FROM load_lifecycle
      WHERE (phase = 'delivered' AND updated_at < NOW() - ($1 || ' days')::interval)
         OR updated_at < NOW() - ($2 || ' days')::interval
      RETURNING order_id`,
    [String(deliveredAfterDays), String(staleAfterDays)]
  );
  return res.rowCount;
}

/** For /api/health: how many loads are tracked, and in what phase. */
async function summariseLoadPhases() {
  const res = await query(
    `SELECT phase, confidence, COUNT(*)::int AS n FROM load_lifecycle GROUP BY phase, confidence`
  );
  const byPhase = {};
  let unclear = 0;
  let total = 0;
  for (const row of res.rows) {
    byPhase[row.phase] = (byPhase[row.phase] || 0) + row.n;
    if (row.confidence && row.confidence !== 'high') unclear += row.n;
    total += row.n;
  }
  const conflicted = await query(
    `SELECT COUNT(*)::int AS n FROM load_lifecycle WHERE jsonb_array_length(COALESCE(conflicts,'[]'::jsonb)) > 0`
  );
  return { total, byPhase, unclear, conflicted: conflicted.rows[0]?.n || 0 };
}

module.exports = {
  listTrackedLoads,
  getLoadState,
  recordLoadObservation,
  pruneFinishedLoads,
  summariseLoadPhases,
};
