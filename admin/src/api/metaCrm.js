/**
 * Settings → Facebook ↔ Bitrix: the Meta Conversions API for CRM credentials.
 *
 * The token goes to the server only in a request BODY (Test and Save) and
 * never comes back: the settings carry its last four characters only.
 */
import { API_BASE, getHeaders, handleApiError } from './http';

export async function getMetaCrmSettings() {
  const res = await fetch(`${API_BASE}/settings/meta-crm`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Checks a–d on the values in the form, which are NOT saved. → { passed, checks, usedStoredToken } */
export async function testMetaCrmSettings({ datasetId, token, testEventCode }) {
  const res = await fetch(`${API_BASE}/settings/meta-crm/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ datasetId, token, testEventCode }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Save (the server proves the token again first) and switch the sync on. */
export async function saveMetaCrmSettings({ datasetId, token }) {
  const res = await fetch(`${API_BASE}/settings/meta-crm`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ datasetId, token }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

export async function setMetaCrmEnabled(enabled) {
  const res = await fetch(`${API_BASE}/settings/meta-crm/enabled`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}
