const express = require('express');
const botUsersDb = require('../../database/botUsers');

/**
 * Bot Users admin API — Telegram users who have interacted with the bot's
 * inline buttons (location check-in prompts etc.), captured on every tap.
 *  - GET / → users, most recently active first
 */
function createBotUsersRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const limit = Number.parseInt(req.query.limit, 10);
      const rows = await botUsersDb.listBotUsers(Number.isInteger(limit) ? limit : 200);
      res.json({
        users: rows.map((u) => ({
          telegram_user_id: String(u.telegram_user_id),
          username: u.username || null,
          first_name: u.first_name || null,
          last_name: u.last_name || null,
          interactions: Number(u.interactions) || 0,
          last_action: u.last_action || null,
          last_group_id: u.last_group_id != null ? Number(u.last_group_id) : null,
          last_group_name: u.last_group_name || null,
          first_seen_at: u.first_seen_at || null,
          last_interaction_at: u.last_interaction_at || null,
        })),
      });
    } catch (err) {
      console.error('[BOT-USERS API] list failed:', err.message);
      res.status(500).json({ error: 'Failed to load bot users.' });
    }
  });

  return router;
}

module.exports = { createBotUsersRouter };
