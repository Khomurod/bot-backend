/**
 * Sending messages to driver groups.
 *
 * Covers plain broadcasts, confirmation broadcasts (the button-click variety),
 * and reading back their delivery and click history.
 */

import { API_BASE, appendTargetActiveFilter, getHeaders, handleApiError } from './http';

// Support both object and positional arguments for compatibility
export async function sendBroadcast(dataOrText, parseMode, messages, mediaItems, mediaPosition, groupIds) {
  let body;
  if (typeof dataOrText === 'object') {
    if (dataOrText.type === 'confirmation') {
      return sendConfirmationBroadcast(dataOrText);
    }
    const {
      messageEn,
      messageRu,
      messageUz,
      type,
      targetType,
      targetActiveFilter,
      selectedDriverIds,
      selectedLanguages,
      forceLanguage,
      mediaItems: items,
      mediaPosition: pos,
    } = dataOrText;
    body = {
      message_text: messageEn,
      messages: { en: messageEn, ru: messageRu, uz: messageUz },
      target_type: targetType || 'all',
      target_driver_ids: targetType === 'specific_drivers' ? selectedDriverIds : undefined,
      target_languages: targetType === 'language_groups' ? selectedLanguages : undefined,
      force_language: forceLanguage || null,
      media_items: items ? items.map(m => ({ file_id: m.file_id, media_type: m.type })) : null,
      media_position: pos || 'above',
    };
    appendTargetActiveFilter(body, targetType || 'all', targetActiveFilter);
  } else {
    body = { message_text: dataOrText, parse_mode: parseMode };
    if (messages) body.messages = messages;
    if (groupIds && groupIds.length > 0) body.group_ids = groupIds;
    if (mediaItems && mediaItems.length > 0) {
      body.media_items = mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type }));
      body.media_position = mediaPosition || 'above';
    }
  }
  
  const res = await fetch(`${API_BASE}/broadcast/send`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function testBroadcast(data) {
  if (data.type === 'confirmation') {
    return sendConfirmationBroadcastTest(data);
  }
  const { messageEn, messageRu, messageUz, mediaItems, mediaPosition, forceLanguage } = data;
  const body = {
    message_text: messageEn,
    messages: { en: messageEn, ru: messageRu, uz: messageUz },
    force_language: forceLanguage || null,
    media_items: mediaItems ? mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type })) : null,
    media_position: mediaPosition || 'above',
  };
  const res = await fetch(`${API_BASE}/broadcast/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// Positional version for compatibility
export async function sendBroadcastTest(messageText, parseMode, mediaItems, mediaPosition) {
    return testBroadcast({ messageEn: messageText, mediaItems, mediaPosition });
}


// ─── Confirmation Broadcast API ───

export async function sendConfirmationBroadcast(data) {
  const {
    messageEn,
    messageRu,
    messageUz,
    buttons,
    mediaItems,
    mediaPosition,
    targetType,
    targetActiveFilter,
    selectedDriverIds,
    selectedLanguages,
    forceLanguage,
  } = data;
  const body = {
    message_text: messageEn,
    messages: { en: messageEn, ru: messageRu, uz: messageUz },
    buttons,
    target_type: targetType || 'all',
    target_driver_ids: targetType === 'specific_drivers' ? selectedDriverIds : undefined,
    target_languages: targetType === 'language_groups' ? selectedLanguages : undefined,
    force_language: forceLanguage || null,
    media_items: mediaItems ? mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type })) : null,
    media_position: mediaPosition || 'above',
  };
  appendTargetActiveFilter(body, targetType || 'all', targetActiveFilter);
  const res = await fetch(`${API_BASE}/broadcast/confirmation/send`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendConfirmationBroadcastTest(data) {
  const {
    messageEn,
    messageRu,
    messageUz,
    buttons,
    mediaItems,
    mediaPosition,
    targetType,
    selectedDriverIds,
    selectedLanguages,
    forceLanguage,
  } = data;
  const body = {
    message_text: messageEn,
    messages: { en: messageEn, ru: messageRu, uz: messageUz },
    buttons,
    force_language: forceLanguage || null,
    target_type: targetType || 'all',
    target_driver_ids: targetType === 'specific_drivers' ? selectedDriverIds : undefined,
    target_languages: targetType === 'language_groups' ? selectedLanguages : undefined,
    media_items: mediaItems ? mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type })) : null,
    media_position: mediaPosition || 'above',
  };
  const res = await fetch(`${API_BASE}/broadcast/confirmation/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getBroadcasts(type) {
  const res = await fetch(`${API_BASE}/broadcasts?type=${encodeURIComponent(type || 'regular')}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// Alias for App.jsx compatibility
export const getBroadcastHistory = getBroadcasts;

export async function getBroadcastDeliveries(broadcastId) {
  const res = await fetch(`${API_BASE}/broadcasts/${broadcastId}/deliveries`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getBroadcastButtonClicks(broadcastId) {
  const res = await fetch(`${API_BASE}/broadcasts/${broadcastId}/clicks`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// Alias for App.jsx compatibility
export const getConfirmationClicks = getBroadcastButtonClicks;

