const express = require('express');
const db = require('../../database/db');
const { buildDisplayName } = require('../../services/telegramMention');

/**
 * Group members admin API.
 *  - GET /:groupId/members → users the bot has SEEN interact in the group,
 *    for the "Driver Username" dropdown on the Driver Groups popup.
 *
 * Hard Telegram limitation: the Bot API cannot enumerate a group's member
 * list (only getChatMember for one known user, getChatAdministrators, and
 * getChatMemberCount), so this list contains only users captured from
 * updates the bot received — silent members will not appear until they
 * interact in the group.
 */
function createGroupMembersRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/:groupId/members', authMiddleware, async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Invalid group id' });
      }
      const rows = await db.listGroupMembers(groupId);
      const members = rows.map((row) => ({
        telegram_user_id: String(row.telegram_user_id),
        username: row.username || null,
        display_name: buildDisplayName(row, `User ${row.telegram_user_id}`),
      }));
      res.json({ members });
    } catch (err) {
      console.error('[GROUP-MEMBERS API] list failed:', err.message);
      res.status(500).json({ error: 'Failed to load group members' });
    }
  });

  return router;
}

module.exports = { createGroupMembersRouter };
