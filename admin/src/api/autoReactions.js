/**
 * Settings → Reactions: the rules for which emoji the bot reacts with, and to
 * whom. Server side: server/routes/autoReactionsRoutes.js.
 */
import { API_BASE, getHeaders, handleApiError } from './http';

export async function getAutoReactions() {
  const res = await fetch(`${API_BASE}/auto-reactions`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createAutoReaction(payload) {
  const res = await fetch(`${API_BASE}/auto-reactions`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateAutoReaction(id, patch) {
  const res = await fetch(`${API_BASE}/auto-reactions/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteAutoReaction(id) {
  const res = await fetch(`${API_BASE}/auto-reactions/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
