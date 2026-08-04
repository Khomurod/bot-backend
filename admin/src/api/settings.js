/**
 * Settings screens that configure an external integration.
 *
 * Google Maps (Route Control), BOL/POD document forwarding, the live-location
 * ELD provider, Telegram message routing, and RingCentral. Each has the same
 * shape — read, update, test — so they share one module.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

// ─── Settings: Google Maps Platform (Route Control) ───

/** Masked Google Maps settings (never returns the raw API key). */
export async function getGmapsSettings() {
  const res = await fetch(`${API_BASE}/settings/gmaps`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Update Google Maps settings. Omit the key to leave it unchanged. */
export async function updateGmapsSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/gmaps`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Test the Google Maps API key (candidate key optional). Returns { connected, message }. */
export async function testGmapsConnection(apiKey) {
  const res = await fetch(`${API_BASE}/settings/gmaps/test`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify(apiKey ? { apiKey } : {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Settings: BOL / POD document forwarding ───

export async function getBolPodSettings() {
  const res = await fetch(`${API_BASE}/settings/bol-pod`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

export async function updateBolPodSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/bol-pod`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Validate the central Telegram group server-side. Returns { ok, title?, message }. */
export async function validateBolPodGroup(groupId) {
  const res = await fetch(`${API_BASE}/settings/bol-pod/validate-group`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ groupId }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Send a harmless test message to the central group. Returns { ok, message }. */
export async function sendBolPodTestMessage(groupId) {
  const res = await fetch(`${API_BASE}/settings/bol-pod/test-message`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify(groupId ? { groupId } : {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getBolPodStatus() {
  const res = await fetch(`${API_BASE}/settings/bol-pod/status`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getBolPodDeliveries(limit = 30) {
  const res = await fetch(
    `${API_BASE}/settings/bol-pod/deliveries?limit=${encodeURIComponent(limit)}`,
    { headers: getHeaders() },
  );
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.deliveries;
}

/** Manual retry of a delivery's failed destination(s). Returns the updated delivery. */
export async function retryBolPodDelivery(id) {
  const res = await fetch(
    `${API_BASE}/settings/bol-pod/deliveries/${encodeURIComponent(id)}/retry`,
    { method: 'POST', headers: getHeaders() },
  );
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.delivery;
}


// ─── Settings: live-location (ELD) provider credentials ───

/** Masked ELD provider settings (never returns raw secrets). */
export async function getEldSettings() {
  const res = await fetch(`${API_BASE}/settings/eld`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Update ELD provider settings. Omit a secret field to leave it unchanged. */
export async function updateEldSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/eld`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/**
 * Live connectivity test for one provider ('samsara' | 'factor' | 'leader').
 * Optional candidate keys let you verify BEFORE saving; optional groupTitle
 * checks a specific unit. Returns { connected, message }.
 */
export async function testEldProvider(payload) {
  const res = await fetch(`${API_BASE}/settings/eld/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Settings: message routing (Telegram group per message category) ───

/** Telegram group IDs per bonus / review category (not secret — plaintext). */
export async function getMessageGroupSettings() {
  const res = await fetch(`${API_BASE}/settings/message-groups`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Update the Telegram group ID for one or more message categories. */
export async function updateMessageGroupSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/message-groups`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

// ─── Settings: RingCentral recruiter-call KPIs ───

export async function getRingCentralSettings() {
  const res = await fetch(`${API_BASE}/settings/ringcentral`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

export async function updateRingCentralSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/ringcentral`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

export async function testRingCentral(payload) {
  const res = await fetch(`${API_BASE}/settings/ringcentral/test`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

