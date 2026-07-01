const express = require('express');
const db = require('../../database/db');
const { listCanonicalDriverGroups } = require('../../services/driverGroupDirectoryService');
const { sendManualFuelReminder, refreshFuelStopsFromInbox } = require('../../services/fuelStopAlertService');

/**
 * Fuel Monitor admin API.
 *  - GET  /                      → active company drivers + watched fuel stops
 *
 * The driver's Telegram identity (username + numeric user id) is NOT edited
 * here anymore: Driver Groups (driver_profiles) is the single source of
 * truth, set from the member dropdown in the Driver Groups popup.
 */
function createFuelMonitorRouter({ authMiddleware, telegram }) {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    try {
      // Keep driver_profiles seeded/fresh, same as the driver-profiles route.
      await db.listDriverProfiles({ includeInactive: true });
      const rows = await listCanonicalDriverGroups({ operational: true, includeNonDrivers: false });

      // Active company drivers only — the Driver Groups source of truth.
      const drivers = rows
        .filter((r) => r.group_type === 'driver'
          && !r.inactive
          && r.driver_type === 'company_driver'
          && r.operational_visible !== false)
        .map((r) => ({
          group_id: r.group_id,
          group_name: r.group_name,
          telegram_group_id: r.telegram_group_id,
          display_name: r.display_name || r.full_name || r.group_name || null,
          unit_number: r.unit_number || null,
          telegram_username: r.telegram_username || null,
        }));

      // Attach a small "currently watching" summary per group.
      const active = await db.listActiveFuelStopAlerts().catch(() => []);
      const watchingByGroup = new Map();
      for (const a of active) {
        const list = watchingByGroup.get(Number(a.group_id)) || [];
        list.push({
          id: a.id,
          station_name: a.station_name,
          station_address: a.station_address,
          radius_miles: a.radius_miles,
          last_distance_miles: a.last_distance_miles,
          eta_minutes: a.eta_minutes,
          eta_boundary_at: a.eta_boundary_at,
          next_check_at: a.next_check_at,
          created_at: a.created_at,
        });
        watchingByGroup.set(Number(a.group_id), list);
      }
      for (const d of drivers) {
        d.watching = watchingByGroup.get(Number(d.group_id)) || [];
      }

      res.json({ drivers });
    } catch (err) {
      console.error('[FUEL-MONITOR API] list failed:', err.message);
      res.status(500).json({ error: 'Failed to load fuel monitor data' });
    }
  });

  // Re-scan the fuel-message inbox: retry detection on pending rows from the
  // last 24 h. Returns { scanned, picked_up } shown in the admin banner.
  router.post('/refresh', authMiddleware, async (req, res) => {
    try {
      const result = await refreshFuelStopsFromInbox(telegram);
      res.json({ scanned: result.scanned, picked_up: result.pickedUp });
    } catch (err) {
      console.error('[FUEL-MONITOR API] refresh failed:', err.message);
      res.status(500).json({ error: 'Failed to refresh fuel monitor inbox' });
    }
  });

  // Manually send the fuel reminder to a driver's group now. The automatic
  // 10-mile reminder still fires later (this does not change the watch status).
  router.post('/:groupId/send-reminder', authMiddleware, async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Invalid group id' });
      }
      const result = await sendManualFuelReminder(groupId);
      if (!result.sent) {
        return res.status(400).json({
          error: 'No active fuel stop for this driver to remind about.',
        });
      }
      res.json({ sent: true, station_name: result.station_name || null });
    } catch (err) {
      console.error('[FUEL-MONITOR API] send reminder failed:', err.message);
      res.status(500).json({ error: 'Failed to send reminder' });
    }
  });

  return router;
}

module.exports = { createFuelMonitorRouter };
