'use strict';

/**
 * What the race boards need to show today's birthdays again after a restart
 * (services/grossRace/birthdayRestore.js), and a driver's truck at the moment
 * their wish goes out (services/birthdayService.js). Read once per restart and
 * once per driver birthday — never per board poll.
 */
const { query } = require('./pool');

/**
 * The birthday posts that went out in the last day, by the keys the birthday
 * services write: `employee:<day>:<id>:sent` (written after the card was
 * posted) and `driver:<groupId>:<day>` (the per-group claim). How long ago each
 * was written comes from the database's own clock, so the zone `ran_at` was
 * stored in does not matter.
 */
async function getRecentBirthdaySends() {
  const res = await query(
    `SELECT run_key, EXTRACT(EPOCH FROM (NOW()::timestamp - ran_at)) AS age_seconds
       FROM service_runs
      WHERE service_name = 'birthday'
        AND ran_at > NOW()::timestamp - INTERVAL '24 hours'
        AND (run_key LIKE 'employee:%:sent' OR run_key LIKE 'driver:%')`
  );
  return res.rows.map((r) => ({ runKey: r.run_key, ageSeconds: Number(r.age_seconds) }));
}

/** The names a card prints, for these employees. */
async function getEmployeesForCards(ids) {
  if (!ids || !ids.length) return [];
  const res = await query(
    'SELECT id, first_name, last_name, american_name FROM employee_birthdays WHERE id = ANY($1::int[])',
    [ids]
  );
  return res.rows;
}

/** Each driver chat's title and the truck number on its profile. */
async function getDriverFaces(groupIds) {
  if (!groupIds || !groupIds.length) return [];
  const res = await query(
    `SELECT g.id, g.group_name, dp.unit_number
       FROM groups g LEFT JOIN driver_profiles dp ON dp.group_id = g.id
      WHERE g.id = ANY($1::int[])`,
    [groupIds]
  );
  return res.rows;
}

module.exports = { getRecentBirthdaySends, getEmployeesForCards, getDriverFaces };
