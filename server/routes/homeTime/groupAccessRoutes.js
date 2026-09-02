/**
 * Home-Time GROUP ACCESS admin API.
 *
 * Whether the bot can actually post in each driver group, and the flow that asks
 * a group admin to grant it. Without access the tracker silently stops reaching
 * that driver, so this screen exists to make the gap visible.
 *
 * Split out of server/routes/homeTimeRoutes.js.
 */

const express = require('express');
const { DateTime } = require('luxon');
const ht = require('../../../database/homeTime');
const groupAccess = require('../../../services/groupAccessService');
const {
  listCanonicalDriverGroups,
} = require('../../../services/driverGroupDirectoryService');
const { buildAdminGrantPayload } = require('../../../services/groupAccessConstants');
const { shapeAccessRow, displayName, escapeHtmlSafe } = require('./rowShaping');

function createHomeTimeGroupAccessRoutes({ authMiddleware }) {
  const router = express.Router();

  router.get('/group-access', authMiddleware, async (req, res) => {
    try {
      const now = Date.now();
      const rows = (await listCanonicalDriverGroups({ operational: true, includeNonDrivers: true }))
        .filter((row) => row.group_type !== 'driver' || row.operational_visible !== false);
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
      const rows = (await listCanonicalDriverGroups({ operational: true, includeNonDrivers: true }))
        .filter((row) => row.group_type !== 'driver' || row.operational_visible !== false);
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

      const rows = (await listCanonicalDriverGroups({ operational: true, includeNonDrivers: true }))
        .filter((row) => row.group_type !== 'driver' || row.operational_visible !== false);
      const group = rows.find((g) => Number(g.group_id) === groupId);
      if (!group) return res.status(404).json({ error: 'Driver group not found' });

      const { bot } = require('../../../bot/bot');
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

module.exports = { createHomeTimeGroupAccessRoutes };
