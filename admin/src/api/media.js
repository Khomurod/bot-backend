/**
 * Translation and media staging shared by the message-composing screens.
 */

import { API_BASE, getHeaders, getAuthHeader, handleApiError } from './http';

export async function translateTexts(textBlocks) {
  const res = await fetch(`${API_BASE}/translate`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      source_language: 'en',
      target_languages: ['ru', 'uz'],
      text_blocks: textBlocks,
    }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const ru = Array.isArray(data.ru) ? data.ru : (typeof data.ru === "string" ? [data.ru] : []);
    const uz = Array.isArray(data.uz) ? data.uz : (typeof data.uz === "string" ? [data.uz] : []);
    const max = Math.max(ru.length, uz.length, textBlocks.length || 0);
    return Array.from({ length: max }, (_, idx) => ({
      ru: ru[idx] || "",
      uz: uz[idx] || "",
    }));
  }
  return [];
}

// Alias for App.jsx compatibility
export async function translateBroadcast(text) {
  const rows = await translateTexts([text]);
  return rows[0] || { ru: "", uz: "" };
}

/**
 * Upload a media file (photo or video) to Telegram via the server.
 * Returns { file_id, media_type } from Telegram.
 * Note: No Content-Type header — browser sets it with boundary for FormData.
 */
export async function uploadMedia(file) {
  const formData = new FormData();
  formData.append('media', file);
  const res = await fetch(`${API_BASE}/upload-media`, {
    method: 'POST',
    headers: getAuthHeader(),
    body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return {
    ...data,
    type: data.type || data.media_type || (file.type.startsWith("video/") ? "video" : "photo"),
  };
}

