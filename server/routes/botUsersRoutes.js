const express = require('express');
const botUsersDb = require('../../database/botUsers');

/**
 * Bot Users admin API — every Telegram user the bot has seen: button tappers
 * (interactions) AND anyone who texts in a group the bot is in (message_count),
 * keyed by a stable telegram_user_id and enriched with the linked dispatch team.
 *  - GET / → users, most recently active first
 *      ?limit=  max rows (default 200)
 *      ?filter= all|admins|dispatch|drivers|unknown|recent
 *      ?search= free text over name / @username / id / last group
 */
function createBotUsersRouter({ authMiddleware }) {
  const router = express.Router();

  /** Coarse role for display: a dispatch-team match always wins. */
  function deriveSource(u) {
    if (u.linked_team_id != null) return 'dispatcher';
    if (u.source && ['driver', 'dispatcher', 'admin', 'unknown'].includes(u.source)) return u.source;
    return 'unknown';
  }

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const limit = Number.parseInt(req.query.limit, 10);
      const filter = req.query.filter ? String(req.query.filter) : 'all';
      const search = req.query.search ? String(req.query.search) : '';
      const rows = await botUsersDb.listBotUsers({
        limit: Number.isInteger(limit) ? limit : 200,
        filter,
        search,
      });
      res.json({
        users: rows.map((u) => ({
          telegram_user_id: String(u.telegram_user_id),
          username: u.username || null,
          first_name: u.first_name || null,
          last_name: u.last_name || null,
          interactions: Number(u.interactions) || 0,
          message_count: Number(u.message_count) || 0,
          last_action: u.last_action || null,
          last_group_id: u.last_group_id != null ? Number(u.last_group_id) : null,
          last_group_name: u.last_group_name || null,
          last_seen_chat_id: u.last_seen_chat_id != null ? String(u.last_seen_chat_id) : null,
          language_code: u.language_code || null,
          is_bot: Boolean(u.is_bot),
          linked_team_id: u.linked_team_id != null ? Number(u.linked_team_id) : null,
          linked_team_name: u.linked_team_name || null,
          source: deriveSource(u),
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
