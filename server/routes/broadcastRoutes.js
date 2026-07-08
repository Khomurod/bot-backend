/**
 * Broadcast admin routes: placeholders, immediate + confirmation broadcasts
 * (send/test), broadcast history, deliveries, and button clicks.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');
const {
  getNormalizedMediaItemsFromBody,
  validateBroadcastTemplates,
} = require('./helpers/broadcastBodyHelpers');

function createBroadcastRoutes({
  db,
  authMiddleware,
  sendBroadcastToGroups,
  sendBroadcastTest,
  sendConfirmationBroadcast,
  sendConfirmationBroadcastTest,
  resolveBroadcastTargetGroups,
  normalizeActiveFilter,
  listBroadcastPlaceholders,
}) {
  const router = express.Router();

  router.get('/api/broadcast/placeholders', authMiddleware, async (req, res) => {
    try {
      res.json({ placeholders: listBroadcastPlaceholders() });
    } catch (err) {
      console.error('[API] Error loading broadcast placeholders:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/broadcast/send
  router.post('/api/broadcast/send', authMiddleware, async (req, res) => {
    try {
      const {
        message_text,
        parse_mode,
        messages,
        target_type,
        target_driver_ids,
        target_languages,
        force_language,
      } = req.body;

      let normalizedTargetType = target_type || 'all';
      let storedDriverIds = target_driver_ids;
      let storedLanguages = target_languages;
      if (!target_type && Array.isArray(req.body.group_ids) && req.body.group_ids.length > 0) {
        normalizedTargetType = 'specific_drivers';
        storedDriverIds = req.body.group_ids;
      }

      // Parse media first so photo/video-only broadcasts (no caption) are allowed.
      let mediaItems = null;
      const mediaPosition = req.body.media_position || 'above';
      try {
        mediaItems = getNormalizedMediaItemsFromBody(req.body);
      } catch (mediaErr) {
        return res.status(400).json({ error: mediaErr.message });
      }
      const hasMedia = Array.isArray(mediaItems) && mediaItems.length > 0;

      const primaryText = ((messages && messages.en) || message_text || '').trim();
      if (!primaryText && !hasMedia) {
        return res.status(400).json({ error: 'Add a message or at least one photo/video before sending.' });
      }
      if (primaryText.length > 4096) {
        return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
      }
      const templateProblems = validateBroadcastTemplates({ message_text, messages });
      if (templateProblems.length > 0) {
        return res.status(400).json({
          error: 'Broadcast message contains unknown placeholders',
          details: templateProblems,
        });
      }

      const mode = ['HTML', 'MarkdownV2'].includes(parse_mode) ? parse_mode : 'HTML';

      const targetGroups = await resolveBroadcastTargetGroups({
        ...req.body,
        target_type: normalizedTargetType,
        target_driver_ids: storedDriverIds,
        target_languages: storedLanguages,
      });
      if (!targetGroups || targetGroups.length === 0) {
        return res.status(400).json({ error: 'No valid target groups found. Broadcast aborted.' });
      }

      const targetActiveFilter = normalizeActiveFilter(req.body);

      const broadcast = await db.createBroadcast({
        type: 'regular',
        message_text_en: messages ? messages.en : primaryText.trim(),
        message_text_ru: messages ? messages.ru : null,
        message_text_uz: messages ? messages.uz : null,
        media_items: mediaItems,
        media_position: mediaPosition,
        parse_mode: mode,
        target_type: normalizedTargetType,
        target_driver_ids: storedDriverIds || null,
        target_languages: storedLanguages || null,
        force_language: force_language || null,
        target_active_filter: targetActiveFilter,
      });

      const results = await sendBroadcastToGroups(
        targetGroups,
        primaryText.trim(),
        mode,
        messages || null,
        mediaItems,
        mediaPosition,
        broadcast.id,
        force_language || null
      );
      res.json({ ...results, broadcast_id: broadcast.id });
    } catch (err) {
      console.error('[API] Error sending broadcast:', err.message);
      res.status(500).json({ error: err.message || 'Failed to send broadcast' });
    }
  });

  // POST /api/broadcast/test
  router.post('/api/broadcast/test', authMiddleware, async (req, res) => {
    try {
      const { message_text, parse_mode, messages, force_language } = req.body;

      // Parse media first so photo/video-only test broadcasts (no caption) are allowed.
      let mediaItems = null;
      const mediaPosition = req.body.media_position || 'above';
      try {
        mediaItems = getNormalizedMediaItemsFromBody(req.body);
      } catch (mediaErr) {
        return res.status(400).json({ error: mediaErr.message });
      }
      const hasMedia = Array.isArray(mediaItems) && mediaItems.length > 0;

      const primaryText = ((messages && messages.en) || message_text || '').trim();
      if (!primaryText && !hasMedia) {
        return res.status(400).json({ error: 'Add a message or at least one photo/video before sending.' });
      }
      if (primaryText.length > 4096) {
        return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
      }
      const templateProblems = validateBroadcastTemplates({ message_text, messages });
      if (templateProblems.length > 0) {
        return res.status(400).json({
          error: 'Broadcast message contains unknown placeholders',
          details: templateProblems,
        });
      }

      const mode = ['HTML', 'MarkdownV2'].includes(parse_mode) ? parse_mode : 'HTML';

      await sendBroadcastTest(
        primaryText.trim(),
        mode,
        messages || null,
        mediaItems,
        mediaPosition,
        force_language || null
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error sending broadcast test:', err.message);
      res.status(500).json({ error: err.message || 'Failed to send broadcast test' });
    }
  });

  // POST /api/broadcast/confirmation/send
  router.post('/api/broadcast/confirmation/send', authMiddleware, async (req, res) => {
    try {
      const {
        message_text,
        parse_mode,
        messages,
        buttons,
        target_type,
        target_driver_ids,
        target_languages,
        force_language,
      } = req.body;

      let normalizedTargetType = target_type || 'all';
      let storedDriverIds = target_driver_ids;
      let storedLanguages = target_languages;
      if (!target_type && Array.isArray(req.body.group_ids) && req.body.group_ids.length > 0) {
        normalizedTargetType = 'specific_drivers';
        storedDriverIds = req.body.group_ids;
      }

      const primaryText = (messages && messages.en) || message_text;
      if (!primaryText || !primaryText.trim()) {
        return res.status(400).json({ error: 'Message text is required' });
      }
      if (primaryText.length > 4096) {
        return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
      }
      const templateProblems = validateBroadcastTemplates({ message_text, messages });
      if (templateProblems.length > 0) {
        return res.status(400).json({
          error: 'Broadcast message contains unknown placeholders',
          details: templateProblems,
        });
      }
      if (!buttons || !Array.isArray(buttons) || buttons.length === 0) {
        return res.status(400).json({ error: 'At least one button is required' });
      }

      const mode = ['HTML', 'MarkdownV2'].includes(parse_mode) ? parse_mode : 'HTML';

      let mediaItems = null;
      const mediaPosition = req.body.media_position || 'above';
      try {
        mediaItems = getNormalizedMediaItemsFromBody(req.body);
      } catch (mediaErr) {
        return res.status(400).json({ error: mediaErr.message });
      }

      const targetGroups = await resolveBroadcastTargetGroups({
        ...req.body,
        target_type: normalizedTargetType,
        target_driver_ids: storedDriverIds,
        target_languages: storedLanguages,
      });
      if (!targetGroups || targetGroups.length === 0) {
        return res.status(400).json({ error: 'No valid target groups found. Broadcast aborted.' });
      }

      const targetActiveFilter = normalizeActiveFilter(req.body);

      const broadcast = await db.createBroadcast({
        type: 'confirmation',
        message_text_en: messages ? messages.en : primaryText.trim(),
        message_text_ru: messages ? messages.ru : null,
        message_text_uz: messages ? messages.uz : null,
        media_items: mediaItems,
        media_position: mediaPosition,
        parse_mode: mode,
        buttons: buttons,
        target_type: normalizedTargetType,
        target_driver_ids: storedDriverIds || null,
        target_languages: storedLanguages || null,
        force_language: force_language || null,
        target_active_filter: targetActiveFilter,
      });

      const results = await sendConfirmationBroadcast(
        primaryText.trim(),
        mode,
        messages || null,
        mediaItems,
        mediaPosition,
        buttons,
        broadcast.id,
        targetGroups,
        force_language || null
      );
      res.json({ ...results, broadcast_id: broadcast.id });
    } catch (err) {
      console.error('[API] Error sending confirmation broadcast:', err.message);
      res.status(500).json({ error: err.message || 'Failed to send confirmation broadcast' });
    }
  });

  // POST /api/broadcast/confirmation/test
  router.post('/api/broadcast/confirmation/test', authMiddleware, async (req, res) => {
    try {
      const { message_text, parse_mode, messages, buttons, force_language } = req.body;

      const primaryText = (messages && messages.en) || message_text;
      if (!primaryText || !primaryText.trim()) {
        return res.status(400).json({ error: 'Message text is required' });
      }
      if (primaryText.length > 4096) {
        return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
      }
      const templateProblems = validateBroadcastTemplates({ message_text, messages });
      if (templateProblems.length > 0) {
        return res.status(400).json({
          error: 'Broadcast message contains unknown placeholders',
          details: templateProblems,
        });
      }

      const mode = ['HTML', 'MarkdownV2'].includes(parse_mode) ? parse_mode : 'HTML';

      let mediaItems = null;
      const mediaPosition = req.body.media_position || 'above';
      try {
        mediaItems = getNormalizedMediaItemsFromBody(req.body);
      } catch (mediaErr) {
        return res.status(400).json({ error: mediaErr.message });
      }

      await sendConfirmationBroadcastTest(
        primaryText.trim(),
        mode,
        messages || null,
        mediaItems,
        mediaPosition,
        buttons || [],
        force_language || null
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error sending confirmation broadcast test:', err.message);
      res.status(500).json({ error: err.message || 'Failed to send confirmation broadcast test' });
    }
  });

  // GET /api/broadcasts
  router.get('/api/broadcasts', authMiddleware, async (req, res) => {
    try {
      const type = req.query.type || 'regular';
      const broadcasts = await db.getBroadcasts(type);
      res.json(broadcasts);
    } catch (err) {
      console.error('[API] Error fetching broadcasts:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/broadcasts/:id/deliveries
  router.get('/api/broadcasts/:id/deliveries', authMiddleware, async (req, res) => {
    try {
      const deliveries = await db.getBroadcastDeliveries(req.params.id);
      res.json(deliveries);
    } catch (err) {
      console.error('[API] Error fetching deliveries:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/broadcasts/:id/clicks
  router.get('/api/broadcasts/:id/clicks', authMiddleware, async (req, res) => {
    try {
      const clicks = await db.getBroadcastButtonClicks(req.params.id);
      res.json(clicks);
    } catch (err) {
      console.error('[API] Error fetching button clicks:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { createBroadcastRoutes };
