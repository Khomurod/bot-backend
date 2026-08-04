/**
 * Driver home-time tracking: statuses, trips, screenshot imports, requests.
 */

import { API_BASE, getHeaders, getAuthHeader, handleApiError } from './http';

// ─── Driver Home-Time Tracking ───

export async function getHomeTimeOverview() {
  const res = await fetch(`${API_BASE}/home-time/overview`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateHomeTimeSettings(patch) {
  const res = await fetch(`${API_BASE}/home-time/settings`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateHomeTimeStatus(groupId, patch) {
  const res = await fetch(`${API_BASE}/home-time/status/${groupId}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateHomeTimeStatusSince(groupId, stateSince) {
  return updateHomeTimeStatus(groupId, { state_since: stateSince });
}

export async function updateHomeTimeTrip(id, payload) {
  const res = await fetch(`${API_BASE}/home-time/history/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteHomeTimeTrip(id) {
  const res = await fetch(`${API_BASE}/home-time/history/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function importHomeTimeScreenshots(files) {
  const fd = new FormData();
  for (const f of files) fd.append('screenshots', f);
  const res = await fetch(`${API_BASE}/home-time/import-screenshots`, {
    method: 'POST', headers: getAuthHeader(), body: fd,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function applyHomeTimeImport(rows) {
  const res = await fetch(`${API_BASE}/home-time/import-screenshots/apply`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ rows }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getHomeTimeRequests() {
  const res = await fetch(`${API_BASE}/home-time/requests`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createHomeTimeRequest(payload) {
  const res = await fetch(`${API_BASE}/home-time/requests`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateHomeTimeRequest(id, patch) {
  const res = await fetch(`${API_BASE}/home-time/requests/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getHomeTimeEfficiency(range = 'all') {
  const res = await fetch(`${API_BASE}/home-time/efficiency?range=${encodeURIComponent(range)}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

