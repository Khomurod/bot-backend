/**
 * Admin → Settings → AI.
 *
 * `testAiProvider` sends the key the operator has just typed, which is the
 * whole point of it: testing the stored key would only report the state they
 * are already in. It answers 200 with `ok: false` for a rejected key — the
 * request succeeded, and what failed is the thing being tested — so a mistyped
 * key must NOT be rendered as a server fault.
 */
import { API_BASE, getHeaders, handleApiError } from './http';

/** Returns { settings, providers, capabilities, health, recentFailures }. Keys are masked. */
export async function getAiSettings() {
  const res = await fetch(`${API_BASE}/settings/ai`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateAiSettings(patch) {
  const res = await fetch(`${API_BASE}/settings/ai`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Omit `apiKey` to leave the stored key unchanged; `clearApiKey` hands it back to the env. */
export async function updateAiProvider(providerKey, patch) {
  const res = await fetch(`${API_BASE}/settings/ai/providers/${encodeURIComponent(providerKey)}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.provider;
}

export async function deleteAiProvider(providerKey) {
  const res = await fetch(`${API_BASE}/settings/ai/providers/${encodeURIComponent(providerKey)}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Returns { ok, model, latencyMs, sample } or { ok: false, failureKind, error }. */
export async function testAiProvider(providerKey, { apiKey, adapter, baseUrl, model }) {
  const res = await fetch(`${API_BASE}/settings/ai/providers/${encodeURIComponent(providerKey)}/test`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify({ apiKey, adapter, baseUrl, model }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Put a cooled provider back in rotation by hand. */
export async function clearAiProviderCooldown(providerKey) {
  const res = await fetch(
    `${API_BASE}/settings/ai/providers/${encodeURIComponent(providerKey)}/clear-cooldown`,
    { method: 'POST', headers: getHeaders() }
  );
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.provider;
}

export async function updateAiCapability(capabilityKey, patch) {
  const res = await fetch(
    `${API_BASE}/settings/ai/capabilities/${encodeURIComponent(capabilityKey)}`,
    { method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}) }
  );
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.capability;
}
