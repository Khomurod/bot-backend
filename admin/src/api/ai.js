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

/** The providers Wenze can configure by itself: { catalog: [{ key, label, isFree, needsBaseUrl, configured, … }] }. */
export async function getAiCatalog() {
  const res = await fetch(`${API_BASE}/settings/ai/catalog`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.catalog;
}

/**
 * Pick a provider, paste the key, Connect. Answers 200 with `ok: false` and a
 * plain-language `message` when the provider or the key is the problem — the
 * request succeeded; what failed is the thing being connected.
 */
export async function connectAiProvider({ catalogKey, apiKey, label, baseUrl, adapter }) {
  const res = await fetch(`${API_BASE}/settings/ai/providers/connect`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify({ catalogKey, apiKey, label, baseUrl, adapter }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Re-read the provider's model listing now; returns { ok, retired, added, chain, changed, … }. */
export async function refreshAiProviderModels(providerKey) {
  const res = await fetch(
    `${API_BASE}/settings/ai/providers/${encodeURIComponent(providerKey)}/refresh-models`,
    { method: 'POST', headers: getHeaders() }
  );
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

// ─── the terms watcher ───────────────────────────────────────────────────────

/** Returns { settings, sources, findings, alerts }. */
export async function getAiPolicyWatcher() {
  const res = await fetch(`${API_BASE}/settings/ai/policy`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * The Telegram destination is validated server-side before it is stored; a
 * rejection comes back as a 400 carrying `suggestion` with the corrected id.
 */
export async function updateAiPolicyWatcher(patch) {
  const res = await fetch(`${API_BASE}/settings/ai/policy`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

export async function addAiPolicySource({ providerKey, url, kind }) {
  const res = await fetch(`${API_BASE}/settings/ai/policy/sources`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ providerKey, url, kind }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.source;
}

export async function deleteAiPolicySource(id) {
  const res = await fetch(`${API_BASE}/settings/ai/policy/sources/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function acknowledgeAiPolicyFinding(id) {
  const res = await fetch(`${API_BASE}/settings/ai/policy/findings/${id}/acknowledge`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.finding;
}

export async function runAiPolicyCheck() {
  const res = await fetch(`${API_BASE}/settings/ai/policy/run`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.summary;
}
