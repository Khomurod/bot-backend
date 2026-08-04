/**
 * Safety-event driver-group music overlay: settings and the audio library.
 */

import { API_BASE, getHeaders, getAuthHeader, handleApiError } from './http';

// ── Safety-event driver-group music overlay ─────────────────────────────────
// Returns { settings, activeMusic, musicAssets } (music bytes are never included).
export async function getSafetyEventSettings() {
  const res = await fetch(`${API_BASE}/settings/safety-events`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateSafetyEventSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/safety-events`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Upload a music clip (multipart). Returns the refreshed settings view. */
export async function uploadSafetyEventMusic(file, { name, description } = {}) {
  const formData = new FormData();
  formData.append('file', file);
  if (name) formData.append('name', name);
  if (description) formData.append('description', description);
  const res = await fetch(`${API_BASE}/settings/safety-events/music`, {
    method: 'POST',
    headers: getAuthHeader(),
    body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function activateSafetyEventMusic(id) {
  const res = await fetch(`${API_BASE}/settings/safety-events/music/${id}/activate`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deactivateSafetyEventMusic(id) {
  const res = await fetch(`${API_BASE}/settings/safety-events/music/${id}/deactivate`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteSafetyEventMusic(id) {
  const res = await fetch(`${API_BASE}/settings/safety-events/music/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

