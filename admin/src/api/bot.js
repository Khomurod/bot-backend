/**
 * The bot's own records: everyone who has tapped an inline button, and the
 * registry of every message the bot has sent (with edit/delete).
 */

import { API_BASE, getHeaders, handleApiError } from './http';

// ─── Bot Users (everyone who has tapped the bot's inline buttons) ───

export async function getBotUsers({ limit = 200, filter, search } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (filter && filter !== 'all') params.set('filter', filter);
  if (search) params.set('search', search);
  const res = await fetch(`${API_BASE}/bot-users?${params.toString()}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Bot Messages (registry of every message the bot has sent) ───

/** List bot-sent messages, newest first, with optional filters + pagination. */
export async function getBotMessages({ chatId, search, dateFrom, dateTo, includeDeleted, limit, offset } = {}) {
  const params = new URLSearchParams();
  if (chatId) params.set('chatId', chatId);
  if (search) params.set('search', search);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  if (includeDeleted === false) params.set('includeDeleted', 'false');
  if (limit != null) params.set('limit', String(limit));
  if (offset != null) params.set('offset', String(offset));
  const res = await fetch(`${API_BASE}/bot-messages?${params.toString()}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Edit a bot-sent message's text in Telegram by registry id. */
export async function editBotMessage(id, newText) {
  const res = await fetch(`${API_BASE}/bot-messages/${id}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({ newText }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Delete a bot-sent message in Telegram by registry id. */
export async function deleteBotMessage(id) {
  const res = await fetch(`${API_BASE}/bot-messages/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

