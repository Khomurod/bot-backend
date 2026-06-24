/**
 * Driver Home-Time Tracking — admin API.
 *
 * Mounted at /api/home-time (JWT auth, like the other admin endpoints). The
 * tracker itself is event-driven from the bot; this router only exposes the
 * dashboard (current statuses + bonus history) and the settings.
 */
const express = require('express');
const { DateTime } = require('luxon');
const db = require('../../database/db');
const ht = require('../../database/homeTime');
const { computeRoadBonus, wholeDaysBetween } = require('../../services/homeTimeConstants');
const groupAccess = require('../../services/groupAccessService');

function displayName(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return name || row.group_name || `Group ${row.group_id}`;
}

/** Shape a driver-group access row for the admin view (adds the read verdict). */
function shapeAccessRow(row, now) {
  const verdict = groupAccess.computeReadingVerdict({
    memberStatus: row.bot_member_status,
    lastMessageSeenAt: row.last_message_seen_at,
    now,
  });
  return {
    group_id: row.group_id,
    group_name: row.group_name,
    driver_name: displayName(row),
    unit_number: row.unit_number || null,
    active: row.active,
    bot_member_status: row.bot_member_status || null,
    bot_access_checked_at: row.bot_access_checked_at,
    last_message_seen_at: row.last_message_seen_at,
    home_state: row.home_state || null,
    reading: verdict.reading,
    reading_level: verdict.level,
    reading_label: verdict.label,
  };
}

function createHomeTimeRouter({ authMiddleware }) {
  const router = express.Router();

  // GET /overview — settings + current per-driver state (with live counters) +
  // recent earned-bonus history.
  router.get('/overview', authMiddleware, async (req, res) => {
    try {
      const settings = await ht.getHomeTimeSettings();
      const [rawStatuses, history] = await Promise.all([
        ht.listCurrentStatuses(),
        ht.listRoadHistory({ limit: 100 }),
      ]);
      const nowIso = DateTime.now().toUTC().toISO();

      const statuses = rawStatuses.map((row) => {
        const base = {
          group_id: row.group_id,
          driver_name: displayName(row),
          unit_number: row.unit_number || null,
          group_active: row.group_active,
          state: row.state,
          state_since: row.state_since,
          last_status_at: row.last_status_at,
        };
        if (row.state === 'road') {
          const live = computeRoadBonus(row.state_since, nowIso, {
            roadAllowanceWeeks: settings.road_allowance_weeks,
            bonusPerWeek: Number(settings.bonus_per_week),
          });
          return {
            ...base,
            days_on_road: live.daysOnRoad,
            over_limit: live.exceededWeeks > 0,
            pending_exceeded_weeks: live.exceededWeeks,
            pending_bonus_usd: live.bonusUsd,
          };
        }
        return { ...base, days_home: wholeDaysBetween(row.state_since, nowIso) };
      });

      res.json({ settings, statuses, history });
    } catch (err) {
      console.error('[HOME-TIME API] overview failed:', err.message);
      res.status(500).json({ error: 'Failed to load home-time overview.' });
    }
  });

  // PUT /settings — enable/disable + tune the allowance and bonus.
  router.put('/settings', authMiddleware, async (req, res) => {
    try {
      const b = req.body || {};
      const patch = {};
      if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
      if (b.road_allowance_weeks !== undefined) {
        const w = Number.parseInt(b.road_allowance_weeks, 10);
        if (!(w >= 1 && w <= 52)) return res.status(400).json({ error: 'road_allowance_weeks must be 1-52' });
        patch.road_allowance_weeks = w;
      }
      if (b.home_allowance_days !== undefined) {
        const d = Number.parseInt(b.home_allowance_days, 10);
        if (!(d >= 1 && d <= 60)) return res.status(400).json({ error: 'home_allowance_days must be 1-60' });
        patch.home_allowance_days = d;
      }
      if (b.bonus_per_week !== undefined) {
        const n = Number(b.bonus_per_week);
        if (!(n >= 0)) return res.status(400).json({ error: 'bonus_per_week must be 0 or more' });
        patch.bonus_per_week = n;
      }
      const settings = await ht.updateHomeTimeSettings(patch);
      res.json({ settings });
    } catch (err) {
      console.error('[HOME-TIME API] settings update failed:', err.message);
      res.status(500).json({ error: 'Failed to update settings.' });
    }
  });

  // GET /group-access — which driver groups the bot can read, and which it can't.
  router.get('/group-access', authMiddleware, async (req, res) => {
    try {
      const now = Date.now();
      const rows = await db.listDriverGroupAccess();
      const groups = rows.map((row) => shapeAccessRow(row, now));
      const summary = groups.reduce((acc, g) => {
        acc[g.reading_level] = (acc[g.reading_level] || 0) + 1;
        return acc;
      }, {});
      const lastChecked = rows
        .map((r) => r.bot_access_checked_at)
        .filter(Boolean)
        .sort()
        .pop() || null;
      res.json({ groups, summary, lastChecked });
    } catch (err) {
      console.error('[HOME-TIME API] group-access failed:', err.message);
      res.status(500).json({ error: 'Failed to load group access.' });
    }
  });

  // POST /group-access/recheck — ask Telegram for the bot's role in each group.
  router.post('/group-access/recheck', authMiddleware, async (req, res) => {
    try {
      const result = await groupAccess.refreshDriverGroupBotAccess();
      const now = Date.now();
      const rows = await db.listDriverGroupAccess();
      const groups = rows.map((row) => shapeAccessRow(row, now));
      res.json({ ...result, groups });
    } catch (err) {
      console.error('[HOME-TIME API] group-access recheck failed:', err.message);
      res.status(500).json({ error: 'Could not recheck group access.' });
    }
  });

  return router;
}

module.exports = { createHomeTimeRouter };
