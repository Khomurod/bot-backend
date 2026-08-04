/**
 * Dispatch Center: rate-confirmation parsing, sending, and testing groups.
 */

import { API_BASE, getHeaders, getAuthHeader, handleApiError } from './http';

export async function parseDispatchRateCon(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/dispatch/parse-rate-con`, {
    method: 'POST',
    headers: getAuthHeader(),
    body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendDispatchToTelegram(formData) {
  const res = await fetch(`${API_BASE}/dispatch/send-to-telegram`, {
    method: 'POST',
    headers: getAuthHeader(),
    body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

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

export async function getDispatchTestingGroupDetails(groupId) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups/${groupId}/details`, {
    headers: getAuthHeader(),
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

