/**
 * Driver ETA delivery — which groups get automatic ETA updates, and how often.
 *
 * WHAT THIS FILE USED TO BE. `dispatchRoutes.js`, serving the Dispatch Center:
 * a rate-confirmation parser, a "send this load to a driver" button, and these
 * ETA schedules sharing a page with them because they both said "dispatch". The
 * first two are gone — see `docs/architecture/retired-dispatch-center.md`.
 *
 * THESE FOUR PATHS ARE UNCHANGED, deliberately down to the string. They are the
 * ONLY way per-group ETA updates and the global intervals can be configured, so
 * a rename would have turned a UI removal into a data change: settings editable
 * only by hand in the database. The mount point stays `/api/dispatch` for the
 * same reason.
 */
const express = require('express');
const config = require('../../config/config');
const db = require('../../database/db');
const { triggerDispatchEtaNowByGroupId } = require('../../services/dispatchEtaUpdateService');

const router = express.Router();

function toBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return defaultValue;
}

function parseIntervalMinutes(body, fallback = 60) {
  if (Number.isInteger(body?.intervalMinutes)) {
    return body.intervalMinutes;
  }

  const parsedInterval = Number.parseInt(body?.intervalMinutes, 10);
  if (Number.isInteger(parsedInterval) && !Number.isNaN(parsedInterval)) {
    return parsedInterval;
  }

  const parsedHours = Number.parseInt(body?.hours, 10);
  const parsedMinutes = Number.parseInt(body?.minutes, 10);
  if (Number.isInteger(parsedHours) || Number.isInteger(parsedMinutes)) {
    const safeHours = Number.isInteger(parsedHours) && parsedHours > 0 ? parsedHours : 0;
    const safeMinutes = Number.isInteger(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes : 0;
    return safeHours * 60 + safeMinutes;
  }

  return fallback;
}

function mapEtaRow(row) {
  const normalizeEtaEnabled = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    if (typeof value === 'number') return value === 1;
    return false;
  };
  const targetMode = String(row?.eta_target_mode ?? row?.target_mode ?? 'driver').trim().toLowerCase() === 'test'
    ? 'test'
    : 'driver';
  const interval = Number(row?.eta_interval_minutes ?? row?.interval_minutes ?? 60) || 60;
  return {
    group_id: row.group_id ?? row.id,
    group_name: row.group_name,
    telegram_group_id: row.telegram_group_id,
    eta_enabled: normalizeEtaEnabled(row.eta_enabled ?? row.enabled),
    eta_target_mode: targetMode,
    eta_enabled_driver: normalizeEtaEnabled(row.eta_enabled ?? row.enabled) && targetMode === 'driver',
    eta_enabled_test: normalizeEtaEnabled(row.eta_enabled ?? row.enabled) && targetMode === 'test',
    eta_interval_minutes: interval,
    eta_interval_hours: Math.floor(interval / 60),
    eta_interval_remaining_minutes: interval % 60,
    eta_next_run_at: row.eta_next_run_at ?? row.next_run_at ?? null,
    eta_last_run_at: row.eta_last_run_at ?? row.last_run_at ?? null,
    eta_last_status: row.eta_last_status ?? row.last_status ?? null,
    eta_last_error: row.eta_last_error ?? row.last_error ?? null,
  };
}

router.get('/testing-feature/groups', async (req, res) => {
  try {
    const rows = await db.getDriverGroupsWithDispatchEtaSettings();
    const globalSettings = await db.getDispatchEtaGlobalSettings();
    return res.json({
      dispatchEtaTestGroupId: config.dispatchEtaTestGroupId || '',
      globalDriverIntervalMinutes: Number(globalSettings.driver_interval_minutes) || 60,
      globalTestIntervalMinutes: Number(globalSettings.test_interval_minutes) || 60,
      groups: rows.map(mapEtaRow),
    });
  } catch (err) {
    console.error('[API] Dispatch ETA groups fetch failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch testing feature groups' });
  }
});

router.put('/testing-feature/global-intervals', async (req, res) => {
  try {
    const current = await db.getDispatchEtaGlobalSettings();
    const driverM = parseIntervalMinutes(
      { intervalMinutes: req.body?.driverIntervalMinutes },
      Number(current.driver_interval_minutes) || 60
    );
    const testM = parseIntervalMinutes(
      { intervalMinutes: req.body?.testIntervalMinutes },
      Number(current.test_interval_minutes) || 60
    );
    if (!Number.isInteger(driverM) || driverM < 1 || driverM > 1440
      || !Number.isInteger(testM) || testM < 1 || testM > 1440) {
      return res.status(400).json({ error: 'Each interval must be between 1 and 1440 minutes' });
    }
    await db.setDispatchEtaGlobalIntervals(driverM, testM);
    await db.applyDispatchEtaIntervalsFromGlobals();
    return res.json({
      success: true,
      globalDriverIntervalMinutes: driverM,
      globalTestIntervalMinutes: testM,
    });
  } catch (err) {
    console.error('[API] Dispatch ETA global intervals failed:', err.message);
    return res.status(500).json({ error: 'Failed to save global ETA intervals', detail: err.message });
  }
});

router.put('/testing-feature/groups/toggle-all', async (req, res) => {
  try {
    const enabled = toBoolean(req.body?.enabled, false);
    const requestedMode = String(req.body?.targetMode || req.body?.etaTargetMode || 'driver')
      .trim()
      .toLowerCase();
    const targetMode = requestedMode === 'test' ? 'test' : 'driver';
    if (enabled && targetMode === 'test' && !config.dispatchEtaTestGroupId) {
      return res.status(400).json({ error: 'DISPATCH_ETA_TEST_GROUP_ID is not configured on the server' });
    }

    const groups = await db.getAllDriverGroups();
    if (!groups.length) {
      return res.json({ success: true, updatedCount: 0, groups: [] });
    }

    const globals = await db.getDispatchEtaGlobalSettings();
    const savedRows = [];
    let immediateSuccess = 0;
    let immediateFailed = 0;
    for (const group of groups) {
      const existing = await db.getDispatchEtaSettingByGroupId(group.id);
      const modeDefault = targetMode === 'test'
        ? globals.test_interval_minutes
        : globals.driver_interval_minutes;
      const intervalMinutes = parseIntervalMinutes(
        req.body,
        Number.isInteger(existing?.interval_minutes) ? existing.interval_minutes : modeDefault
      );
      if (enabled && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440)) {
        return res.status(400).json({ error: 'Interval must be between 1 and 1440 minutes' });
      }
      const saved = await db.upsertDispatchEtaSetting({
        groupId: group.id,
        enabled,
        targetMode,
        intervalMinutes: Number.isInteger(intervalMinutes) ? intervalMinutes : (existing?.interval_minutes || 60),
        nextRunAt: enabled ? new Date().toISOString() : null,
      });
      savedRows.push(mapEtaRow({ ...group, ...saved, group_id: group.id }));

      if (enabled) {
        const immediate = await triggerDispatchEtaNowByGroupId(group.id);
        if (immediate?.success) immediateSuccess += 1;
        else immediateFailed += 1;
      }
    }

    return res.json({
      success: true,
      updatedCount: savedRows.length,
      immediate: enabled ? { success: immediateSuccess, failed: immediateFailed } : null,
      groups: savedRows,
    });
  } catch (err) {
    console.error('[API] Dispatch ETA bulk update failed:', err.message);
    return res.status(500).json({ error: 'Failed to update all testing feature settings', detail: err.message });
  }
});

router.put('/testing-feature/groups/:groupId', async (req, res) => {
  const groupId = Number.parseInt(req.params.groupId, 10);
  if (!Number.isInteger(groupId) || groupId <= 0) {
    return res.status(400).json({ error: 'Invalid groupId' });
  }

  try {
    const targetGroups = await db.getGroupsByIds([groupId]);
    if (!targetGroups.length) {
      return res.status(404).json({ error: 'Active driver group not found' });
    }

    const existing = await db.getDispatchEtaSettingByGroupId(groupId);
    const enabledDriver = toBoolean(req.body?.enabledDriver, false);
    const enabledTest = toBoolean(req.body?.enabledTest, false);
    const hasSplitTogglePayload = Object.prototype.hasOwnProperty.call(req.body || {}, 'enabledDriver')
      || Object.prototype.hasOwnProperty.call(req.body || {}, 'enabledTest');
    let enabled = toBoolean(req.body?.enabled, Boolean(existing?.enabled));
    let targetMode = String(existing?.target_mode || 'driver').trim().toLowerCase() === 'test' ? 'test' : 'driver';

    if (hasSplitTogglePayload) {
      if (enabledTest && !config.dispatchEtaTestGroupId) {
        return res.status(400).json({ error: 'DISPATCH_ETA_TEST_GROUP_ID is not configured on the server' });
      }
      if (enabledDriver && enabledTest) {
        targetMode = 'test';
        enabled = true;
      } else if (enabledTest) {
        targetMode = 'test';
        enabled = true;
      } else if (enabledDriver) {
        targetMode = 'driver';
        enabled = true;
      } else {
        enabled = false;
      }
    } else if (enabled) {
      const requestedTargetMode = String(req.body?.targetMode || req.body?.etaTargetMode || targetMode)
        .trim()
        .toLowerCase();
      targetMode = requestedTargetMode === 'test' ? 'test' : 'driver';
      if (targetMode === 'test' && !config.dispatchEtaTestGroupId) {
        return res.status(400).json({ error: 'DISPATCH_ETA_TEST_GROUP_ID is not configured on the server' });
      }
    }
    const globals = await db.getDispatchEtaGlobalSettings();
    const modeDefault = targetMode === 'test'
      ? globals.test_interval_minutes
      : globals.driver_interval_minutes;
    const intervalMinutes = parseIntervalMinutes(
      req.body,
      Number.isInteger(existing?.interval_minutes) ? existing.interval_minutes : modeDefault
    );

    if (enabled && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440)) {
      return res.status(400).json({ error: 'Interval must be between 1 and 1440 minutes' });
    }

    const saved = await db.upsertDispatchEtaSetting({
      groupId,
      enabled,
      targetMode,
      intervalMinutes: Number.isInteger(intervalMinutes) ? intervalMinutes : (existing?.interval_minutes || 60),
      nextRunAt: enabled ? new Date().toISOString() : null,
    });

    let immediate = null;
    if (enabled) {
      immediate = await triggerDispatchEtaNowByGroupId(groupId);
    }

    const refreshed = await db.getDispatchEtaSettingByGroupId(groupId);
    const groupRow = targetGroups[0];
    const responseRow = mapEtaRow({
      group_id: groupRow.id,
      ...groupRow,
      ...refreshed,
    });

    return res.json({
      success: true,
      setting: responseRow,
      immediate,
    });
  } catch (err) {
    console.error('[API] Dispatch ETA update failed:', err.message);
    return res.status(500).json({ error: 'Failed to update testing feature setting', detail: err.message });
  }
});

module.exports = router;
