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
const { publicViolationSettings, generateWebhookSecret } = require('../../../services/homeTime/violationWebhookSecret');

const CHAT_ID_COLUMNS = ['completed_notify_group_id', 'internal_clarification_group_id', 'violation_alerts_chat_id'];

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

      // Violation alerts: nothing is sent until a group is saved, and switching
      // them on (again) re-arms the baseline — cards already in a violation
      // stage are recorded, not posted, so a backlog never reaches the group.
      const violationGroup = patch.violation_alerts_chat_id !== undefined
        ? patch.violation_alerts_chat_id : previous?.violation_alerts_chat_id;
      if (patch.violation_alerts_enabled === true && !violationGroup) {
        return res.status(400).json({ error: 'Save the violation alerts group before switching them on.' });
      }
      if (patch.violation_alerts_chat_id === null) patch.violation_alerts_enabled = false;
      if (patch.violation_alerts_enabled === true && previous?.violation_alerts_enabled !== true) {
        patch.violation_alerts_baselined_at = null;
      }

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
      res.json({ settings: publicViolationSettings(settings) });
    } catch (err) {
      console.error('[HOME-TIME API] settings update failed:', err.message);
      res.status(500).json({ error: 'Failed to update settings.' });
    }
  });

  // The violation alerts' webhook secret: made here, stored encrypted, returned
  // THIS ONCE so the page can show the link to paste into the Bitrix robots.
  // Never readable again; creating another replaces it.
  router.post('/settings/violation-webhook-secret', authMiddleware, async (req, res) => {
    try {
      const secret = await generateWebhookSecret();
      console.log(`[HOME-TIME API] new violation webhook secret created by ${req.user?.username || req.user?.id || 'admin'}`);
      res.json({ secret });
    } catch (err) {
      console.error('[HOME-TIME API] could not create the webhook secret:', err.message);
      res.status(500).json({ error: 'Could not create the webhook link.' });
    }
  });

  return router;
}

module.exports = { createHomeTimeSettingsRoutes };
