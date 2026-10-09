/**
 * Route monitor EVENT LOG — database helpers.
 *
 * The per-assignment audit trail of monitoring checks and notifications, read
 * by the admin Route Control page.
 *
 * Split out of database/routeControl.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

const INSERT_EVENT_SQL = `INSERT INTO route_monitor_events
       (assignment_id, event_type, result, latitude, longitude, deviation_meters, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`;

function eventValues({
  assignmentId, eventType, result, latitude, longitude, deviationMeters, detail,
}) {
  return [
    assignmentId, eventType, result || null,
    latitude ?? null, longitude ?? null, deviationMeters ?? null, detail || null,
  ];
}

/** Log an event and hand back the stored row. */
async function insertRouteMonitorEvent(event) {
  const res = await query(`${INSERT_EVENT_SQL} RETURNING *`, eventValues(event));
  return res.rows[0];
}

/**
 * The monitor tick's variant: the same row, and nothing read back. Every
 * caller of the original ignores what it returns; the tick logs one event per
 * tracked route every pass, so the echo was paid hundreds of times a day.
 */
async function recordRouteMonitorEvent(event) {
  await query(INSERT_EVENT_SQL, eventValues(event));
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
  recordRouteMonitorEvent,
  listRouteMonitorEvents,
};
