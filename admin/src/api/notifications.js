import { API_BASE, getHeaders, handleApiError } from './http';

/** Where Wenze's operational notices go, plus the category catalogue and queue health. */
export async function getNotificationSettings() {
  const res = await fetch(`${API_BASE}/settings/notifications`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Omitted fields keep their stored value; an empty category id clears that override. */
export async function updateNotificationSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/notifications`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/**
 * Prove a destination before trusting it with real alerts. Answers 200 with
 * `{ok:false, error}` on a refusal — the request succeeded, the send did not.
 */
export async function testNotificationChat(chatId) {
  const res = await fetch(`${API_BASE}/settings/notifications/test`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ chatId }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Send one real notice of a category, so its destination and shape are visible. */
export async function previewNotification(category) {
  const res = await fetch(`${API_BASE}/settings/notifications/preview`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ category }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
