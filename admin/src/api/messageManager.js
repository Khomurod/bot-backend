/**
 * Messages → Edit by Link: change or delete a message the bot already sent,
 * addressed by its Telegram link. Mirrors server/routes/messageManagerRoutes.js.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

export async function editTelegramMessage(url, newText) {
  const res = await fetch(`${API_BASE}/message/edit`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ url, newText })
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteTelegramMessage(url) {
  const res = await fetch(`${API_BASE}/message/delete`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ url })
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
