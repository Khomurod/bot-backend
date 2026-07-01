const express = require('express');
const db = require('../../database/db');
const { editBotMessage, deleteBotMessage } = require('../../services/botMessageAdminService');

/**
 * Bot Messages admin API — browse / edit / delete every message the bot has
 * sent, using the bot_sent_messages registry so it works even for groups that
 * don't expose message links.
 *   GET    /                 → list + filters (chat, search, date range) + pagination
 *   PATCH  /:id              → edit the message text in Telegram
 *   DELETE /:id              → delete the message in Telegram + mark deleted
 */
function createBotMessagesRouter({ authMiddleware, telegram }) {
  const router = express.Router();
  const deps = telegram ? { telegram } : {};

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const { chatId, search, dateFrom, dateTo, includeDeleted, limit, offset } = req.query;
      const result = await db.listBotSentMessages({
        chatId: chatId || null,
        search: search || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        includeDeleted: includeDeleted === 'false' ? false : true,
        limit: limit != null ? Number(limit) : 50,
        offset: offset != null ? Number(offset) : 0,
      });
      res.json(result);
    } catch (err) {
      console.error('[BOT-MESSAGES API] list failed:', err.message);
      res.status(500).json({ error: 'Failed to load bot messages' });
    }
  });

  router.patch('/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid message id' });
      }
      const newText = req.body?.newText;
      if (typeof newText !== 'string' || newText.trim() === '') {
        return res.status(400).json({ error: 'Replacement text is required.' });
      }

      const row = await db.getBotSentMessageById(id);
      if (!row) return res.status(404).json({ error: 'Message not found' });
      if (row.deleted_at) {
        return res.status(409).json({ error: 'This message was deleted and can no longer be edited.' });
      }

      const result = await editBotMessage(
        row.telegram_chat_id,
        row.telegram_message_id,
        newText,
        deps
      );
      if (!result.ok) {
        return res.status(502).json({ error: result.error || 'Telegram could not edit that message.', reason: result.reason });
      }

      const updated = result.row || (await db.getBotSentMessageById(id));
      res.json({ message: updated, reason: result.reason });
    } catch (err) {
      console.error('[BOT-MESSAGES API] edit failed:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.delete('/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid message id' });
      }

      const row = await db.getBotSentMessageById(id);
      if (!row) return res.status(404).json({ error: 'Message not found' });

      const result = await deleteBotMessage(
        row.telegram_chat_id,
        row.telegram_message_id,
        deps
      );
      if (!result.ok) {
        return res.status(502).json({ error: result.error || 'Telegram could not delete that message.', reason: result.reason });
      }

      const updated = result.row || (await db.getBotSentMessageById(id));
      res.json({ message: updated, reason: result.reason });
    } catch (err) {
      console.error('[BOT-MESSAGES API] delete failed:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { createBotMessagesRouter };
