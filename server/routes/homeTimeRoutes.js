/**
 * Driver Home-Time Tracking — admin API.
 *
 * Mounted at /api/home-time (JWT auth, like the other admin endpoints). The
 * tracker itself is event-driven from the bot; this router only exposes the
 * dashboard (current statuses + bonus history) and the settings.
 */
const express = require('express');
const multer = require('multer');
const { DateTime } = require('luxon');
const db = require('../../database/db');
const ht = require('../../database/homeTime');
const { computeRoadBonus, wholeDaysBetween } = require('../../services/homeTimeConstants');
const groupAccess = require('../../services/groupAccessService');
const { buildAdminGrantPayload } = require('../../services/groupAccessConstants');
const homeTimeImport = require('../../services/homeTimeImportService');

const SCREENSHOT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => {
    if (SCREENSHOT_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: jpg, png, webp`));
  },
});

function displayName(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return name || row.group_name || `Group ${row.group_id}`;
}

/** Accept a YYYY-MM-DD or full ISO datetime; return a UTC ISO string or null. */
function parseDateInput(value) {
  if (value == null || value === '') return null;
  const str = String(value);
  let dt = DateTime.fromISO(str, { zone: 'utc' });
  if (!dt.isValid && /^\d{4}-\d{2}-\d{2}$/.test(str)) {
    dt = DateTime.fromISO(`${str}T00:00:00`, { zone: 'utc' });
  }
  return dt.isValid ? dt.toISO() : null;
}

/** Accept only a calendar date; return YYYY-MM-DD or null. */
function parseDateOnly(value) {
  if (value == null || value === '') return null;
  const str = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const dt = DateTime.fromISO(str);
  return dt.isValid ? dt.toISODate() : null;
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

  // PUT /status/:groupId — admin edit of the current state's start date (when the
  // driver left for the road, or when they came home). Recomputed counters flow
  // from this on the next overview load.
  router.put('/status/:groupId', authMiddleware, async (req, res) => {
    try {
      const groupId = Number.parseInt(req.params.groupId, 10);
      if (!(groupId > 0)) return res.status(400).json({ error: 'Invalid group id' });
      const since = parseDateInput(req.body?.state_since);
      if (!since) return res.status(400).json({ error: 'state_since must be a valid date' });
      if (DateTime.fromISO(since) > DateTime.now()) {
        return res.status(400).json({ error: 'state_since cannot be in the future' });
      }
      const updated = await ht.setDriverHomeStateSince(groupId, since);
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
      const { daysOnRoad, exceededWeeks, bonusUsd } = computeRoadBonus(roadStartedAt, homeArrivedAt, {
        roadAllowanceWeeks: settings.road_allowance_weeks,
        bonusPerWeek: Number(settings.bonus_per_week),
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

  // POST /import-screenshots — AI vision reads uploaded screenshots and returns
  // matched driver rows for the admin to review (no writes yet).
  router.post('/import-screenshots', authMiddleware, (req, res) => {
    screenshotUpload.array('screenshots', 12)(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'A screenshot is too large (max 8MB each).' });
        }
        return res.status(400).json({ error: uploadErr.message });
      }
      if (!req.files || !req.files.length) {
        return res.status(400).json({ error: 'Upload at least one screenshot.' });
      }
      try {
        const rows = await homeTimeImport.extractAndMatch(req.files);
        const matched = rows.filter((r) => r.matched).length;
        res.json({ rows, total: rows.length, matched, unmatched: rows.length - matched });
      } catch (err) {
        console.error('[HOME-TIME API] screenshot parse failed:', err.message);
        res.status(err.status || 500).json({ error: err.message || 'Failed to read screenshots.' });
      }
    });
  });

  // POST /import-screenshots/apply — write the reviewed rows (state + history).
  router.post('/import-screenshots/apply', authMiddleware, async (req, res) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
      if (!rows) return res.status(400).json({ error: 'rows array is required' });
      const report = await homeTimeImport.applyRows(rows);
      res.json({ applied: true, ...report });
    } catch (err) {
      console.error('[HOME-TIME API] screenshot apply failed:', err.message);
      res.status(500).json({ error: 'Failed to apply imported rows.' });
    }
  });

  // GET /requests — every home-time request (for red-flag review).
  router.get('/requests', authMiddleware, async (req, res) => {
    try {
      const requests = await ht.listHomeTimeRequests({ limit: 200 });
      res.json({ requests });
    } catch (err) {
      console.error('[HOME-TIME API] requests load failed:', err.message);
      res.status(500).json({ error: 'Failed to load requests.' });
    }
  });

  // POST /requests — manually register a home-time request (admin entry).
  router.post('/requests', authMiddleware, async (req, res) => {
    try {
      const b = req.body || {};
      const groupId = b.group_id != null ? Number.parseInt(b.group_id, 10) : null;
      const homeFrom = parseDateOnly(b.home_from);
      const homeTo = parseDateOnly(b.home_to);
      if (!homeFrom || !homeTo) {
        return res.status(400).json({ error: 'home_from and home_to must be YYYY-MM-DD' });
      }
      if (homeTo < homeFrom) {
        return res.status(400).json({ error: 'home_to must be on or after home_from' });
      }
      const allowedStatus = ['pending', 'approved', 'denied'];
      const status = allowedStatus.includes(b.status) ? b.status : 'approved';

      let driverName = b.driver_name || null;
      let unitNumber = b.unit_number || null;
      let telegramGroupId = null;
      if (groupId) {
        const profile = await db.getDriverProfileByGroupId(groupId).catch(() => null);
        if (profile) {
          driverName = driverName || [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() || null;
          unitNumber = unitNumber || profile.unit_number || null;
          telegramGroupId = profile.telegram_group_id || null;
        }
      }

      // Always insert as pending, then decide() so decided_by/decided_at are set
      // consistently for approved/denied manual entries.
      let request = await ht.insertHomeTimeRequest({
        groupId: groupId || null,
        telegramGroupId,
        driverName,
        unitNumber,
        requestedByUsername: req.admin?.username || null,
        policyMet: typeof b.policy_met === 'boolean' ? b.policy_met : null,
        homeFrom,
        homeTo,
        status: 'pending',
        source: 'manual',
        aiReasoning: b.note || null,
      });
      if (status !== 'pending') {
        const decided = await ht.decideHomeTimeRequest(request.id, {
          status, username: req.admin?.username || null,
        });
        if (decided) request = decided;
      }
      res.json({ request });
    } catch (err) {
      console.error('[HOME-TIME API] manual request failed:', err.message);
      res.status(500).json({ error: 'Failed to register request.' });
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

  // GET /access-settings — the super admin who receives "make me admin" links.
  router.get('/access-settings', authMiddleware, async (req, res) => {
    try {
      const settings = await ht.getBotAccessSettings();
      res.json({ settings });
    } catch (err) {
      console.error('[HOME-TIME API] access-settings load failed:', err.message);
      res.status(500).json({ error: 'Failed to load access settings.' });
    }
  });

  // PUT /access-settings — set the super admin Telegram id + label.
  router.put('/access-settings', authMiddleware, async (req, res) => {
    try {
      const b = req.body || {};
      let id = null;
      if (b.super_admin_telegram_id != null && String(b.super_admin_telegram_id).trim() !== '') {
        const raw = String(b.super_admin_telegram_id).trim();
        if (!/^-?\d+$/.test(raw)) {
          return res.status(400).json({ error: 'super_admin_telegram_id must be a numeric Telegram id' });
        }
        id = raw;
      }
      const settings = await ht.updateBotAccessSettings({
        superAdminTelegramId: id,
        superAdminLabel: b.super_admin_label ? String(b.super_admin_label).slice(0, 120) : null,
      });
      res.json({ settings });
    } catch (err) {
      console.error('[HOME-TIME API] access-settings update failed:', err.message);
      res.status(500).json({ error: 'Failed to update access settings.' });
    }
  });

  // POST /group-access/request-admin/:groupId — DM the super admin a deep link
  // that adds the bot to the chosen group as an admin (Telegram ?startgroup&admin).
  router.post('/group-access/request-admin/:groupId', authMiddleware, async (req, res) => {
    try {
      const groupId = Number.parseInt(req.params.groupId, 10);
      if (!(groupId > 0)) return res.status(400).json({ error: 'Invalid group id' });

      const settings = await ht.getBotAccessSettings();
      if (!settings?.super_admin_telegram_id) {
        return res.status(409).json({ error: 'Set the super admin Telegram id first.' });
      }

      const rows = await db.listDriverGroupAccess();
      const group = rows.find((g) => Number(g.group_id) === groupId);
      if (!group) return res.status(404).json({ error: 'Driver group not found' });

      const { bot } = require('../../bot/bot');
      const me = await bot.telegram.getMe();
      const username = me?.username;
      if (!username) return res.status(502).json({ error: 'Could not resolve the bot username.' });

      // Admin rights requested so the bot can read all messages in the group.
      // The start parameter tags the link with the intended group so the bot can
      // verify the super admin picked the right one (Telegram cannot pre-select
      // the group itself) and DM a confirmation afterward.
      const adminRights = 'change_info+delete_messages+restrict_members+pin_messages+invite_users+manage_video_chats';
      const payload = buildAdminGrantPayload(groupId);
      const link = `https://t.me/${username}?startgroup=${payload}&admin=${adminRights}`;
      const groupLabel = displayName(group);

      const text = `🔐 <b>Admin access requested</b>\n`
        + `Please grant <b>@${escapeHtmlSafe(username)}</b> admin rights in this driver group:\n`
        + `<b>${escapeHtmlSafe(groupLabel)}</b>\n\n`
        + `Tap the link below, then pick <b>${escapeHtmlSafe(group.group_name || groupLabel)}</b> and confirm. `
        + `I'll message you here to confirm it worked (or warn you if the wrong group was picked):\n`
        + `${link}`;

      try {
        await bot.telegram.sendMessage(settings.super_admin_telegram_id, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (sendErr) {
        const desc = sendErr?.description || sendErr?.message || '';
        if (/chat not found|bot can't initiate|blocked|deactivated/i.test(desc)) {
          return res.status(409).json({
            error: 'Could not message the super admin. They must start a chat with the bot first.',
          });
        }
        throw sendErr;
      }

      res.json({ sent: true, link });
    } catch (err) {
      console.error('[HOME-TIME API] request-admin failed:', err.message);
      res.status(500).json({ error: 'Could not send the admin request.' });
    }
  });

  return router;
}

function escapeHtmlSafe(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { createHomeTimeRouter };
