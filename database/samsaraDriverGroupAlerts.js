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
const { getRun } = require('./backgroundRuns');

/** The Samsara service's heartbeat row in `background_service_runs`. */
const SAMSARA_HEARTBEAT_KEY = 'samsara_safety_pipeline';

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

/**
 * Does the RUNNING Samsara service actually honour the switch?
 *
 * The switch is stored here and enforced there, and the two deploy separately.
 * Saying "not posted here" while an older build of the Samsara service is still
 * posting would be worse than having no switch: a person would rely on it. So
 * the screen asks the service itself — every heartbeat it writes carries
 * `driverGroupSwitch: true` from the build that enforces it — and says "not
 * applied yet" until the latest one does. A rolled-back service stops saying
 * it, and the screen follows.
 *
 * @returns {Promise<{enforced: boolean, lastBeatAt: string|null}>}
 *   `enforced` is false when the service has never reported, its last report
 *   lacks the capability, or the row could not be read.
 */
async function getSamsaraSwitchEnforcement(readRun = getRun) {
  const row = await Promise.resolve(readRun(SAMSARA_HEARTBEAT_KEY)).catch(() => null);
  return {
    enforced: row?.lastSummary?.driverGroupSwitch === true,
    lastBeatAt: row?.lastFinishedAt || null,
  };
}

module.exports = { setSamsaraDriverAlertsEnabled, getSamsaraSwitchEnforcement };
