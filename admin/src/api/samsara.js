/**
 * The Samsara integration settings area.
 *
 * Connection (API key, base URL, enabled), the safety-event operational
 * switches and the missing-video recovery controls — all one row, read by both
 * this app and the separate Samsara poller over the shared database.
 *
 * The API key is write-only from the browser: reads return only a masked hint,
 * `testSamsaraConnection` can verify a candidate key BEFORE it is saved, and
 * leaving the field blank on save keeps the stored key.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

/** Returns { settings, recovery } — settings.apiKeyMasked, never the key. */
export async function getSamsaraSettings() {
  const res = await fetch(`${API_BASE}/settings/samsara`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Update Samsara settings. Omit apiKey to leave the stored key unchanged. */
export async function updateSamsaraSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/samsara`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Test the stored key, or a candidate one. Returns { connected, message }. */
export async function testSamsaraConnection(apiKey) {
  const res = await fetch(`${API_BASE}/settings/samsara/test`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify(apiKey ? { apiKey } : {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Pending / finished missing-video recoveries. Returns { byStatus, nextDueAt, jobs }. */
export async function getSamsaraVideoRecovery({ limit = 25, status = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set('status', status);
  const res = await fetch(`${API_BASE}/settings/samsara/video-recovery?${params}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
