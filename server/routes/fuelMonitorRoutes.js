const express = require('express');
const db = require('../../database/db');
const { listCanonicalDriverGroups } = require('../../services/driverGroupDirectoryService');

// Telegram handles: 5–32 chars of [a-z0-9_]. We accept an optional leading '@'
// and store it normalized (lowercase, no '@') via db.setDriverTelegramUsername.
const USERNAME_RE = /^@?[A-Za-z0-9_]{3,32}$/;

/**
 * Fuel Monitor admin API.
 *  - GET  /                      → active company drivers + saved usernames
 *  - PUT  /:groupId/username     → set/clear a driver's Telegram username
 */
function createFuelMonitorRouter({ authMiddleware }) {
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

  router.put('/:groupId/username', authMiddleware, async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Invalid group id' });
      }
      const raw = req.body?.telegram_username;
      // Allow empty string / null to clear the username.
      const isClear = raw == null || String(raw).trim() === '';
      if (!isClear && !USERNAME_RE.test(String(raw).trim())) {
        return res.status(400).json({
          error: 'Username must be 3–32 characters: letters, numbers, or underscore.',
        });
      }

      const updated = await db.setDriverTelegramUsername(groupId, isClear ? null : raw);
      if (!updated) {
        return res.status(404).json({ error: 'Driver profile not found for this group' });
      }
      res.json({
        group_id: groupId,
        telegram_username: updated.telegram_username || null,
      });
    } catch (err) {
      console.error('[FUEL-MONITOR API] update username failed:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { createFuelMonitorRouter };
