const express = require('express');
const db = require('../../database/db');
const monitorsDb = require('../../database/driverLocationMonitors');
const {
  triggerMonitorNowByGroupId,
} = require('../../services/driverLocationMonitorService');

const DEFAULT_INTERVAL_MIN = 30;
const DEFAULT_RADIUS_MILES = 8;

function toBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return defaultValue;
}

function parseInterval(value, fallback = DEFAULT_INTERVAL_MIN) {
  const n = Number.parseInt(value, 10);
  if (Number.isInteger(n) && n >= 1 && n <= 1440) return n;
  return fallback;
}

function parseRadius(value, fallback = DEFAULT_RADIUS_MILES) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1 && n <= 100) return n;
  return fallback;
}

function mapRow(row) {
  const driverName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return {
    group_id: row.group_id ?? row.id,
    group_name: row.group_name,
    telegram_group_id: row.telegram_group_id,
    driver_name: driverName || null,
    unit_number: row.unit_number || null,
    driver_type: row.driver_type || null,
    enabled: row.enabled === true,
    interval_minutes: Number(row.interval_minutes) || DEFAULT_INTERVAL_MIN,
    checkin_radius_miles: Number(row.checkin_radius_miles) || DEFAULT_RADIUS_MILES,
    next_run_at: row.next_run_at || null,
    last_run_at: row.last_run_at || null,
    last_status: row.last_status || null,
    last_error: row.last_error || null,
    load_phase: row.load_phase || null,
    target_stop_type: row.target_stop_type || null,
    target_address: row.target_address || null,
    target_appointment_at: row.target_appointment_at || null,
    last_eta_minutes: row.last_eta_minutes != null ? Number(row.last_eta_minutes) : null,
    last_eta_at: row.last_eta_at || null,
    last_distance_miles: row.last_distance_miles != null ? Number(row.last_distance_miles) : null,
    current_order_id: row.current_order_id || null,
  };
}

/**
 * Driver Location Monitoring admin API.
 *  - GET  /                      → active driver groups + monitor settings + stats
 *  - PUT  /:groupId              → enable/disable + interval/radius (+ immediate check)
 *  - PUT  /toggle-all            → bulk enable/disable
 *  - GET  /:groupId/checkins     → recent check-in history for a group
 */
function createLocationMonitorRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const rows = await monitorsDb.listGroupsWithMonitorSettings();
      const mapped = rows.map(mapRow);
      // Attach a small on-time summary per group.
      for (const row of mapped) {
        try {
          const stats = await monitorsDb.getCheckinStatsForGroup(row.group_id);
          row.stats = {
            answered: Number(stats.answered) || 0,
            checked_in: Number(stats.checked_in) || 0,
            not_checked_in: Number(stats.not_checked_in) || 0,
            on_time: Number(stats.on_time) || 0,
            late: Number(stats.late) || 0,
          };
        } catch (_) {
          row.stats = { answered: 0, checked_in: 0, not_checked_in: 0, on_time: 0, late: 0 };
        }
      }
      res.json({ groups: mapped });
    } catch (err) {
      console.error('[LOCATION-MONITOR API] list failed:', err.message);
      res.status(500).json({ error: 'Failed to load location monitor data' });
    }
  });

  router.put('/toggle-all', authMiddleware, async (req, res) => {
    try {
      const enabled = toBoolean(req.body?.enabled, false);
      const interval = parseInterval(req.body?.intervalMinutes);
      const radius = parseRadius(req.body?.checkinRadiusMiles);

      const groups = await db.getAllDriverGroups();
      if (!groups.length) {
        return res.json({ success: true, updatedCount: 0, groups: [] });
      }

      let immediateOk = 0;
      let immediateFailed = 0;
      for (const group of groups) {
        await monitorsDb.upsertMonitorSetting({
          groupId: group.id,
          enabled,
          intervalMinutes: interval,
          checkinRadiusMiles: radius,
          nextRunAt: enabled ? new Date().toISOString() : null,
        });
        if (enabled) {
          const immediate = await triggerMonitorNowByGroupId(group.id);
          if (immediate?.triggered && immediate?.ok !== false) immediateOk += 1;
          else immediateFailed += 1;
        }
      }

      const rows = await monitorsDb.listGroupsWithMonitorSettings();
      res.json({
        success: true,
        updatedCount: groups.length,
        immediate: enabled ? { success: immediateOk, failed: immediateFailed } : null,
        groups: rows.map(mapRow),
      });
    } catch (err) {
      console.error('[LOCATION-MONITOR API] toggle-all failed:', err.message);
      res.status(500).json({ error: 'Failed to update all location monitors', detail: err.message });
    }
  });

  router.put('/:groupId', authMiddleware, async (req, res) => {
    const groupId = Number.parseInt(req.params.groupId, 10);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      return res.status(400).json({ error: 'Invalid groupId' });
    }
    try {
      const target = await db.getGroupsByIds([groupId]);
      if (!target.length) {
        return res.status(404).json({ error: 'Active driver group not found' });
      }

      const existing = await monitorsDb.getMonitorByGroupId(groupId);
      const enabled = toBoolean(req.body?.enabled, Boolean(existing?.enabled));
      const interval = parseInterval(
        req.body?.intervalMinutes,
        Number.isInteger(existing?.interval_minutes) ? existing.interval_minutes : DEFAULT_INTERVAL_MIN
      );
      const radius = parseRadius(
        req.body?.checkinRadiusMiles,
        Number.isFinite(Number(existing?.checkin_radius_miles)) ? Number(existing.checkin_radius_miles) : DEFAULT_RADIUS_MILES
      );

      await monitorsDb.upsertMonitorSetting({
        groupId,
        enabled,
        intervalMinutes: interval,
        checkinRadiusMiles: radius,
        nextRunAt: enabled ? new Date().toISOString() : null,
      });

      let immediate = null;
      if (enabled) {
        immediate = await triggerMonitorNowByGroupId(groupId);
      }

      const rows = await monitorsDb.listGroupsWithMonitorSettings();
      const refreshed = rows.find((r) => Number(r.group_id) === groupId);
      res.json({
        success: true,
        setting: refreshed ? mapRow(refreshed) : null,
        immediate,
      });
    } catch (err) {
      console.error('[LOCATION-MONITOR API] update failed:', err.message);
      res.status(500).json({ error: 'Failed to update location monitor', detail: err.message });
    }
  });

  router.get('/:groupId/checkins', authMiddleware, async (req, res) => {
    const groupId = Number.parseInt(req.params.groupId, 10);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      return res.status(400).json({ error: 'Invalid groupId' });
    }
    try {
      const limit = Number.parseInt(req.query?.limit, 10);
      const checkins = await monitorsDb.listCheckinsForGroup(groupId, Number.isInteger(limit) ? limit : 50);
      const stats = await monitorsDb.getCheckinStatsForGroup(groupId);
      res.json({
        checkins: checkins.map((c) => ({
          id: c.id,
          stop_type: c.stop_type,
          location_address: c.location_address,
          appointment_at: c.appointment_at,
          eta_at: c.eta_at,
          distance_miles_at_prompt: c.distance_miles_at_prompt != null ? Number(c.distance_miles_at_prompt) : null,
          status: c.status,
          driver_response: c.driver_response,
          responded_by_username: c.responded_by_username,
          responded_at: c.responded_at,
          on_time: c.on_time,
          created_at: c.created_at,
        })),
        stats: {
          answered: Number(stats.answered) || 0,
          checked_in: Number(stats.checked_in) || 0,
          not_checked_in: Number(stats.not_checked_in) || 0,
          on_time: Number(stats.on_time) || 0,
          late: Number(stats.late) || 0,
        },
      });
    } catch (err) {
      console.error('[LOCATION-MONITOR API] checkins failed:', err.message);
      res.status(500).json({ error: 'Failed to load check-in history' });
    }
  });

  return router;
}

module.exports = { createLocationMonitorRouter };
