/**
 * Driver-group routes that are about the GROUP rather than its profile:
 *
 *   - the driver-group list for the admin's targeting pickers (Messages →
 *     Send Message, Scheduled);
 *   - whether Samsara alerts are also posted to one driver group (Driver
 *     Groups → driver details). docs/architecture/samsara-driver-group-alerts.md
 *     has the rules; the Samsara service is what reads the switch.
 *
 * The rest of this file — the old group list, the driver-list, manual
 * status / language / birthday writes and the "run AI status check now"
 * trigger — was removed on 2026-10-30: no screen called any of it. A driver's
 * language, birthday and status are edited on the Driver Groups popup through
 * `/api/driver-profiles/:id`, which copies them onto the group
 * (`database/driverProfiles.js` `syncGroupFromDriverProfile`), and the AI
 * status check keeps its twice-daily schedule (`group_status_ai`).
 *
 * Routes use their full paths; the router is mounted at the app root, AFTER
 * the group-members router (which only defines /api/groups/:groupId/members).
 */
const express = require('express');
const defaultSamsaraAlerts = require('../../database/samsaraDriverGroupAlerts');
const { insertAdminAudit: defaultInsertAdminAudit } = require('../../database/adminAudit');

function createDriverGroupsRoutes({
  db, authMiddleware,
  samsaraAlerts = defaultSamsaraAlerts,
  insertAdminAudit = defaultInsertAdminAudit,
}) {
  const router = express.Router();

  // GET /api/groups/manage — all driver groups (active + inactive) for admin manage UI
  router.get('/api/groups/manage', authMiddleware, async (req, res) => {
    try {
      const groups = await db.getDriverGroupsByActiveFilter('all');
      res.json(groups);
    } catch (err) {
      console.error('[API] Error fetching manage groups:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/groups/samsara-driver-alerts/status — does the running Samsara
  // service honour the switch? The screen says "not applied yet" until it does.
  router.get('/api/groups/samsara-driver-alerts/status', authMiddleware, async (req, res) => {
    const status = await samsaraAlerts.getSamsaraSwitchEnforcement();
    res.json({ enforced: status.enforced === true, last_beat_at: status.lastBeatAt || null });
  });

  // PUT /api/groups/:groupId/samsara-driver-alerts — { enabled: true|false }
  router.put('/api/groups/:groupId/samsara-driver-alerts', authMiddleware, async (req, res) => {
    const groupId = Number(req.params.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      return res.status(400).json({ error: 'Invalid group id' });
    }
    const enabled = req.body?.enabled;
    // Strictly a boolean: "false" as a string is truthy, and reading it as ON
    // would quietly keep posting to a group somebody just switched off.
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be true or false' });
    }
    try {
      const result = await samsaraAlerts.setSamsaraDriverAlertsEnabled(groupId, enabled);
      if (result.status === 'not_found') {
        return res.status(404).json({ error: 'Group not found' });
      }
      if (result.status === 'not_driver') {
        return res.status(409).json({ error: 'Samsara alerts are only ever posted to driver groups; this chat is not one' });
      }
      await insertAdminAudit({
        adminId: req.admin?.id ?? null,
        roleKeys: req.admin?.roleKeys || [],
        action: 'samsara_driver_alerts.update',
        entityType: 'group',
        entityId: String(groupId),
        oldValues: { samsara_driver_alerts_enabled: result.previous },
        newValues: { samsara_driver_alerts_enabled: result.enabled },
        ipAddress: req.ip || null,
      }).catch((err) => console.warn('[API] Could not audit the Samsara driver-alerts switch:', err.message));
      console.log(
        `[API] Samsara alerts to driver group ${groupId} switched ${result.enabled ? 'ON' : 'OFF'}`
        + ` by ${req.admin?.username || req.admin?.id || 'unknown'}`,
      );
      // The answer says whether the Samsara service applies it yet, so the
      // screen never reports "not posted" while it still is.
      const enforcement = await samsaraAlerts.getSamsaraSwitchEnforcement();
      return res.json({
        group_id: result.groupId,
        samsara_driver_alerts_enabled: result.enabled,
        enforced: enforcement.enforced === true,
      });
    } catch (err) {
      console.error('[API] Error switching Samsara driver-group alerts:', err.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { createDriverGroupsRoutes };
