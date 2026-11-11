'use strict';

/**
 * The home/road cycles the violation pass judges (lib/homeTime/ownViolations.js):
 * every driver group's `driver_road_history` rows since a date, with the
 * driver's type and whether the stay was linked to an approved request.
 * Read only.
 */

const { query } = require('../pool');

/** @returns {Promise<Map<number, object[]>>} cycles by driver group */
async function listCyclesByGroup(sinceIso) {
  const res = await query(
    `SELECT h.group_id, h.road_started_at, h.home_arrived_at, h.return_to_road_at,
            COALESCE(NULLIF(TRIM(CONCAT(dp.first_name, ' ', dp.last_name)), ''), h.driver_name, g.group_name) AS driver_name,
            dp.driver_type, req.status AS linked_request_status
       FROM driver_road_history h
       JOIN groups g ON g.id = h.group_id
       LEFT JOIN driver_profiles dp ON dp.group_id = h.group_id
       LEFT JOIN home_time_requests req ON req.id = h.linked_request_id
      WHERE h.home_arrived_at >= $1::timestamptz
      ORDER BY h.group_id, h.home_arrived_at`,
    [sinceIso],
  );
  const byGroup = new Map();
  for (const r of res.rows) {
    const id = Number(r.group_id);
    if (!byGroup.has(id)) byGroup.set(id, []);
    byGroup.get(id).push({
      roadStartedAt: r.road_started_at,
      homeArrivedAt: r.home_arrived_at,
      returnToRoadAt: r.return_to_road_at,
      driverName: r.driver_name,
      driverType: r.driver_type,
      linkedRequestStatus: r.linked_request_status,
    });
  }
  return byGroup;
}

module.exports = { listCyclesByGroup };
