'use strict';

/**
 * Whether Samsara alerts are ALSO posted to one driver's own Telegram group.
 *
 * The column is `groups.samsara_driver_alerts_enabled` (migration 0090). The
 * Samsara service reads it just before it posts to a driver group; this
 * process only writes it, from Driver Groups → driver details. The rules are
 * in docs/architecture/samsara-driver-group-alerts.md.
 *
 * Only a DRIVER group can be switched: it is the only kind of chat the Samsara
 * service ever routes an alert to, so a switch on any other chat would be a
 * control that does nothing.
 */
const { query } = require('./pool');
const { forgetGroupRows } = require('./groupRowCache');

/**
 * Switch the driver-group copy of Samsara alerts on or off for one group.
 *
 * @param {number} groupId  `groups.id` (not the Telegram chat id)
 * @param {boolean} enabled
 * @returns {Promise<{status: 'ok', groupId: number, groupName: string|null, previous: boolean, enabled: boolean}
 *                  |{status: 'not_found'}|{status: 'not_driver', groupType: string|null}>}
 */
async function setSamsaraDriverAlertsEnabled(groupId, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');

  // The previous value comes from the same statement, so the audit row says
  // what was actually replaced even when two people press at once.
  const res = await query(
    `WITH before AS (
       SELECT id, samsara_driver_alerts_enabled AS previous
         FROM groups
        WHERE id = $1 AND group_type = 'driver'
        FOR UPDATE
     )
     UPDATE groups g
        SET samsara_driver_alerts_enabled = $2
       FROM before b
      WHERE g.id = b.id
     RETURNING g.id, g.group_name, b.previous, g.samsara_driver_alerts_enabled AS enabled`,
    [groupId, enabled]
  );

  if (res.rows.length > 0) {
    forgetGroupRows();
    const row = res.rows[0];
    return {
      status: 'ok',
      groupId: Number(row.id),
      groupName: row.group_name || null,
      previous: row.previous !== false,
      enabled: row.enabled !== false,
    };
  }

  const other = await query('SELECT group_type FROM groups WHERE id = $1', [groupId]);
  if (other.rows.length === 0) return { status: 'not_found' };
  return { status: 'not_driver', groupType: other.rows[0].group_type || null };
}

module.exports = { setSamsaraDriverAlertsEnabled };
