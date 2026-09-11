'use strict';

/**
 * Assembling everything known about one driver, from the tables that know it.
 *
 * SIX READS, NOT SIX ROUND TRIPS PER CALLER. Each section is one small query
 * against an indexed column, and they run together. The pattern being avoided
 * is the one the fuel watch had: a per-driver lookup inside a loop over the
 * fleet, about a hundred round trips every pass to answer a question a single
 * query settles. A caller wanting the whole fleet should ask the features
 * directly rather than calling this a hundred times.
 *
 * A SECTION THAT CANNOT BE READ COMES BACK NULL, and `describeContext` turns
 * that into `known: false`. It must never come back as an empty section: "this
 * driver has no safety events" and "the safety query failed" produce identical
 * empty objects, and only one of them is a reason to relax.
 */
const { query } = require('./pool');
const { describeContext } = require('../lib/drivers/context');

/** Each section catches its own failure, so one bad table cannot blank the page. */
async function safely(fn) {
  try {
    return await fn();
  } catch (_) {
    return null;
  }
}

async function readIdentity(personId) {
  const res = await query(
    `SELECT p.display_name,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT u.unit_number) FILTER (WHERE u.ended_at IS NULL), NULL)
              AS open_units,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT g.group_id) FILTER (WHERE g.ended_at IS NULL), NULL)
              AS open_groups
       FROM driver_people p
       LEFT JOIN driver_units u ON u.person_id = p.id
       LEFT JOIN driver_person_groups g ON g.person_id = p.id
      WHERE p.id = $1
      GROUP BY p.display_name`,
    [personId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    displayName: row.display_name,
    openUnits: (row.open_units || []).map(String),
    openGroups: (row.open_groups || []).map(Number),
  };
}

async function readHomeTime(personId) {
  const res = await query(
    `SELECT s.state, s.state_since
       FROM driver_home_status s
       JOIN driver_person_groups g ON g.group_id = s.group_id AND g.ended_at IS NULL
      WHERE g.person_id = $1
      ORDER BY s.state_since DESC NULLS LAST
      LIMIT 1`,
    [personId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { state: row.state, stateSince: row.state_since };
}

async function readLoads(personId) {
  // Only a phase that means the truck is WORKING counts as movement here. A
  // load sitting `assigned` is not a contradiction with being at home; one
  // `in_transit` is.
  const res = await query(
    `SELECT l.order_id, l.phase
       FROM load_lifecycle l
       JOIN driver_person_groups g ON g.group_id = l.group_id AND g.ended_at IS NULL
      WHERE g.person_id = $1
        AND l.phase IN ('heading_to_pickup', 'at_pickup', 'in_transit', 'at_delivery')
      ORDER BY l.updated_at DESC
      LIMIT 1`,
    [personId]
  );
  const row = res.rows[0];
  return { movingPhase: row ? row.phase : null, orderId: row ? row.order_id : null };
}

async function readFuel(personId) {
  const res = await query(
    `SELECT fuel_percent, odometer_miles, recorded_at
       FROM truck_fuel_readings
      WHERE person_id = $1
      ORDER BY recorded_at DESC NULLS LAST
      LIMIT 1`,
    [personId]
  );
  const row = res.rows[0];
  return {
    fuelPercent: row ? row.fuel_percent : null,
    odometerMiles: row ? row.odometer_miles : null,
    newestReadingAt: row ? row.recorded_at : null,
  };
}

async function readSafety(personId, { windowDays = 30 } = {}) {
  const res = await query(
    `SELECT COUNT(*)::int AS events, MAX(occurred_at) AS newest
       FROM driver_safety_events
      WHERE person_id = $1 AND occurred_at > NOW() - ($2 || ' days')::interval`,
    [personId, String(windowDays)]
  );
  const row = res.rows[0] || {};
  return { events: row.events || 0, newestEventAt: row.newest || null, windowDays };
}

async function readRetention(personId) {
  const res = await query(
    `SELECT signals, urgency, assessed_at
       FROM driver_retention_assessments
      WHERE person_id = $1
      ORDER BY assessed_at DESC LIMIT 1`,
    [personId]
  );
  const row = res.rows[0];
  if (!row) return { goneQuiet: false, urgency: null, assessedAt: null };
  const signals = Array.isArray(row.signals) ? row.signals : [];
  return {
    goneQuiet: signals.some((s) => String(s?.kind || s).includes('quiet')),
    goneQuietSince: row.assessed_at,
    urgency: row.urgency,
    assessedAt: row.assessed_at,
    signals: signals.length,
  };
}

/**
 * Everything known about one driver, with the gaps marked as gaps.
 *
 * @param {number} personId
 * @returns {Promise<object>} a context from `lib/drivers/context.js`
 */
async function getDriverContext(personId) {
  if (!personId) return describeContext({});
  const [identity, homeTime, loads, fuel, safety, retention] = await Promise.all([
    safely(() => readIdentity(personId)),
    safely(() => readHomeTime(personId)),
    safely(() => readLoads(personId)),
    safely(() => readFuel(personId)),
    safely(() => readSafety(personId)),
    safely(() => readRetention(personId)),
  ]);
  return describeContext({ personId, identity, homeTime, loads, fuel, safety, retention });
}

module.exports = { getDriverContext };
