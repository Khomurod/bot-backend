/**
 * The watch on a driver who is currently home: where their truck was parked,
 * what has been seen of it since, and the last verdict.
 *
 * One row per chat, created when a driver is first observed at home and dropped
 * when they are back on the road. Everything here is a plain read or write —
 * the rules that read these values live in lib/homeTime/returnEvidence.js, and
 * the fetching lives in the service. Keeping the three apart is what lets the
 * rules be tested without a database or a provider.
 *
 * WHAT A PASS COSTS THE DATABASE, which bills every byte it sends back. The
 * return-to-road pass runs every twelve minutes, economy mode or not, and for
 * each driver at home it used to receive this whole 24-column row FOUR times —
 * the create echoed it, a `SELECT *` read it, and both observation writes
 * echoed it — each copy carrying the `last_signals` JSON that the pass never
 * reads back. An audit put that at ~12 MB a day (October 2026, with the
 * monthly allowance nearly spent). Now, per driver:
 *
 *   ensureWatch        the create IS the read: it returns REMEMBERED_COLUMNS,
 *                      the eight values the score reads from the row;
 *   recordObservation  returns AFTER_SIGHTING_COLUMNS, the four a sighting can
 *                      move that the score then reads — computed by THIS
 *                      statement, not re-derived in JavaScript, because the
 *                      moving-sighting counter's guards (see below) have been
 *                      wrong twice in ways only the real statement showed;
 *   recordVerdict      returns nothing.
 *
 * The rest of the row — the load, the verdict, the signals — is written for
 * the correction (`services/operations/corrections/returnToRoadActions.js`,
 * which reads the row under its own lock, only when a return is applied) and
 * for /api/health, not for the pass. `tests/returnToRoadPassQueries.test.js`
 * pins the shape; `tests/homeTimeReturnWatchPg.test.js` proves each narrow
 * answer equals what the full row says.
 */
const { query } = require('../pool');
const { toTimestampValue, toNumericValue } = require('../../lib/database/timestampValue');

/** On the caller's transaction when it has one. */
function runner(client) {
  return client ? client.query.bind(client) : query;
}

/** Everything the score reads from the row, and nothing else. */
const REMEMBERED_COLUMNS = `anchor_lat, anchor_lng, last_lat, last_lng, last_speed_mph, last_seen_at,
                max_miles_from_anchor, moving_sightings`;

/** What a sighting can change that the score reads straight after it. */
const AFTER_SIGHTING_COLUMNS = 'anchor_lat, anchor_lng, max_miles_from_anchor, moving_sightings';

/** Where the truck was parked: both coordinates, or no anchor at all. */
function anchorOf(row) {
  return row.anchor_lat != null && row.anchor_lng != null
    ? { lat: Number(row.anchor_lat), lng: Number(row.anchor_lng) }
    : null;
}

function lastSightingOf(row) {
  return row.last_lat != null && row.last_lng != null
    ? {
      lat: Number(row.last_lat),
      lng: Number(row.last_lng),
      speedMph: row.last_speed_mph == null ? null : Number(row.last_speed_mph),
      at: row.last_seen_at,
    }
    : null;
}

/** The anchor and the two running values — what a sighting write hands back. */
function runningValuesOf(row) {
  return {
    anchor: anchorOf(row),
    maxMilesFromAnchor: Number(row.max_miles_from_anchor) || 0,
    movingSightings: row.moving_sightings || 0,
  };
}

function mapWatch(row) {
  if (!row) return null;
  const running = runningValuesOf(row);
  return {
    groupId: row.group_id,
    personId: row.person_id,
    roadHistoryId: row.road_history_id,
    homeSince: row.home_since,
    anchor: running.anchor && { ...running.anchor, at: row.anchor_at, source: row.anchor_source },
    last: lastSightingOf(row),
    lastCheckedAt: row.last_checked_at,
    maxMilesFromAnchor: running.maxMilesFromAnchor,
    movingSightings: running.movingSightings,
    load: row.load_identifier || row.load_status
      ? {
        loadIdentifier: row.load_identifier,
        status: row.load_status,
        firstSeenAt: row.load_first_seen_at,
        pickupTime: row.load_pickup_at,
      }
      : null,
    lastConfidence: row.last_confidence,
    lastScore: row.last_score,
    lastSignals: row.last_signals || {},
    updatedAt: row.updated_at,
  };
}

/** REMEMBERED_COLUMNS, mapped: the anchor, the last sighting and the running values. */
function mapRemembered(row) {
  return row ? { ...runningValuesOf(row), last: lastSightingOf(row) } : null;
}

/**
 * Every driver who is at home right now, on an ACTIVE driver chat, with what is
 * needed to look them up in a fleet snapshot. One query, so a tick that finds
 * nobody home costs one round trip and no provider calls at all.
 *
 * Only what the pass uses: the chat's Telegram id and its Samsara vehicle id
 * used to come back too, for every driver on every pass, and nothing read them.
 */
async function listDriversAtHome() {
  const res = await query(
    `SELECT g.id                AS group_id,
            g.group_name,
            s.state_since       AS home_since,
            p.unit_number,
            p.first_name,
            p.last_name,
            pg.person_id,
            (SELECT h.id FROM driver_road_history h
              WHERE h.group_id = g.id AND h.return_to_road_at IS NULL
              ORDER BY h.home_arrived_at DESC LIMIT 1) AS road_history_id
       FROM driver_home_status s
       JOIN groups g ON g.id = s.group_id
       LEFT JOIN driver_profiles p ON p.group_id = g.id
       LEFT JOIN driver_person_groups pg ON pg.group_id = g.id AND pg.ended_at IS NULL
      WHERE s.state = 'home'
        AND g.group_type = 'driver'
        AND g.active = TRUE
      ORDER BY s.state_since ASC`
  );
  return res.rows.map((r) => ({
    groupId: r.group_id,
    groupName: r.group_name,
    homeSince: r.home_since,
    unitNumber: r.unit_number,
    driverName: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null,
    personId: r.person_id,
    roadHistoryId: r.road_history_id,
  }));
}

/**
 * Create the watch when a driver is first seen at home, and hand back what it
 * remembers — `{ anchor, last, maxMilesFromAnchor, movingSightings }`. Never
 * resets an existing anchor.
 *
 * This statement is the pass's ONE read of the row: the upsert touches none of
 * the columns it returns, so they are exactly what a following SELECT would
 * have read.
 */
async function ensureWatch({ groupId, personId = null, roadHistoryId = null, homeSince = null }, client = null) {
  const res = await runner(client)(
    `INSERT INTO home_time_return_watch (group_id, person_id, road_history_id, home_since)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (group_id) DO UPDATE
        SET person_id = COALESCE(EXCLUDED.person_id, home_time_return_watch.person_id),
            road_history_id = COALESCE(EXCLUDED.road_history_id, home_time_return_watch.road_history_id),
            home_since = COALESCE(EXCLUDED.home_since, home_time_return_watch.home_since),
            updated_at = NOW()
     RETURNING ${REMEMBERED_COLUMNS}`,
    [groupId, personId, roadHistoryId, toTimestampValue(homeSince)]
  );
  return mapRemembered(res.rows[0]);
}

/**
 * One write for a sighting and for a verdict alike — a verdict is an
 * observation with no sighting in it, and with no sighting every sighting
 * column below keeps the value it had. Shared so the verdict write is the same
 * statement it always was, minus what it used to send back.
 *
 * The anchor is written ONLY when there is not one already and the truck is
 * stationary — `anchor_lat IS NULL AND $9` in the statement, so two workers
 * racing cannot produce two different homes. `max_miles_from_anchor` and
 * `moving_sightings` only ever grow within a stay; they are the memory that
 * makes "it moved, twice, and never came back" answerable from one row.
 */
const OBSERVATION_UPDATE = `UPDATE home_time_return_watch
        SET anchor_lat = CASE WHEN anchor_lat IS NULL AND $9 THEN $2 ELSE anchor_lat END,
            anchor_lng = CASE WHEN anchor_lng IS NULL AND $9 THEN $3 ELSE anchor_lng END,
            anchor_at  = CASE WHEN anchor_at  IS NULL AND $9 THEN COALESCE($5::timestamptz, NOW()) ELSE anchor_at END,
            anchor_source = CASE WHEN anchor_source IS NULL AND $9 THEN $10 ELSE anchor_source END,
            last_lat = COALESCE($2, last_lat),
            last_lng = COALESCE($3, last_lng),
            last_speed_mph = COALESCE($4, last_speed_mph),
            last_seen_at = COALESCE($5::timestamptz, last_seen_at),
            last_checked_at = COALESCE($6::timestamptz, NOW()),
            -- THE CAST IS LOAD-BEARING. Without it Postgres infers the type
            -- of this parameter from the integer literal beside it, so a real
            -- distance -- 12.25 miles -- is refused with
            -- "invalid input syntax for type integer". The column is DOUBLE
            -- PRECISION; only the COALESCE made it look like an integer.
            --
            -- This is why exactly ONE driver failed on every pass for a day:
            -- the distance is only computed when the watch has an anchor AND
            -- the truck was seen, which for most drivers is null most of the
            -- time. The one driver who was both anchored and visible hit it
            -- every twelve minutes.
            max_miles_from_anchor = GREATEST(max_miles_from_anchor, COALESCE($7::double precision, 0)),
            -- A REPEATED PING IS NOT A SECOND SIGHTING. Providers hold their
            -- latest sample until a new one arrives, so counting every pass
            -- would turn one 60 mph reading into "movement confirmed twice"
            -- after two ticks — and two sightings is exactly what lets an
            -- automatic Home → Road change through.
            -- AND A SIGHTING WITH NO TIME IS NOT A SIGHTING. The seen-at
            -- parameter is null when the provider's timestamp could not be
            -- read (see the parameter list below). NULL IS DISTINCT FROM a
            -- stored value is TRUE, so without this guard every poll of the
            -- SAME unreadable reading counted as another sighting while
            -- last_seen_at kept its old value and never converged -- two
            -- polls, and an automatic Home to Road change goes through on one
            -- real sighting.
            moving_sightings = moving_sightings + CASE
              WHEN $8 AND $5::timestamptz IS NOT NULL
               AND ($5::timestamptz IS DISTINCT FROM last_seen_at) THEN 1 ELSE 0 END,
            load_identifier = COALESCE($11, load_identifier),
            load_status = COALESCE($12, load_status),
            load_first_seen_at = CASE
              WHEN $11 IS NOT NULL AND load_first_seen_at IS NULL THEN NOW()
              ELSE load_first_seen_at END,
            load_pickup_at = COALESCE($13::timestamptz, load_pickup_at),
            last_confidence = COALESCE($14, last_confidence),
            last_score = COALESCE($15, last_score),
            last_signals = COALESCE($16::jsonb, last_signals),
            updated_at = NOW()
      WHERE group_id = $1`;

function observationValues(groupId, {
  lat = null, lng = null, speedMph = null, seenAt = null, checkedAt = null,
  milesFromAnchor = null, moving = false, anchorEligible = false, anchorSource = null,
  load = null, confidence = null, score = null, signals = null,
} = {}) {
  return [
    // EVERY `::timestamptz` PARAMETER IS NORMALISED FIRST.
    //
    // `load.pickupTime` is `order.pickup_time` from Datatruck, verbatim —
    // a field an external system fills with whatever somebody typed. Bound
    // straight into the cast, one unreadable value did not become a null: it
    // raised `invalid input syntax`, which aborted the statement, the driver,
    // and (until the caller learned to isolate them) every driver behind them
    // in the loop. `seenAt` comes from a telemetry provider and can do the
    // same. Losing one unreadable appointment time is a far smaller loss than
    // losing the pass; `toTimestampValue` makes that the outcome.
    //
    // AND EVERY NUMERIC PARAMETER TOO, for a trap that hides better: Postgres
    // accepts NaN in `double precision` and refuses it in `integer`. A NaN
    // speed is therefore stored without complaint, read back next pass, and
    // turns the score it feeds into a NaN that `last_score INTEGER` rejects —
    // so the driver fails for ever on a value an earlier pass wrote.
    groupId, toNumericValue(lat), toNumericValue(lng), toNumericValue(speedMph),
    toTimestampValue(seenAt), toTimestampValue(checkedAt),
    toNumericValue(milesFromAnchor), Boolean(moving), Boolean(anchorEligible), anchorSource,
    load?.loadIdentifier || null, load?.status || null, toTimestampValue(load?.pickupTime),
    confidence, toNumericValue(score), signals ? JSON.stringify(signals) : null,
  ];
}

/**
 * Record one sighting, and hand back `{ anchor, maxMilesFromAnchor,
 * movingSightings }` as the row now holds them — including an anchor this
 * very sighting just set. Null when the watch is gone.
 */
async function recordObservation(groupId, observation = {}, client = null) {
  const res = await runner(client)(
    `${OBSERVATION_UPDATE}
      RETURNING ${AFTER_SIGHTING_COLUMNS}`,
    observationValues(groupId, observation)
  );
  return res.rows[0] ? runningValuesOf(res.rows[0]) : null;
}

/**
 * Record the verdict the sighting produced. Nothing is read back — the pass
 * has the verdict already. True when a watch was there to take it.
 */
async function recordVerdict(groupId, {
  checkedAt = null, confidence = null, score = null, signals = null,
} = {}, client = null) {
  const res = await runner(client)(
    OBSERVATION_UPDATE,
    observationValues(groupId, { checkedAt, confidence, score, signals })
  );
  return res.rowCount > 0;
}

/** The whole row — for a reader that wants all of it. The pass does not. */
async function getWatch(groupId, client = null) {
  const res = await runner(client)('SELECT * FROM home_time_return_watch WHERE group_id = $1', [groupId]);
  return mapWatch(res.rows[0]);
}

/** The driver is back on the road (or no longer home): the watch is over. */
async function clearWatch(groupId, client = null) {
  const res = await runner(client)('DELETE FROM home_time_return_watch WHERE group_id = $1 RETURNING group_id', [groupId]);
  return res.rows.length > 0;
}

/**
 * Drop watches for drivers who are no longer home — the tidy-up half of a
 * tick. Returns HOW MANY: the pass only ever counted the ids it used to read
 * back.
 */
async function clearStaleWatches(activeGroupIds) {
  const ids = Array.isArray(activeGroupIds) ? activeGroupIds : [];
  const res = await query(
    `DELETE FROM home_time_return_watch
      WHERE NOT (group_id = ANY($1::int[]))`,
    [ids]
  );
  return res.rowCount || 0;
}

async function listWatches({ limit = 200 } = {}) {
  const res = await query(
    'SELECT * FROM home_time_return_watch ORDER BY last_checked_at ASC NULLS FIRST LIMIT $1',
    [limit]
  );
  return res.rows.map(mapWatch);
}

module.exports = {
  mapWatch,
  listDriversAtHome,
  ensureWatch,
  recordObservation,
  recordVerdict,
  getWatch,
  clearWatch,
  clearStaleWatches,
  listWatches,
};
