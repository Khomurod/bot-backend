/**
 * Home-Time SETTINGS admin API.
 *
 * Includes the silent-mode switch: whether the bot may message driver groups at
 * all, and where the internal "staff must clarify these dates" alert goes when
 * it may not. Flipping it runs a transition, so this endpoint delegates rather
 * than writing the row directly.
 *
 * Both chat-id fields are checked for reachability before the write. They were
 * only ever checked for SHAPE, and `5052301861` — the "HR Personnel" chat with
 * its minus sign dropped — is a perfectly shaped id for a chat that does not
 * exist. Every internal alert raised against it failed and was retried to
 * exhaustion for months with nothing to show for it.
 *
 * Split out of server/routes/homeTimeRoutes.js. Distinct from
 * server/routes/settings/* — these are the tracker's own settings, mounted
 * under /api/home-time.
 */

const express = require('express');
const ht = require('../../../database/homeTime');
const {
  isSilencingTransition, applySilentModeTransition,
} = require('../../../services/homeTimeSilentModeTransition');
const { buildSettingsPatch } = require('../homeTimeRouteHelpers');
const { checkChatIdColumns } = require('../../../services/telegramChatIdCheck');
const { getGroupByTelegramId } = require('../../../database/groups');

const CHAT_ID_COLUMNS = ['completed_notify_group_id', 'internal_clarification_group_id'];

function createHomeTimeSettingsRoutes({ authMiddleware, telegram }) {
  const router = express.Router();

  router.put('/settings', authMiddleware, async (req, res) => {
    try {
      const { patch, error } = buildSettingsPatch(req.body);
      if (error) return res.status(400).json({ error });

      // Shape is not reachability. Only columns present in the patch are checked,
      // and clearing one (null) skips the check, so emptying a destination never
      // has to satisfy it.
      const reach = await checkChatIdColumns(patch, CHAT_ID_COLUMNS, {
        getGroupByTelegramId,
        telegram,
      });
      if (reach.error) {
        return res.status(400).json({ error: reach.error, suggestion: reach.result?.suggestion || null });
      }

      // Detect the true → false flip BEFORE the write, then act AFTER it. The
      // ordering matters: standing reminders down before the write would, if the
      // write then failed, leave a still-enabled bot with its schedule wiped.
      const previous = await ht.getHomeTimeSettings();
      const silencing = isSilencingTransition(previous, patch);

      const settings = await ht.updateHomeTimeSettings(patch);

      // Turning driver messaging off must stop every ALREADY-SCHEDULED reminder
      // at once, not just the ones that happen to be due — otherwise one
      // scheduled for later today still fires if the setting is switched back on
      // before it comes due. Bulk DB update; sends nothing to any driver group.
      if (silencing) {
        await applySilentModeTransition().catch((e) => {
          console.error('[HOME-TIME API] silent-mode transition failed:', e.message);
        });
      }
      res.json({ settings });
    } catch (err) {
      console.error('[HOME-TIME API] settings update failed:', err.message);
      res.status(500).json({ error: 'Failed to update settings.' });
    }
  });

  return router;
}

module.exports = { createHomeTimeSettingsRoutes };
