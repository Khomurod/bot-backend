/**
 * Message Manager (edit/delete a bot message via its t.me link).
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');

function parseTgUrl(url) {
  try {
    // Matches private links: [https://t.me/c/1234567890/5044](https://t.me/c/1234567890/5044)
    const privateMatch = url.match(/t\.me\/c\/(\d+)\/(\d+)/);
    if (privateMatch) return { chatId: `-100${privateMatch[1]}`, messageId: parseInt(privateMatch[2], 10) };

    // Matches public links: [https://t.me/groupname/5044](https://t.me/groupname/5044)
    const publicMatch = url.match(/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
    if (publicMatch) return { chatId: `@${publicMatch[1]}`, messageId: parseInt(publicMatch[2], 10) };

    return null;
  } catch (e) { return null; }
}

function createMessageManagerRoutes({ authMiddleware, bot }) {
  const router = express.Router();

  router.post('/api/message/delete', authMiddleware, async (req, res) => {
    try {
      const { url } = req.body;
      const parsed = parseTgUrl(url);
      if (!parsed) return res.status(400).json({ error: 'Invalid Telegram message URL format.' });

      await bot.telegram.deleteMessage(parsed.chatId, parsed.messageId);
      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error deleting message:', err.message);
      res.status(500).json({ error: err.message || 'Failed to delete message' });
    }
  });

  router.post('/api/message/edit', authMiddleware, async (req, res) => {
    try {
      const { url, newText } = req.body;
      if (!newText) return res.status(400).json({ error: 'New text is required.' });

      const parsed = parseTgUrl(url);
      if (!parsed) return res.status(400).json({ error: 'Invalid Telegram message URL format.' });

      try {
        // Attempt to edit as a standard text message
        await bot.telegram.editMessageText(parsed.chatId, parsed.messageId, undefined, newText, { parse_mode: 'HTML', disable_web_page_preview: true });
      } catch (editErr) {
        // If it fails because the message has media, attempt to edit the caption instead
        if (editErr.description && editErr.description.includes('there is no text in the message to edit')) {
          await bot.telegram.editMessageCaption(parsed.chatId, parsed.messageId, undefined, newText, { parse_mode: 'HTML' });
        } else {
          throw editErr;
        }
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error editing message:', err.message);
      res.status(500).json({ error: err.message || 'Failed to edit message' });
    }
  });

  return router;
}

module.exports = { createMessageManagerRoutes };
