/**
 * Route monitor EVENT LOG — database helpers.
 *
 * The per-assignment audit trail of monitoring checks and notifications, read
 * by the admin Route Control page.
 *
 * Split out of database/routeControl.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

async function insertRouteMonitorEvent({
  assignmentId, eventType, result, latitude, longitude, deviationMeters, detail,
}) {
  const res = await query(
    `INSERT INTO route_monitor_events
       (assignment_id, event_type, result, latitude, longitude, deviation_meters, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      assignmentId, eventType, result || null,
      latitude ?? null, longitude ?? null, deviationMeters ?? null, detail || null,
    ]
  );
  return res.rows[0];
}

async function listRouteMonitorEvents(assignmentId, { limit = 50 } = {}) {
  const res = await query(
    `SELECT * FROM route_monitor_events
     WHERE assignment_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [assignmentId, limit]
  );
  return res.rows;
}

module.exports = {
  insertRouteMonitorEvent,
  listRouteMonitorEvents,
};
