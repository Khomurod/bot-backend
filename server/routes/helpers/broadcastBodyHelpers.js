/**
 * Request-body helpers shared by the questions, broadcast, and
 * scheduled-message route modules.
 */
const { DateTime } = require('luxon');
const {
  DEFAULT_SCHEDULE_TIMEZONE,
  WEEKDAY_LABELS,
  describeWeeklySchedule,
  normalizeMediaItems,
} = require('../../../services/scheduledMessageUtils');
const { validateBroadcastTemplate } = require('../../../services/broadcastTemplateService');

function getNormalizedMediaItemsFromBody(body) {
  if (!Array.isArray(body?.media_items) || body.media_items.length === 0) {
    return null;
  }

  if (body.media_items.length > 10) {
    throw new Error('Maximum 10 media items allowed');
  }

  const normalized = normalizeMediaItems(body.media_items);
  if (normalized.length !== body.media_items.length) {
    throw new Error('Each media item must include a valid file_id and media type');
  }

  return normalized;
}

function formatScheduledMessageForResponse(msg) {
  const timezone = msg.schedule_timezone || DEFAULT_SCHEDULE_TIMEZONE;
  const nextRunChicago = DateTime.fromJSDate(new Date(msg.scheduled_at))
    .setZone(timezone)
    .toFormat('yyyy-MM-dd HH:mm');

  const mediaItems = normalizeMediaItems(msg.media_items);
  const mediaCount = mediaItems.length || (msg.media_file_id ? 1 : 0);

  return {
    ...msg,
    media_items: mediaItems.length ? mediaItems : msg.media_items,
    media_count: mediaCount,
    scheduled_at_chicago: nextRunChicago,
    schedule_type: msg.schedule_type || 'one_time',
    schedule_timezone: timezone,
    schedule_label: (msg.schedule_type || 'one_time') === 'weekly'
      ? describeWeeklySchedule(msg.weekly_day_of_week, msg.weekly_time_local, timezone)
      : `One time on ${nextRunChicago}`,
    weekly_day_label: msg.weekly_day_of_week ? WEEKDAY_LABELS[msg.weekly_day_of_week] || null : null,
    last_sent_at_chicago: msg.last_sent_at
      ? DateTime.fromJSDate(new Date(msg.last_sent_at)).setZone(timezone).toFormat('yyyy-MM-dd HH:mm')
      : null,
  };
}

function validateBroadcastTemplates(payload = {}) {
  const problems = [];
  const values = [];
  if (payload.message_text) values.push({ lang: 'base', text: payload.message_text });
  if (payload.messages && typeof payload.messages === 'object') {
    for (const lang of ['en', 'ru', 'uz']) {
      if (payload.messages[lang]) values.push({ lang, text: payload.messages[lang] });
    }
  }
  for (const item of values) {
    const verdict = validateBroadcastTemplate(item.text);
    if (!verdict.valid) {
      problems.push({
        lang: item.lang,
        unknown_tokens: verdict.unknownTokens,
      });
    }
  }
  return problems;
}

module.exports = {
  getNormalizedMediaItemsFromBody,
  formatScheduledMessageForResponse,
  validateBroadcastTemplates,
};
