/**
 * Automatic message reactions admin API — mounted at /api/auto-reactions.
 *
 *  GET    /            → { rules, allowed_emojis }
 *  POST   /            → create/update a rule for a user (id and/or username)
 *  PUT    /:id         → update a rule's emoji and/or enabled flag
 *  DELETE /:id         → remove a rule
 *
 * The bot caches enabled rules in memory, so every mutation invalidates that
 * cache to apply promptly.
 */
const express = require('express');
const autoReactionsDb = require('../../database/autoReactions');
const { invalidateAutoReactionCache } = require('../../services/autoReactionService');
const {
  ALLOWED_REACTION_EMOJIS, isAllowedReactionEmoji, normalizeUsername, normalizeUserId,
} = require('../../services/autoReactionConstants');

/** Serialize a rule row for the admin (BIGINT id → string to keep precision). */
function shapeRule(row) {
  return {
    id: row.id,
    telegram_user_id: row.telegram_user_id != null ? String(row.telegram_user_id) : null,
    telegram_username: row.telegram_username || null,
    emoji: row.emoji,
    enabled: Boolean(row.enabled),
    note: row.note || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function createAutoReactionsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const rows = await autoReactionsDb.listAutoReactionRules();
      res.json({ rules: rows.map(shapeRule), allowed_emojis: ALLOWED_REACTION_EMOJIS });
    } catch (err) {
      console.error('[AUTO-REACTION API] list failed:', err.message);
      res.status(500).json({ error: 'Failed to load reaction rules.' });
    }
  });

  router.post('/', authMiddleware, async (req, res) => {
    try {
      const b = req.body || {};
      const emoji = typeof b.emoji === 'string' ? b.emoji : '';
      if (!isAllowedReactionEmoji(emoji)) {
        return res.status(400).json({ error: 'emoji must be one of the supported Telegram reactions' });
      }
      const telegramUserId = normalizeUserId(b.telegram_user_id);
      const telegramUsername = b.telegram_username ? normalizeUsername(b.telegram_username) : null;
      if (b.telegram_username && !telegramUsername) {
        return res.status(400).json({ error: 'telegram_username is not a valid Telegram username' });
      }
      if (!telegramUserId && !telegramUsername) {
        return res.status(400).json({ error: 'Provide a user from the list or a Telegram username' });
      }
      const rule = await autoReactionsDb.upsertAutoReactionRule({
        telegramUserId,
        telegramUsername,
        emoji,
        enabled: b.enabled === undefined ? true : Boolean(b.enabled),
        note: b.note ? String(b.note).slice(0, 200) : null,
        createdBy: req.admin?.username || null,
      });
      invalidateAutoReactionCache();
      res.json({ rule: shapeRule(rule) });
    } catch (err) {
      console.error('[AUTO-REACTION API] create failed:', err.message);
      res.status(500).json({ error: 'Failed to save reaction rule.' });
    }
  });

  router.put('/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!(id > 0)) return res.status(400).json({ error: 'Invalid rule id' });
      const b = req.body || {};
      const patch = {};
      if (b.emoji !== undefined) {
        if (!isAllowedReactionEmoji(b.emoji)) {
          return res.status(400).json({ error: 'emoji must be one of the supported Telegram reactions' });
        }
        patch.emoji = b.emoji;
      }
      if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
      if (patch.emoji === undefined && patch.enabled === undefined) {
        return res.status(400).json({ error: 'Provide emoji and/or enabled' });
      }
      const rule = await autoReactionsDb.updateAutoReactionRule(id, patch);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      invalidateAutoReactionCache();
      res.json({ rule: shapeRule(rule) });
    } catch (err) {
      console.error('[AUTO-REACTION API] update failed:', err.message);
      res.status(500).json({ error: 'Failed to update reaction rule.' });
    }
  });

  router.delete('/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!(id > 0)) return res.status(400).json({ error: 'Invalid rule id' });
      const removed = await autoReactionsDb.deleteAutoReactionRule(id);
      if (!removed) return res.status(404).json({ error: 'Rule not found' });
      invalidateAutoReactionCache();
      res.json({ deleted: true });
    } catch (err) {
      console.error('[AUTO-REACTION API] delete failed:', err.message);
      res.status(500).json({ error: 'Failed to delete reaction rule.' });
    }
  });

  return router;
}

module.exports = { createAutoReactionsRouter };
