/**
 * Message routing: which Telegram group each bonus / review category posts to.
 *
 * These are configuration, not defaults with a fallback: a category with no
 * configured group causes the sender to REPORT a configuration error rather
 * than posting to some historical hardcoded chat. That was deliberate — see
 * services/mileageBonus/bonusRun.js.
 *
 * Split out of server/routes/settingsRoutes.js.
 */

const express = require('express');
const messageGroups = require('../../../database/messageRoutingSettings');

function createMessageGroupSettingsRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();

  // ─── Message routing (Telegram group per bonus / review category) ───
  // Telegram group IDs are not secrets — returned in plaintext for hand-editing.

  router.get('/message-groups', authMiddleware, async (req, res) => {
    try {
      const settings = await messageGroups.getMessageGroupSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] message-groups load failed:', err.message);
      res.status(500).json({ error: 'Failed to load message group settings' });
    }
  });

  router.put('/message-groups', authMiddleware, async (req, res) => {
    try {
      const settings = await messageGroups.updateMessageGroupSettings(req.body || {});
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] message-groups update failed:', err.message);
      res.status(500).json({ error: 'Failed to save message group settings' });
    }
  });

  return router;
}

module.exports = { createMessageGroupSettingsRouter };
