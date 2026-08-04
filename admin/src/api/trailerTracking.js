/**
 * Trailer Tracking — the operational monitoring feature.
 *
 * Separate from the Trailer Department (admin/src/api/trailerDepartment.js),
 * which is the rental and asset-management product. Do not merge them.
 */

import { API_BASE, getHeaders, getAuthHeader, handleApiError } from './http';

// ─── Trailer Tracking (Beta) ───
export async function getTrailers(params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const res = await fetch(`${API_BASE}/trailers${qs ? `?${qs}` : ''}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailer(id) {
  const res = await fetch(`${API_BASE}/trailers/${id}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerEvents(params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const res = await fetch(`${API_BASE}/trailers/events${qs ? `?${qs}` : ''}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerTimeline(id) {
  const res = await fetch(`${API_BASE}/trailers/${id}/events`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerUnidentified(includeResolved = false) {
  const res = await fetch(`${API_BASE}/trailers/unidentified?includeResolved=${includeResolved ? 'true' : 'false'}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerMapData() {
  // DEPRECATED: legacy raw-row map payload. Current code uses getTrailerStates
  // (unified TrailerStateService). Kept only for backward compatibility.
  const res = await fetch(`${API_BASE}/trailers/map`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Unified trailer states (TrailerStateService) — the single source of truth. */
export async function getTrailerStates() {
  const res = await fetch(`${API_BASE}/trailers/states`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerSettings() {
  const res = await fetch(`${API_BASE}/trailers/settings`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Planned pickup/drop-off instructions (assignments not yet confirmed done). */
export async function getTrailerPendingInstructions(status = 'pending') {
  const res = await fetch(`${API_BASE}/trailers/pending-instructions?status=${encodeURIComponent(status)}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function cancelTrailerPendingInstruction(id) {
  const res = await fetch(`${API_BASE}/trailers/pending-instructions/${id}/cancel`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateTrailerSettings(patch) {
  const res = await fetch(`${API_BASE}/trailers/settings`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function saveTrailer(trailer) {
  const res = await fetch(`${API_BASE}/trailers`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(trailer),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateTrailer(id, patch) {
  const res = await fetch(`${API_BASE}/trailers/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function importTrailerScreenshot(files) {
  const fd = new FormData();
  for (const f of files) fd.append('screenshots', f);
  const res = await fetch(`${API_BASE}/trailers/import/screenshot`, {
    method: 'POST', headers: getAuthHeader(), body: fd,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function commitTrailerImport(batchId, rows) {
  const res = await fetch(`${API_BASE}/trailers/import/${batchId}/commit`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ rows }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerImportBatches() {
  const res = await fetch(`${API_BASE}/trailers/import/batches`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function registerManualTrailerEvent(payload) {
  const res = await fetch(`${API_BASE}/trailers/events/manual`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function correctTrailerEvent(id, patch) {
  const res = await fetch(`${API_BASE}/trailers/events/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function resolveTrailerUnidentified(id) {
  const res = await fetch(`${API_BASE}/trailers/unidentified/${id}/resolve`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Accept the latest detected change for an event (confirm; keep status). */
export async function acceptTrailerEvent(id, note) {
  const res = await fetch(`${API_BASE}/trailers/events/${id}/accept`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ note: note || null }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Decline the latest detected change (kept in history; status restored). */
export async function declineTrailerEvent(id, note) {
  const res = await fetch(`${API_BASE}/trailers/events/${id}/decline`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ note: note || null }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Recompute a trailer's current status from its non-declined event history. */
export async function recomputeTrailerStatus(id) {
  const res = await fetch(`${API_BASE}/trailers/${id}/recompute-status`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Run the admin-triggered, bounded geocode backfill. */
export async function runTrailerGeocodeBackfill(limit) {
  const res = await fetch(`${API_BASE}/trailers/geocode-backfill`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ limit: limit || undefined }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
