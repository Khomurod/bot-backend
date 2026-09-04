/**
 * Scheduled messages: queueing, listing, cancelling, and sending early.
 */

import { API_BASE, appendTargetActiveFilter, getHeaders, handleApiError } from './http';

// ─── Scheduled Messages API ───

export async function getDriverGroups() {
  const res = await fetch(`${API_BASE}/groups/driver-list`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createScheduledMessage(data) {
  const {
    messageEn,
    messageRu,
    messageUz,
    mediaItems,
    mediaPosition,
    targetType,
    targetActiveFilter,
    selectedDriverIds,
    selectedLanguages,
    forceLanguage,
    scheduleType,
    scheduledAtChicago,
    weeklyDayOfWeek,
    weeklyTimeChicago,
    scheduleTimezone,
  } = data;
  const body = messageEn !== undefined
    ? {
        message_text_en: messageEn,
        message_text_ru: messageRu || null,
        message_text_uz: messageUz || null,
        target_type: targetType || 'all',
        target_driver_ids: targetType === 'specific_drivers' ? selectedDriverIds : undefined,
        target_languages: targetType === 'language_groups' ? selectedLanguages : undefined,
        force_language: forceLanguage || null,
        media_items: mediaItems && mediaItems.length > 0
          ? mediaItems.map((m) => ({ file_id: m.file_id, media_type: m.type || m.media_type }))
          : null,
        media_position: mediaPosition || 'above',
        schedule_type: scheduleType || 'one_time',
        scheduled_at_chicago: scheduleType === 'weekly' ? null : scheduledAtChicago,
        weekly_day_of_week: scheduleType === 'weekly' ? weeklyDayOfWeek : null,
        weekly_time_chicago: scheduleType === 'weekly' ? weeklyTimeChicago : null,
        schedule_timezone: scheduleTimezone || 'America/Chicago',
      }
    : data;
  if (messageEn !== undefined) {
    appendTargetActiveFilter(body, targetType || 'all', targetActiveFilter);
  }

  const res = await fetch(`${API_BASE}/scheduled-messages`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getScheduledMessages() {
  const res = await fetch(`${API_BASE}/scheduled-messages`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function cancelScheduledMessage(id) {
  const res = await fetch(`${API_BASE}/scheduled-messages/${id}/cancel`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendScheduledMessageNow(id) {
  const res = await fetch(`${API_BASE}/scheduled-messages/${id}/send-now`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

