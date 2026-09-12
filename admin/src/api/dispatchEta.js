/**
 * Automatic ETA updates: which driver groups get them, and how often.
 *
 * The paths still start `/dispatch` and that is deliberate — they are the live
 * ETA-schedule endpoints and renaming them would have made a UI removal into an
 * API break. The Dispatch Center's own three calls (parse a rate confirmation,
 * list groups to send to, send to Telegram) went with the page; see
 * `docs/architecture/retired-dispatch-center.md`.
 */

import { API_BASE, getHeaders, getAuthHeader, handleApiError } from './http';

export async function getDispatchTestingGroups() {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function saveDispatchEtaGlobalIntervals(payload) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/global-intervals`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateDispatchTestingGroup(groupId, payload) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups/${groupId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateAllDispatchTestingGroups(payload) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups/toggle-all`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

