'use strict';

/**
 * A driver's own home-time rule (migration 0103): "3 weeks on the road, 3 days
 * home" in place of the company's 28 / 4, optionally until a date. Set by
 * anyone with access on Home Time → Settings & Alerts; read by the violation
 * pass (lib/homeTime/ownViolations.js `ruleFor`). One per driver group at a
 * time; removing one keeps the row (`removed_at`) so what applied when can be
 * told afterwards.
 */

const { query } = require('../pool');

const UNDEFINED_TABLE = '42P01';

function mapException(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    groupId: Number(row.group_id),
    groupName: row.group_name || null,
    roadDays: row.road_days == null ? null : Number(row.road_days),
    homeDays: row.home_days == null ? null : Number(row.home_days),
    validUntil: row.valid_until ? new Date(row.valid_until).toISOString().slice(0, 10) : null,
    note: row.note || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
  };
}

async function listActiveExceptions() {
  try {
    const res = await query(
      `SELECT e.*, g.group_name FROM home_time_policy_exceptions e
         JOIN groups g ON g.id = e.group_id
        WHERE e.removed_at IS NULL
        ORDER BY g.group_name`,
    );
    return res.rows.map(mapException);
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

/** Set (or replace) a driver group's rule. */
async function setException({
  groupId, roadDays = null, homeDays = null, validUntil = null, note = null,
}, createdBy = null) {
  await query('UPDATE home_time_policy_exceptions SET removed_at = NOW() WHERE group_id = $1 AND removed_at IS NULL', [Number(groupId)]);
  const res = await query(
    `INSERT INTO home_time_policy_exceptions (group_id, road_days, home_days, valid_until, note, created_by)
     VALUES ($1, $2, $3, $4::date, $5, $6) RETURNING *`,
    [Number(groupId), roadDays, homeDays, validUntil || null, note || null, createdBy],
  );
  return mapException(res.rows[0]);
}

async function removeException(id) {
  const res = await query(
    'UPDATE home_time_policy_exceptions SET removed_at = NOW() WHERE id = $1 AND removed_at IS NULL RETURNING id',
    [Number(id)],
  );
  return res.rowCount > 0;
}

/** The driver groups a rule can be set for, by name, with the driver's name. */
async function listDriverGroups() {
  const res = await query(
    `SELECT g.id, g.group_name,
            NULLIF(TRIM(CONCAT(dp.first_name, ' ', dp.last_name)), '') AS driver_name, dp.driver_type
       FROM groups g
       LEFT JOIN driver_profiles dp ON dp.group_id = g.id
      WHERE g.group_type = 'driver' AND g.active IS NOT FALSE
      ORDER BY g.group_name`,
  );
  return res.rows.map((r) => ({
    id: Number(r.id), name: r.group_name, driverName: r.driver_name || null, driverType: r.driver_type || null,
  }));
}

module.exports = {
  listActiveExceptions, setException, removeException, listDriverGroups,
};
