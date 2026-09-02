/**
 * Home-Time TRACKER admin API: the overview, the efficiency report, and manual
 * edits to a driver's state or a completed trip.
 *
 * The overview is the panel's main screen — current state per group joined to
 * the driver directory. The edit endpoints move the clock a manager sees, so
 * each validates its dates before writing rather than trusting the panel.
 *
 * Split out of server/routes/homeTimeRoutes.js.
 */

const express = require('express');
const { DateTime } = require('luxon');
const ht = require('../../../database/homeTime');
const {
  homeTimePolicyApplies, computeNextEligibleHomeTime, computeRoadBonus, wholeDaysBetween,
} = require('../../../services/homeTimeConstants');
const { isInactiveGroup } = require('../../../lib/drivers/driverProfileParse');
const { parseDateInput } = require('../homeTimeRouteHelpers');
const {
  listCanonicalDriverGroups,
} = require('../../../services/driverGroupDirectoryService');
const { buildEfficiencyReport } = require('../../../services/homeTimeEfficiencyService');
const {
  resolveEfficiencySinceIso, displayName, resolveDriverType, buildDirectoryIndex,
} = require('./rowShaping');

function createHomeTimeTrackerRoutes({ authMiddleware }) {
  const router = express.Router();

  router.get('/overview', authMiddleware, async (req, res) => {
    try {
      const settings = await ht.getHomeTimeSettings();
      const [rawStatuses, history, directory] = await Promise.all([
        ht.listCurrentStatuses(),
        ht.listRoadHistory({ limit: 100 }),
        listCanonicalDriverGroups({ operational: true, includeNonDrivers: false }),
      ]);
      const directoryByGroupId = buildDirectoryIndex(directory);
      const nowIso = DateTime.now().toUTC().toISO();

      const statuses = rawStatuses
        .map((row) => {
          const identity = directoryByGroupId.get(Number(row.group_id)) || null;
          if (identity && identity.operational_visible === false) return null;
          const driverType = identity?.driver_type || resolveDriverType(row);
          const base = {
            group_id: row.group_id,
            canonical_group_id: identity?.canonical_group_id || row.group_id,
            driver_name: identity?.display_name || displayName(row),
            driver_type: driverType,
            unit_number: identity?.unit_number || row.unit_number || null,
            group_active: identity?.group_active ?? row.group_active,
            inactive: identity?.inactive ?? isInactiveGroup({ active: row.group_active, group_name: row.group_name, status: row.driver_status }),
            duplicate_conflict: identity?.duplicate_conflict === true,
            duplicate_resolution: identity?.duplicate_resolution || 'unique',
            state: row.state,
            state_since: row.state_since,
            last_status_at: row.last_status_at,
          };
          if (row.state === 'road') {
            const live = computeRoadBonus(row.state_since, nowIso, {
              roadAllowanceWeeks: settings.road_allowance_weeks,
              bonusPerWeek: Number(settings.bonus_per_week),
              driverType,
            });
            const nextHome = computeNextEligibleHomeTime(row.state_since, {
              roadAllowanceWeeks: settings.road_allowance_weeks,
              driverType,
            });
            return {
              ...base,
              days_on_road: live.daysOnRoad,
              policy_applies: live.policyApplies,
              over_limit: live.overLimit,
              pending_exceeded_weeks: live.exceededWeeks,
              pending_bonus_usd: live.bonusUsd,
              next_home_time_at: nextHome.eligibleAtIso,
              next_home_time_date: nextHome.eligibleDate,
            };
          }
          return {
            ...base,
            policy_applies: homeTimePolicyApplies(driverType),
            days_home: wholeDaysBetween(row.state_since, nowIso),
          };
        })
        .filter(Boolean);

      const adjustedHistory = history.map((row) => {
        const identity = directoryByGroupId.get(Number(row.group_id)) || null;
        const driverType = identity?.driver_type || resolveDriverType(row);
        const recalculated = computeRoadBonus(row.road_started_at, row.home_arrived_at, {
          roadAllowanceWeeks: settings.road_allowance_weeks,
          bonusPerWeek: Number(settings.bonus_per_week),
          driverType,
        });
        return {
          ...row,
          group_id: identity?.canonical_group_id || row.group_id,
          source_group_id: row.group_id,
          driver_name: identity?.display_name || row.driver_name || null,
          unit_number: identity?.unit_number || row.unit_number || null,
          driver_type: driverType,
          policy_applies: recalculated.policyApplies,
          days_on_road: recalculated.daysOnRoad,
          exceeded_weeks: recalculated.exceededWeeks,
          bonus_usd: recalculated.bonusUsd,
        };
      });

      res.json({ settings, statuses, history: adjustedHistory });
    } catch (err) {
      console.error('[HOME-TIME API] overview failed:', err.message);
      res.status(500).json({ error: 'Failed to load home-time overview.' });
    }
  });

  // GET /efficiency — Driver Home Time Efficiency dashboard: company overview +
  // per-driver compliance from ACTUAL completed cycles. ?range=30|90|180|all.
  router.get('/efficiency', authMiddleware, async (req, res) => {
    try {
      const sinceIso = resolveEfficiencySinceIso(req.query.range);
      const settings = await ht.getHomeTimeSettings();
      const [cycles, statuses, directory] = await Promise.all([
        ht.listCyclesForEfficiency({ sinceIso }),
        ht.listCurrentStatuses(),
        listCanonicalDriverGroups({ operational: true, includeNonDrivers: false }),
      ]);
      const directoryByGroupId = buildDirectoryIndex(directory);
      const report = buildEfficiencyReport({
        cycles, statuses, directoryByGroupId, settings,
      });
      res.json({
        ...report,
        range: String(req.query.range || 'all'),
        settings,
      });
    } catch (err) {
      console.error('[HOME-TIME API] efficiency failed:', err.message);
      res.status(500).json({ error: 'Failed to load home-time efficiency.' });
    }
  });

  // PUT /status/:groupId — admin edit of the current state. Accepts the start
  // date (`state_since`) and/or the state itself (`state`: 'home' | 'road'), so an
  // auto-detected or wrong state can be corrected by hand. Recomputed counters
  // flow from this on the next overview load. At least one field is required.
  router.put('/status/:groupId', authMiddleware, async (req, res) => {
    try {
      const groupId = Number.parseInt(req.params.groupId, 10);
      if (!(groupId > 0)) return res.status(400).json({ error: 'Invalid group id' });

      const body = req.body || {};
      const hasState = body.state !== undefined && body.state !== null && body.state !== '';
      const hasSince = body.state_since !== undefined && body.state_since !== null && body.state_since !== '';
      if (!hasState && !hasSince) {
        return res.status(400).json({ error: 'Provide state and/or state_since' });
      }

      let state = null;
      if (hasState) {
        state = String(body.state);
        if (state !== 'home' && state !== 'road') {
          return res.status(400).json({ error: "state must be 'home' or 'road'" });
        }
      }

      let since = null;
      if (hasSince) {
        since = parseDateInput(body.state_since);
        if (!since) return res.status(400).json({ error: 'state_since must be a valid date' });
        if (DateTime.fromISO(since) > DateTime.now()) {
          return res.status(400).json({ error: 'state_since cannot be in the future' });
        }
      }

      const existing = await ht.getDriverHomeStatus(groupId);
      if (!existing) return res.status(404).json({ error: 'No tracked status for this group' });

      // Flipping the state with no explicit date starts a fresh cycle from now, so
      // the on-road / at-home counters do not keep counting from the old date.
      if (state && state !== existing.state && !since) {
        since = DateTime.now().toUTC().toISO();
      }

      const updated = await ht.setDriverHomeState(groupId, { state, stateSince: since });
      if (!updated) return res.status(404).json({ error: 'No tracked status for this group' });
      res.json({ status: updated });
    } catch (err) {
      console.error('[HOME-TIME API] status update failed:', err.message);
      res.status(500).json({ error: 'Failed to update status.' });
    }
  });

  // PUT /history/:id — admin edit of a completed trip's dates; bonus is recomputed.
  router.put('/history/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!(id > 0)) return res.status(400).json({ error: 'Invalid history id' });
      const existing = await ht.getRoadHistoryById(id);
      if (!existing) return res.status(404).json({ error: 'Trip not found' });

      const roadStartedAt = req.body?.road_started_at != null
        ? parseDateInput(req.body.road_started_at)
        : DateTime.fromJSDate(new Date(existing.road_started_at)).toISO();
      const homeArrivedAt = req.body?.home_arrived_at != null
        ? parseDateInput(req.body.home_arrived_at)
        : DateTime.fromJSDate(new Date(existing.home_arrived_at)).toISO();
      if (!roadStartedAt || !homeArrivedAt) {
        return res.status(400).json({ error: 'Dates must be valid' });
      }
      if (DateTime.fromISO(homeArrivedAt) < DateTime.fromISO(roadStartedAt)) {
        return res.status(400).json({ error: 'Home date must be on or after the road-start date' });
      }

      const settings = await ht.getHomeTimeSettings();
      const driverType = resolveDriverType(existing);
      const { daysOnRoad, exceededWeeks, bonusUsd } = computeRoadBonus(roadStartedAt, homeArrivedAt, {
        roadAllowanceWeeks: settings.road_allowance_weeks,
        bonusPerWeek: Number(settings.bonus_per_week),
        driverType,
      });
      const updated = await ht.updateRoadHistory(id, {
        roadStartedAt, homeArrivedAt, daysOnRoad, exceededWeeks, bonusUsd,
      });
      res.json({ trip: updated });
    } catch (err) {
      console.error('[HOME-TIME API] history update failed:', err.message);
      res.status(500).json({ error: 'Failed to update trip.' });
    }
  });

  // DELETE /history/:id — remove a mistaken trip record.
  router.delete('/history/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!(id > 0)) return res.status(400).json({ error: 'Invalid history id' });
      const removed = await ht.deleteRoadHistory(id);
      if (!removed) return res.status(404).json({ error: 'Trip not found' });
      res.json({ deleted: true });
    } catch (err) {
      console.error('[HOME-TIME API] history delete failed:', err.message);
      res.status(500).json({ error: 'Failed to delete trip.' });
    }
  });

  return router;
}

module.exports = { createHomeTimeTrackerRoutes };
