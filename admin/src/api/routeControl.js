/**
 * Route Control: assignments, their screenshots, tracking, and completion.
 *
 * The screenshot helpers stay next to the assignment calls they belong to.
 */

import { API_BASE, getHeaders, getAuthHeader, handleApiError } from './http';

// ─── Route Control ───

export async function getRouteAssignments(status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await fetch(`${API_BASE}/route-control${qs}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  // { assignments, completionRadiusMiles } — radius rides along for diagnostics.
  return res.json();
}

export async function getRouteAssignment(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Test-parse a Google Maps link without storing anything. Throws on unparseable. */
export async function parseRouteLink(url) {
  const res = await fetch(`${API_BASE}/route-control/parse`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ url }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.parsed;
}

export async function assignRoute(payload) {
  const res = await fetch(`${API_BASE}/route-control`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * Assign a route WITH a screenshot: multipart with the JSON payload in a
 * `payload` field. No Content-Type header — the browser sets the boundary.
 */
export async function assignRouteWithScreenshot(payload, screenshotFile) {
  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload || {}));
  formData.append('screenshot', screenshotFile);
  const res = await fetch(`${API_BASE}/route-control`, {
    method: 'POST', headers: getAuthHeader(), body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Upload/replace the route screenshot on an existing assignment. */
export async function uploadRouteScreenshot(id, screenshotFile) {
  const formData = new FormData();
  formData.append('screenshot', screenshotFile);
  const res = await fetch(`${API_BASE}/route-control/${id}/screenshot`, {
    method: 'POST', headers: getAuthHeader(), body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Fetch the stored screenshot (auth-gated) as a Blob for an in-app preview. */
export async function getRouteScreenshotBlob(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}/screenshot`, { headers: getAuthHeader() });
  if (!res.ok) { await handleApiError(res); }
  return res.blob();
}

/** Remove the stored route screenshot (the assignment itself is untouched). */
export async function deleteRouteScreenshot(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}/screenshot`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Destination-completion check now — one route, or all active when id is null. */
export async function runRouteCompletionCheck(id) {
  const url = id != null
    ? `${API_BASE}/route-control/${id}/run-completion-check`
    : `${API_BASE}/route-control/run-completion-check`;
  const res = await fetch(url, { method: 'POST', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Manually start tracking for a pending route. */
export async function startRouteTracking(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}/start-tracking`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function computeRouteGeometry(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}/compute`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Send a NEW route message to the driver's Telegram group (the only path that
 *  posts a new message — used for the first send or an intentional re-send). */
export async function sendRouteDriverMessage(id, { message } = {}) {
  const res = await fetch(`${API_BASE}/route-control/${id}/send-driver-message`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify(message ? { message } : {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Update (edit) the ALREADY-SENT route message(s) in place — never posts a new
 *  message. Returns the structured in-place-edit status. */
export async function updateRouteDriverMessage(id, { message } = {}) {
  const res = await fetch(`${API_BASE}/route-control/${id}/update-driver-message`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify(message ? { message } : {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function cancelRoute(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}/cancel`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function completeRoute(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}/complete`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

