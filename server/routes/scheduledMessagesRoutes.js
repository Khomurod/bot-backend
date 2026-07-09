/**
 * Scheduled message admin routes: create, list, cancel, send-now.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');
const { DateTime } = require('luxon');
const {
  DEFAULT_SCHEDULE_TIMEZONE,
  computeNextWeeklyOccurrence,
  isValidTimezone,
} = require('../../services/scheduledMessageUtils');
const {
  getNormalizedMediaItemsFromBody,
  formatScheduledMessageForResponse,
  validateBroadcastTemplates,
} = require('./helpers/broadcastBodyHelpers');

function createScheduledMessagesRoutes({
  db,
  authMiddleware,
  processScheduledMessage,
  normalizeActiveFilter,
}) {
  const router = express.Router();

  // POST /api/scheduled-messages — create a scheduled message
  router.post('/api/scheduled-messages', authMiddleware, async (req, res) => {
    try {
      const {
        message_text_en, message_text_ru, message_text_uz,
        media_file_id, media_type, media_position,
        target_type, target_driver_ids, target_languages,
        target_active_filter,
        force_language, scheduled_at_chicago,
        schedule_type, schedule_timezone,
        weekly_day_of_week, weekly_time_chicago,
      } = req.body;

      // Parse media first so photo/video-only scheduled messages (no caption) are allowed.
      let mediaItems = null;
      try {
        mediaItems = getNormalizedMediaItemsFromBody(req.body);
      } catch (mediaErr) {
        return res.status(400).json({ error: mediaErr.message });
      }
      const hasMedia = Array.isArray(mediaItems) && mediaItems.length > 0;

      // Validation
      const trimmedEn = (message_text_en || '').trim();
      if (!trimmedEn && !hasMedia) {
        return res.status(400).json({ error: 'Add a message or at least one photo/video before scheduling.' });
      }
      if (trimmedEn.length > 4096) {
        return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
      }
      const templateProblems = validateBroadcastTemplates({
        message_text: message_text_en,
        messages: {
          en: message_text_en,
          ru: message_text_ru,
          uz: message_text_uz,
        },
      });
      if (templateProblems.length > 0) {
        return res.status(400).json({
          error: 'Scheduled message contains unknown placeholders',
          details: templateProblems,
        });
      }
      const scheduleType = schedule_type === 'weekly' ? 'weekly' : 'one_time';
      const scheduleTimezone = schedule_timezone || DEFAULT_SCHEDULE_TIMEZONE;
      if (!isValidTimezone(scheduleTimezone)) {
        return res.status(400).json({ error: 'Invalid schedule_timezone' });
      }

      // Convert Chicago time → UTC
      let scheduledAtUtc;
      if (scheduleType === 'weekly') {
        if (!weekly_day_of_week || !weekly_time_chicago) {
          return res.status(400).json({ error: 'weekly_day_of_week and weekly_time_chicago are required for weekly schedules' });
        }
        const nextOccurrence = computeNextWeeklyOccurrence({
          dayOfWeek: weekly_day_of_week,
          timeOfDay: weekly_time_chicago,
          timezone: scheduleTimezone,
        });
        if (!nextOccurrence) {
          return res.status(400).json({ error: 'Invalid weekly schedule configuration' });
        }
        scheduledAtUtc = nextOccurrence.toUTC().toISO();
      } else {
        if (!scheduled_at_chicago) {
          return res.status(400).json({ error: 'Schedule date/time is required' });
        }
        const localScheduledTime = DateTime.fromISO(scheduled_at_chicago, { zone: scheduleTimezone });
        if (!localScheduledTime.isValid) {
          return res.status(400).json({ error: 'Invalid date/time format' });
        }
        if (localScheduledTime <= DateTime.now().setZone(scheduleTimezone)) {
          return res.status(400).json({ error: 'Scheduled time must be in the future' });
        }
        scheduledAtUtc = localScheduledTime.toUTC().toISO();
      }

      // Validate target_type
      const validTargetTypes = ['all', 'specific_drivers', 'language_groups'];
      const tt = target_type || 'all';
      if (!validTargetTypes.includes(tt)) {
        return res.status(400).json({ error: 'Invalid target_type' });
      }
      if (tt === 'specific_drivers' && (!target_driver_ids || target_driver_ids.length === 0)) {
        return res.status(400).json({ error: 'At least one driver must be selected' });
      }
      if (tt === 'language_groups' && (!target_languages || target_languages.length === 0)) {
        return res.status(400).json({ error: 'At least one language must be selected' });
      }

      const targetActiveFilter = normalizeActiveFilter({ target_active_filter });
      if (
        target_active_filter != null
        && target_active_filter !== ''
        && !['all', 'active', 'inactive'].includes(target_active_filter)
      ) {
        return res.status(400).json({ error: 'Invalid target_active_filter' });
      }

      // Validate force_language
      if (force_language && !['en', 'ru', 'uz'].includes(force_language)) {
        return res.status(400).json({ error: 'Invalid force_language' });
      }

      // mediaItems already parsed and validated above.

      const msg = await db.createScheduledMessage({
        message_text_en: trimmedEn,
        message_text_ru: message_text_ru?.trim() || null,
        message_text_uz: message_text_uz?.trim() || null,
        media_items: mediaItems,
        media_file_id: media_file_id || mediaItems?.[0]?.file_id || null,
        media_type: media_type || mediaItems?.[0]?.media_type || null,
        media_position: media_position || 'above',
        target_type: tt,
        target_driver_ids: target_driver_ids || null,
        target_languages: target_languages || null,
        target_active_filter: targetActiveFilter,
        force_language: force_language || null,
        scheduled_at: scheduledAtUtc,
        schedule_type: scheduleType,
        schedule_timezone: scheduleTimezone,
        weekly_day_of_week: scheduleType === 'weekly' ? parseInt(weekly_day_of_week, 10) : null,
        weekly_time_local: scheduleType === 'weekly' ? weekly_time_chicago : null,
      });

      console.log(`[API] Scheduled message created: id=${msg.id}, scheduled_at_utc=${scheduledAtUtc}`);
      res.status(201).json(formatScheduledMessageForResponse(msg));
    } catch (err) {
      console.error('[API] Error creating scheduled message:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduled-messages — list all scheduled messages
  router.get('/api/scheduled-messages', authMiddleware, async (req, res) => {
    try {
      const messages = await db.getAllScheduledMessages();
      // Convert UTC → Chicago for display
      const enriched = messages.map(formatScheduledMessageForResponse);
      res.json(enriched);
    } catch (err) {
      console.error('[API] Error fetching scheduled messages:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // PUT /api/scheduled-messages/:id/cancel — cancel a pending message
  router.put('/api/scheduled-messages/:id/cancel', authMiddleware, async (req, res) => {
    try {
      const msg = await db.getScheduledMessageById(req.params.id);
      if (!msg) return res.status(404).json({ error: 'Message not found' });
      if (msg.status !== 'pending') {
        return res.status(400).json({ error: 'Only pending messages can be cancelled' });
      }
      await db.updateScheduledMessageStatus(req.params.id, 'cancelled');
      console.log(`[API] Scheduled message cancelled: id=${req.params.id}`);
      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error cancelling scheduled message:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // PUT /api/scheduled-messages/:id/send-now — send a pending message immediately
  router.put('/api/scheduled-messages/:id/send-now', authMiddleware, async (req, res) => {
    try {
      const msg = await db.getScheduledMessageById(req.params.id);
      if (!msg) return res.status(404).json({ error: 'Message not found' });
      if (msg.status !== 'pending') {
        return res.status(400).json({ error: 'Only pending messages can be sent' });
      }

      const locked = await db.claimScheduledMessage(req.params.id);
      if (!locked) {
        return res.status(409).json({ error: 'Scheduled message is already being processed' });
      }

      const results = await processScheduledMessage(locked);
      console.log(`[API] Scheduled message sent now: id=${req.params.id}`);
      res.json({
        success: results.status !== 'failed',
        sent: results.sent,
        failed: results.failed,
        status: results.status,
        next_run_at: results.next_run_at || null,
      });
    } catch (err) {
      console.error('[API] Error sending scheduled message now:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { createScheduledMessagesRoutes };
